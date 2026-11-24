import { after } from 'next/server'
import { z } from 'zod'
import { addNote, createProject, ProjectConflictError } from '@/lib/agent/projects'
import { NOTE_MAX } from '@/lib/agent/projectModel'
import { ackAlerts } from '@/lib/alertsStore'
import { addActivity, getDeal, getStages, setStage } from '@/lib/crm/service'
import { planStageMove, requiresApproval } from '@/lib/crm/stages'
import { exportCandidates } from '@/lib/influencers/store'
import { reactorRow } from '@/lib/leads/lists/sources'
import { appendItems, createList } from '@/lib/leads/lists/store'
import { MapsError } from '@/lib/maps/errors'
import { buildMapsSheet } from '@/lib/maps/sheet'
import { parseDue } from '@/lib/tasks/model'
import { insertTask } from '@/lib/tasks/store'
import { pushTask } from '@/lib/tasks/sync'
import { sb } from '../db'
import { idempotencyKey } from '../idempotency'
import { McpUserError } from '../sanitize'
import { defineTool, INTERNAL_APPEND, INTERNAL_WRITE, type ToolDef } from '../tool'

/**
 * Group B: internal writes. Nothing leaves Lume and nothing costs money.
 * Every row written here is marked as coming from MCP, so the owner can see
 * and undo it (docs/lume/LUME-MCP.md, "Undo"):
 *   alerts       acked_via = 'mcp'
 *   CRM          crm_activities.source = 'mcp' (stage_changed / note)
 *   tasks        created_by = 'mcp'
 *   lead lists   created_by = 'mcp', rows source = 'mcp'
 *   drafts       notes in the "MCP drafts" Agent project
 * Each call also leaves one mcp.tool_call event with refs to what it wrote.
 */

export const MCP_DRAFTS_PROJECT = 'MCP drafts'
const uuid = z.uuid()

export const ackAlert = defineTool({
  name: 'lume_ack_alert',
  title: 'Acknowledge alerts',
  description:
    'Marks up to 50 unacked Lume alerts as acknowledged (recorded as acked via MCP). Side effect: they leave the unacked list in the dashboard and overview. Already-acked or unknown ids are skipped. No outreach, no cost. Safe to repeat.',
  cls: 'write',
  input: z.object({
    alert_ids: z.array(uuid).min(1).max(50).describe('Alert ids from lume_list_alerts or lume_get_overview.'),
    idempotency_key: idempotencyKey,
  }),
  annotations: INTERNAL_WRITE,
  run: async ({ alert_ids }) => {
    const ids = [...new Set(alert_ids.map((s) => s.toLowerCase()))]
    const acked = await ackAlerts({ ids }, null, 'mcp')
    return {
      data: { acked: acked.length, acked_ids: acked, skipped: ids.length - acked.length },
      refs: { alert_ids: acked.join(',').slice(0, 400) },
    }
  },
})

export const moveDealStage = defineTool({
  name: 'lume_move_deal_stage',
  title: 'Move a CRM deal to another stage',
  description:
    "Moves one CRM deal to another stage of its campaign's pipeline and logs a stage_changed activity marked source 'mcp' (shows on the deal's timeline). Won and Lost are refused here: closing a deal needs the owner's approval in the dashboard. Moving to the current stage does nothing. No outreach, no cost.",
  cls: 'write',
  input: z.object({
    deal_id: uuid.describe('From lume_list_deals.'),
    stage: z.string().trim().min(1).max(60).describe('Target stage name, exactly as the pipeline names it.'),
    reason: z.string().trim().max(300).optional().describe('Optional one-line why, kept on the activity.'),
    idempotency_key: idempotencyKey,
  }),
  annotations: INTERNAL_WRITE,
  run: async ({ deal_id, stage, reason }) => {
    const deal = await getDeal(deal_id.toLowerCase())
    if (!deal) throw new McpUserError('No deal with that id. Use lume_list_deals.')
    if (requiresApproval(stage)) throw new McpUserError(`Moving a deal to ${stage} closes it and needs the owner's approval in the Lume dashboard; MCP cannot do it.`)
    const stages = await getStages(deal.campaign_id)
    const plan = planStageMove(deal.stage, stage, reason, stages)
    if (plan.type === 'error') throw new McpUserError(`Unknown stage "${stage}". Valid stages: ${stages.map((s) => s.name).join(', ')}.`)
    if (plan.type === 'noop') return { data: { deal_id: deal.id, changed: false, stage: deal.stage } }
    if (plan.type !== 'direct') throw new McpUserError('That move needs the owner’s approval in the Lume dashboard.')
    const from = await setStage(deal.id, plan.to, 'mcp', reason ?? null, { via: 'mcp' })
    if (from === null) throw new McpUserError('The deal was removed before the move. Use lume_list_deals.')
    return { data: { deal_id: deal.id, changed: true, from, to: plan.to }, refs: { deal_id: deal.id, from, to: plan.to } }
  },
})

export const addDealNote = defineTool({
  name: 'lume_add_deal_note',
  title: 'Add a note to a CRM deal',
  description:
    "Adds a note activity to one CRM deal's timeline, marked source 'mcp'. Does not change the deal's stage or its free-text notes field. No outreach, no cost.",
  cls: 'write',
  input: z.object({
    deal_id: uuid.describe('From lume_list_deals.'),
    text: z.string().trim().min(1).max(4000).describe('The note, plain text.'),
    idempotency_key: idempotencyKey,
  }),
  annotations: INTERNAL_APPEND,
  run: async ({ deal_id, text }) => {
    const deal = await getDeal(deal_id.toLowerCase())
    if (!deal) throw new McpUserError('No deal with that id. Use lume_list_deals.')
    const act = await addActivity({ deal_id: deal.id, kind: 'note', source: 'mcp', payload: { text, via: 'mcp' } })
    if (!act) throw new McpUserError('The note was not saved. Try again.')
    return { data: { deal_id: deal.id, activity_id: act.id }, refs: { deal_id: deal.id, activity_id: act.id } }
  },
})

export const createTask = defineTool({
  name: 'lume_create_task',
  title: 'Create a Lume task',
  description:
    "Creates a reminder task in Lume's calendar (created_by 'mcp', shown as \"by Claude (MCP)\"). It syncs to Linear the same way dashboard tasks do. A task created here never carries an action, so it cannot run anything when due. No outreach, no cost.",
  cls: 'write',
  input: z.object({
    title: z.string().trim().min(1).max(200),
    notes: z.string().trim().max(4000).optional(),
    due: z.string().trim().min(10).max(40).describe('YYYY-MM-DD (all day) or an ISO datetime; no offset = Pacific time.'),
    idempotency_key: idempotencyKey,
  }),
  annotations: INTERNAL_APPEND,
  run: async ({ title, notes, due }) => {
    const when = parseDue(due)
    if (!when) throw new McpUserError('due must be YYYY-MM-DD or an ISO datetime.')
    const task = await insertTask({
      title,
      notes: notes?.trim() || null,
      due_at: when.due_at,
      all_day: when.all_day,
      action_kind: null,
      action_payload: null,
      created_by: 'mcp',
      conversation_id: null,
    })
    // Same as POST /api/tasks: Linear sync runs after the response; it never throws.
    after(() => pushTask(task).then(() => undefined))
    return { data: { task_id: task.id, due_at: task.due_at, all_day: task.all_day }, refs: { task_id: task.id } }
  },
})

export const createReviewSet = defineTool({
  name: 'lume_create_review_set',
  title: 'Create a lead list from influencer reactors',
  description:
    "Creates a new lead list (Leads → Lists, marked created by MCP) from verified decision makers who reacted to tracked influencers' posts, filtered by door count and influencer. It copies name, title, company, website, LinkedIn, location, doors and influencers; reactors have no emails. It does not mark reactors exported and sends nothing; use the dashboard to validate or push the list later. Refuses when nothing matches.",
  cls: 'write',
  input: z.object({
    name: z.string().trim().min(1).max(200).describe('List name.'),
    notes: z.string().trim().max(4000).optional(),
    min_doors: z.number().int().min(0).max(1_000_000).optional().describe('Only companies with at least this many doors (units managed).'),
    influencer_slugs: z.array(z.string().trim().min(1).max(80)).max(20).optional().describe('Only reactors to these influencers (slugs from lume_list_influencers).'),
    only_not_exported: z.boolean().optional().describe('Skip reactors already exported to a CSV (default true).'),
    max_rows: z.number().int().min(1).max(2000).optional().describe('Cap on rows (default 500, max 2000). Most-influencers and most-doors first.'),
    idempotency_key: idempotencyKey,
  }),
  annotations: INTERNAL_APPEND,
  run: async ({ name, notes, min_doors, influencer_slugs, only_not_exported, max_rows }) => {
    const reactors = await exportCandidates(
      { verified_only: true, min_door_count: min_doors, only_new: only_not_exported ?? true, influencer_slugs },
      max_rows ?? 500,
    )
    if (reactors.length === 0) throw new McpUserError('No verified reactors match those filters; nothing was created.')
    const list = await createList({ name, notes: notes ?? null, created_by: 'mcp' })
    const res = await appendItems(list.id, reactors.map((r) => reactorRow(r, 'mcp')))
    return {
      data: { list_id: list.id, matched: reactors.length, added: res.added, duplicates: res.duplicates, item_count: res.item_count },
      refs: { list_id: list.id },
    }
  },
})

export const buildMapsSheetTool = defineTool({
  name: 'lume_build_maps_sheet',
  title: 'Build the Google Maps sheet from a finished scrape',
  description:
    'Turns a finished GTM-12 Google Maps run (the scrape the owner requests and confirms on the Lume Import screen; MCP cannot start one) into a new lead list (Leads → Lists, marked created by MCP): one row per company with Company, Phone, City, State, Zip, Website, Rating, Reviews, Maps Category, Maps PM, Branches, Address and the Google Maps link. ' +
    'Drops permanently closed places, places without a website of their own (none, or only a social / directory page) and duplicate listings of the same domain, and reports each count. ' +
    'Reads the Apify dataset only (free). Sends nothing, pushes nothing to Frank\'s portal, runs no paid step; LinkedIn and the PM-vs-vendor verdict come later from the crawl worker. Each call creates a new list.',
  cls: 'write',
  input: z
    .object({
      run_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional().describe('Apify run id (the run_actor action result, or lume_get_action).'),
      dataset_id: z.string().regex(/^[A-Za-z0-9]{8,40}$/).optional(),
      name: z.string().trim().min(1).max(200).optional().describe('List name (default "LA PM · Google Maps · <date>").'),
      notes: z.string().trim().max(4000).optional(),
      idempotency_key: idempotencyKey,
    })
    .refine((v) => !!v.run_id !== !!v.dataset_id, 'Pass run_id or dataset_id.'),
  annotations: INTERNAL_APPEND,
  run: async ({ run_id, dataset_id, name, notes }) => {
    try {
      const out = await buildMapsSheet({ run_id, dataset_id }, { name, notes, by: 'mcp' })
      return {
        data: { list_id: out.list_id, name: out.list_name, run_status: out.run_status, truncated: out.truncated, summary: out.summary, clean: out.clean, added: out.append.added, duplicates: out.append.duplicates, item_count: out.append.item_count },
        refs: { list_id: out.list_id },
      }
    } catch (err) {
      if (err instanceof MapsError) throw new McpUserError(`Lume could not build the sheet (${err.code}). Nothing was created.`)
      throw err
    }
  },
})

/** The live "MCP drafts" Agent project, created on first use. */
export async function draftsProjectId(): Promise<string> {
  const find = async () => {
    const res = await sb().from('agent_projects').select('id').ilike('name', MCP_DRAFTS_PROJECT).is('archived_at', null).limit(1).maybeSingle()
    if (res.error) throw res.error
    return (res.data as { id: string } | null)?.id ?? null
  }
  const found = await find()
  if (found) return found
  try {
    return (
      await createProject({
        name: MCP_DRAFTS_PROJECT,
        instructions: 'Drafts written by Claude through the Lume MCP server. Read-only context: nothing here runs on its own.',
      })
    ).id
  } catch (err) {
    // A concurrent call created it first.
    if (err instanceof ProjectConflictError) {
      const again = await find()
      if (again) return again
    }
    throw err
  }
}

function draftTool(name: 'lume_draft_icp_brief' | 'lume_draft_outbound_plan', label: string, what: string): ToolDef {
  return defineTool({
    name,
    title: `Draft ${what}`,
    description: `Saves ${what} as a note in the "${MCP_DRAFTS_PROJECT}" project in Lume's Agent tab, titled "${label} · <title>". It is a draft only: it executes nothing, sends nothing and costs nothing. Each call adds a new note.`,
    cls: 'write',
    input: z.object({
      title: z.string().trim().min(1).max(100),
      content: z.string().trim().min(1).max(NOTE_MAX).describe('Markdown.'),
      idempotency_key: idempotencyKey,
    }),
    annotations: INTERNAL_APPEND,
    run: async ({ title, content }) => {
      const projectId = await draftsProjectId()
      const note = await addNote(projectId, `${label} · ${title}`, content)
      return { data: { project_id: projectId, note_id: note.id, name: note.name }, refs: { project_id: projectId, note_id: note.id } }
    },
  }) as unknown as ToolDef
}

export const draftIcpBrief = draftTool('lume_draft_icp_brief', 'ICP brief', 'an ICP brief')
export const draftOutboundPlan = draftTool('lume_draft_outbound_plan', 'Outbound plan', 'an outbound plan')

export const internalTools: ToolDef[] = [
  ackAlert,
  moveDealStage,
  addDealNote,
  createTask,
  createReviewSet,
  buildMapsSheetTool,
  draftIcpBrief,
  draftOutboundPlan,
] as unknown as ToolDef[]
