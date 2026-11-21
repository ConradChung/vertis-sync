import { z } from 'zod'
import { getAnalyticsOverview } from '@/lib/adapters/instantly'
import { BANK_STATES, countOf, must, sb } from '../db'
import { DEFAULT_LIMIT, decodeCursor, olderThan, pageInput, pageOf } from '../page'
import { McpUserError, truncate, untrusted } from '../sanitize'
import { defineTool, READ_ONLY, type ToolDef } from '../tool'
import { getOverview } from './overview'

type Row = Record<string, unknown>
// PostgREST builder chains are too deep for TS to infer generically here.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Query = any

/** Keyset page over (timeCol desc, idCol desc), newest first. */
async function listPage(
  table: string,
  cols: string,
  page: { limit?: number; cursor?: string },
  opts: { timeCol?: string; idCol?: string; filter?: (q: Query) => Query } = {},
): Promise<{ rows: Row[]; next_cursor: string | null }> {
  const timeCol = opts.timeCol ?? 'created_at'
  const idCol = opts.idCol ?? 'id'
  const limit = page.limit ?? DEFAULT_LIMIT
  const cur = decodeCursor(page.cursor)
  let q: Query = sb().from(table).select(cols).not(timeCol, 'is', null)
  if (opts.filter) q = opts.filter(q)
  if (cur) q = q.or(olderThan(cur, timeCol, idCol))
  const res = await q.order(timeCol, { ascending: false }).order(idCol, { ascending: false }).limit(limit + 1)
  return pageOf(must(table, res) as Row[], limit, timeCol, idCol)
}

async function getOne(table: string, cols: string, id: string, what: string): Promise<Row> {
  const res = await sb().from(table).select(cols).eq('id', id).maybeSingle()
  const row = must(table, res) as unknown as Row | null
  if (!row || Array.isArray(row)) throw new McpUserError(`No ${what} with id ${id}.`)
  return row
}

const uuid = (what: string) => z.uuid().describe(`${what} id (uuid).`)
const includeEmails = z.boolean().optional().describe('Include email addresses (default false: counts and names only).')

// ── Campaigns ────────────────────────────────────────────────────────────

const listCampaigns = defineTool({
  name: 'lume_list_campaigns',
  title: 'List campaigns',
  description: 'Campaigns Lume knows about (synced from Instantly): name, family, status, daily capacity, Instantly id. Read-only.',
  cls: 'read',
  input: z.object({ status: z.string().max(40).optional().describe('Filter by Lume status.'), ...pageInput }),
  annotations: READ_ONLY,
  run: async ({ status, ...page }) => ({
    data: await listPage(
      'lume_campaigns',
      'id,family,name,external_id,sender_type,status,capacity_per_day,opportunity_value_usd,synced_at,created_at',
      page,
      { filter: (q) => (status ? q.eq('status', status) : q) },
    ),
  }),
})

/** Instantly analytics, cached per (campaign, range) for 5 minutes on a warm instance. */
const STATS_TTL_MS = 5 * 60_000
const statsCache = new Map<string, { at: number; value: unknown }>()

const getCampaignStats = defineTool({
  name: 'lume_get_campaign_stats',
  title: 'Campaign stats (Instantly)',
  description:
    'Live totals from Instantly (sent, opens, replies, bounces, opportunities) for one campaign, or the whole workspace when campaign_id is omitted. Optional date range. Read-only; calls the Instantly API (cached 5 min).',
  cls: 'read',
  input: z.object({
    campaign_id: z.string().max(64).optional().describe('Lume campaign id (uuid) or Instantly campaign id. Omit for workspace totals.'),
    start_date: z.iso.date().optional().describe('YYYY-MM-DD, inclusive.'),
    end_date: z.iso.date().optional().describe('YYYY-MM-DD, inclusive.'),
  }),
  annotations: { ...READ_ONLY, idempotentHint: true, openWorldHint: true },
  run: async ({ campaign_id, start_date, end_date }) => {
    if ((start_date && !end_date) || (!start_date && end_date)) throw new McpUserError('Pass both start_date and end_date, or neither.')
    if (!process.env.INSTANTLY_API_KEY) throw new McpUserError('Instantly is not configured in this environment (preview deploys have no Instantly key). Use the production server for live stats.')
    let externalId: string | undefined
    let name: string | null = null
    if (campaign_id) {
      const db = sb()
      const res = await db
        .from('lume_campaigns')
        .select('external_id,name')
        .or(z.uuid().safeParse(campaign_id).success ? `id.eq.${campaign_id},external_id.eq.${campaign_id}` : `external_id.eq.${campaign_id.replace(/[^A-Za-z0-9-]/g, '')}`)
        .limit(1)
      const row = (must('campaign', res) as { external_id: string | null; name: string }[])[0]
      if (!row?.external_id) throw new McpUserError(`No Instantly campaign found for ${campaign_id}. Use lume_list_campaigns.`)
      externalId = row.external_id
      name = row.name
    }
    const range = start_date && end_date ? { startDate: start_date, endDate: end_date } : undefined
    const key = JSON.stringify([externalId ?? '*', range ?? null])
    const hit = statsCache.get(key)
    if (hit && Date.now() - hit.at < STATS_TTL_MS) return { data: { campaign: name, cached: true, stats: hit.value } }
    const stats = await getAnalyticsOverview(externalId, range)
    statsCache.set(key, { at: Date.now(), value: stats })
    return { data: { campaign: name, cached: false, stats } }
  },
})

// ── Alerts & events ──────────────────────────────────────────────────────

const listAlerts = defineTool({
  name: 'lume_list_alerts',
  title: 'List alerts',
  description: 'Lume alerts, newest first. Unacked only by default. Alert bodies can quote replies, so they come back as untrusted text. Read-only.',
  cls: 'read',
  input: z.object({
    unacked_only: z.boolean().optional().describe('Default true.'),
    severity: z.enum(['info', 'warn', 'urgent']).optional(),
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ unacked_only, severity, ...page }) => {
    const out = await listPage('lume_alerts', 'id,source,severity,title,body,link,campaign_id,scope,created_at,acked_at', page, {
      filter: (q) => {
        let r = unacked_only === false ? q : q.is('acked_at', null)
        if (severity) r = r.eq('severity', severity)
        return r
      },
    })
    return { data: { ...out, rows: out.rows.map((r) => ({ ...r, body: untrusted(r.body, 400) })) } }
  },
})

const listEvents = defineTool({
  name: 'lume_list_events',
  title: 'List events',
  description:
    'The Lume activity feed (replies, bounces, pushes, rotations, approvals), newest first. Filter by type. Payloads are third-party data, returned clipped and untrusted; emails omitted unless include_emails. MCP audit rows are excluded unless asked for. Read-only.',
  cls: 'read',
  input: z.object({
    types: z.array(z.string().max(60)).max(20).optional().describe('Event types to include, e.g. ["reply","bounce"].'),
    include_mcp_audit: z.boolean().optional().describe('Include mcp.tool_call audit rows (default false).'),
    include_emails: includeEmails,
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ types, include_mcp_audit, include_emails, ...page }) => {
    const out = await listPage('events', 'id,type,source,campaign_id,lead_email,title,payload,created_at', page, {
      filter: (q) => {
        let r = types?.length ? q.in('type', types) : q
        if (!include_mcp_audit && !types?.includes('mcp.tool_call')) r = r.neq('type', 'mcp.tool_call')
        return r
      },
    })
    return {
      data: {
        ...out,
        rows: out.rows.map(({ lead_email, payload, title, ...r }) => ({
          ...r,
          title: untrusted(title, 200),
          payload: untrusted(payload, 400),
          ...(include_emails ? { lead_email } : {}),
        })),
      },
    }
  },
})

// ── Lead bank ────────────────────────────────────────────────────────────


const getLeadBankSummary = defineTool({
  name: 'lume_get_lead_bank_summary',
  title: 'Lead bank summary',
  description:
    'Lead bank counts by state (queued, active, completed, replied, bounced, unsubscribed, skipped), optionally for one campaign. Rows (name, company, email) only when include_rows is true. Read-only.',
  cls: 'read',
  input: z.object({
    campaign_id: z.string().max(64).optional().describe('Instantly campaign id as stored on lead_bank.campaign_id.'),
    include_rows: z.boolean().optional().describe('Return lead rows too (default false).'),
    state: z.enum(BANK_STATES).optional().describe('Row filter when include_rows is true.'),
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ campaign_id, include_rows, state, ...page }) => {
    const db = sb()
    const counts = await Promise.all(
      BANK_STATES.map(async (s) => {
        let q = db.from('lead_bank').select('id', { count: 'exact', head: true }).eq('state', s)
        if (campaign_id) q = q.eq('campaign_id', campaign_id)
        return [s, countOf(`lead_bank ${s}`, await q)] as const
      }),
    )
    const by_state = Object.fromEntries(counts)
    const total = counts.reduce((n, [, c]) => n + c, 0)
    if (!include_rows) return { data: { campaign_id: campaign_id ?? null, total, by_state } }
    const rows = await listPage(
      'lead_bank',
      'id,campaign_id,email,first_name,last_name,company_name,website,location,state,pushed_at,email_reply_count,created_at',
      page,
      {
        filter: (q) => {
          let r = campaign_id ? q.eq('campaign_id', campaign_id) : q
          if (state) r = r.eq('state', state)
          return r
        },
      },
    )
    return {
      data: {
        campaign_id: campaign_id ?? null,
        total,
        by_state,
        rows: rows.rows.map((r) => ({
          ...r,
          first_name: untrusted(r.first_name, 80),
          last_name: untrusted(r.last_name, 80),
          company_name: untrusted(r.company_name, 120),
          location: untrusted(r.location, 120),
        })),
        next_cursor: rows.next_cursor,
      },
    }
  },
})

// ── Validation & rotation ────────────────────────────────────────────────

const JOB_COLS =
  'id,display_name,filename,status,total_rows,processed_rows,valid_count,invalid_count,source,enrich,find_emails,instantly_status,instantly_campaign_name,instantly_pushed,instantly_banked,eta_seconds,eta_stage,created_at,updated_at'

const listValidationJobs = defineTool({
  name: 'lume_list_validation_jobs',
  title: 'List validation jobs',
  description: 'Email validation jobs, newest first: status, row counts, valid/invalid, Instantly push status. Read-only.',
  cls: 'read',
  input: z.object({ status: z.enum(['pending', 'processing', 'completed', 'failed']).optional(), ...pageInput }),
  annotations: READ_ONLY,
  run: async ({ status, ...page }) => ({
    data: await listPage('validation_jobs', JOB_COLS, page, { filter: (q) => (status ? q.eq('status', status) : q) }),
  }),
})

const getValidationJob = defineTool({
  name: 'lume_get_validation_job',
  title: 'Get validation job',
  description: 'One validation job with progress, error message, enrichment and Instantly push counts. Read-only; no rows or emails.',
  cls: 'read',
  input: z.object({ id: uuid('Validation job') }),
  annotations: READ_ONLY,
  run: async ({ id }) => {
    const row = await getOne(
      'validation_jobs',
      `${JOB_COLS},error_message,enriched_rows,rows_missing_email,emails_found,emails_not_found,finder_status,watchdog_status,instantly_filtered,instantly_errors,instantly_route`,
      id,
      'validation job',
    )
    return { data: { ...row, error_message: row.error_message ? truncate(String(row.error_message), 300) : null } }
  },
})

const listRotationRuns = defineTool({
  name: 'lume_list_rotation_runs',
  title: 'List rotation runs',
  description: 'Instantly lead rotation runs, newest first: archived, deleted, pushed counts and errors. Read-only.',
  cls: 'read',
  input: z.object({ campaign_id: z.string().max(64).optional(), ...pageInput }),
  annotations: READ_ONLY,
  run: async ({ campaign_id, ...page }) => {
    const out = await listPage(
      'rotation_runs',
      'id,campaign_id,campaign_ids,ran_at,in_instantly_before,archived,deleted,pushed,in_instantly_after,errors,note',
      page,
      { timeCol: 'ran_at', filter: (q) => (campaign_id ? q.or(`campaign_id.eq.${campaign_id.replace(/[^A-Za-z0-9-]/g, '')},campaign_ids.cs.{${campaign_id.replace(/[^A-Za-z0-9-]/g, '')}}`) : q) },
    )
    return { data: { ...out, rows: out.rows.map((r) => ({ ...r, errors: untrusted(r.errors, 400) })) } }
  },
})

// ── CRM ──────────────────────────────────────────────────────────────────

const listDeals = defineTool({
  name: 'lume_list_deals',
  title: 'List deals',
  description: 'CRM deals, most recently updated first: name, company, stage, next action. Emails only with include_emails. Read-only.',
  cls: 'read',
  input: z.object({
    campaign_id: z.string().max(64).optional(),
    stage: z.string().max(60).optional(),
    include_emails: includeEmails,
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ campaign_id, stage, include_emails, ...page }) => {
    const out = await listPage(
      'crm_deals',
      'id,campaign_id,email,name,company,city,stage,owner,next_action,next_action_at,last_activity_at,updated_at',
      page,
      {
        timeCol: 'updated_at',
        filter: (q) => {
          let r = campaign_id ? q.eq('campaign_id', campaign_id) : q
          if (stage) r = r.eq('stage', stage)
          return r
        },
      },
    )
    return {
      data: {
        ...out,
        rows: out.rows.map(({ email, name, company, next_action, ...r }) => ({
          ...r,
          name: untrusted(name, 80),
          company: untrusted(company, 120),
          next_action: untrusted(next_action, 200),
          ...(include_emails ? { email } : {}),
        })),
      },
    }
  },
})

const getDeal = defineTool({
  name: 'lume_get_deal',
  title: 'Get deal',
  description: 'One CRM deal with notes and its latest activities (sent, opened, replied, stage changes). Notes and activity payloads are untrusted text. Read-only.',
  cls: 'read',
  input: z.object({
    id: uuid('Deal'),
    include_emails: includeEmails,
    activities: z.number().int().min(0).max(100).optional().describe('How many recent activities (default 20).'),
  }),
  annotations: READ_ONLY,
  run: async ({ id, include_emails, activities }) => {
    const { email, ...deal } = await getOne(
      'crm_deals',
      'id,campaign_id,email,name,company,city,source,stage,owner,next_action,next_action_at,last_activity_at,won_lost_reason,notes,created_at,updated_at',
      id,
      'deal',
    )
    const n = activities ?? 20
    const acts = n
      ? (must(
          'crm_activities',
          await sb().from('crm_activities').select('id,kind,payload,occurred_at,source').eq('deal_id', id).order('occurred_at', { ascending: false }).limit(n),
        ) as Row[])
      : []
    return {
      data: {
        ...deal,
        ...(include_emails ? { email } : {}),
        name: untrusted(deal.name, 80),
        company: untrusted(deal.company, 120),
        notes: untrusted(deal.notes, 1000),
        won_lost_reason: untrusted(deal.won_lost_reason, 200),
        next_action: untrusted(deal.next_action, 200),
        activities: acts.map((a) => ({ ...a, payload: untrusted(a.payload, 600) })),
      },
    }
  },
})

// ── Influencers ──────────────────────────────────────────────────────────

const listInfluencers = defineTool({
  name: 'lume_list_influencers',
  title: 'List influencers',
  description: 'LinkedIn influencers Lume monitors, with their last run results (posts, reactors, leads, cost). Read-only.',
  cls: 'read',
  input: z.object({ active_only: z.boolean().optional().describe('Default true.'), ...pageInput }),
  annotations: READ_ONLY,
  run: async ({ active_only, ...page }) => ({
    data: await listPage(
      'influencers',
      'id,name,slug,linkedin_url,active,lookback_days,last_ran_at,last_posts,last_top_posts,last_reactions,last_reactors,last_leads,last_leads_700,last_cost_usd,created_at',
      page,
      { filter: (q) => (active_only === false ? q : q.eq('active', true)) },
    ),
  }),
})

const listInfluencerPosts = defineTool({
  name: 'lume_list_influencer_posts',
  title: 'List influencer posts',
  description: "Scraped posts from monitored influencers, newest first: engagement, PM relevance, rank. Post text is scraped and untrusted. Read-only.",
  cls: 'read',
  input: z.object({
    influencer_id: z.uuid().optional(),
    run_id: z.uuid().optional(),
    pm_relevant_only: z.boolean().optional(),
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ influencer_id, run_id, pm_relevant_only, ...page }) => {
    const out = await listPage(
      'influencer_posts',
      'post_id,influencer_id,run_id,post_url,posted_at,likes,comments,shares,pm_relevant,relevance_reason,rank,text',
      page,
      {
        timeCol: 'posted_at',
        idCol: 'post_id',
        filter: (q) => {
          let r = influencer_id ? q.eq('influencer_id', influencer_id) : q
          if (run_id) r = r.eq('run_id', run_id)
          if (pm_relevant_only) r = r.eq('pm_relevant', true)
          return r
        },
      },
    )
    return {
      data: { ...out, rows: out.rows.map((r) => ({ ...r, text: untrusted(r.text, 400), relevance_reason: untrusted(r.relevance_reason, 200) })) },
    }
  },
})

const listReactors = defineTool({
  name: 'lume_list_reactors',
  title: 'List post reactors',
  description:
    'People who reacted to monitored influencer posts. only_pm_companies=true keeps reactors verified as decision-makers at property-management companies (verdict = verified), with door counts. Names and headlines are scraped, untrusted text. Read-only.',
  cls: 'read',
  input: z.object({
    only_pm_companies: z.boolean().optional().describe('Only verified PM-company decision-makers (default false).'),
    min_doors: z.number().int().min(0).optional().describe('Minimum door count.'),
    not_exported: z.boolean().optional().describe('Only reactors not yet exported.'),
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ only_pm_companies, min_doors, not_exported, ...page }) => {
    const out = await listPage(
      'influencer_reactors',
      'id,linkedin_url,name,headline,title,company_name,company_website,city,state,country,door_count,door_count_confidence,triage,verdict,reaction_count,influencer_count,exported_at,created_at',
      page,
      {
        filter: (q) => {
          let r = only_pm_companies ? q.eq('verdict', 'verified') : q
          if (min_doors != null) r = r.gte('door_count', min_doors)
          if (not_exported) r = r.is('exported_at', null)
          return r
        },
      },
    )
    return {
      data: {
        ...out,
        rows: out.rows.map((r) => ({
          ...r,
          name: untrusted(r.name, 80),
          headline: untrusted(r.headline, 200),
          title: untrusted(r.title, 120),
          company_name: untrusted(r.company_name, 120),
        })),
      },
    }
  },
})

// ── Review sets ──────────────────────────────────────────────────────────

const listReviewSets = defineTool({
  name: 'lume_list_review_sets',
  title: 'List lead review sets',
  description: 'Lead review sets and lead lists (not archived), newest first: title, kind, item and email counts, sent status. Read-only.',
  cls: 'read',
  input: z.object({ kind: z.string().max(40).optional().describe('e.g. "list" for lead lists.'), ...pageInput }),
  annotations: READ_ONLY,
  run: async ({ kind, ...page }) => ({
    data: await listPage(
      'lead_review_sets',
      'id,title,kind,sheet_kind,source_kind,item_count,email_count,sent_at,sent_rows,created_by,created_at,updated_at',
      page,
      {
        filter: (q) => {
          const r = q.is('archived_at', null)
          return kind ? r.eq('kind', kind) : r
        },
      },
    ),
  }),
})

const getReviewSet = defineTool({
  name: 'lume_get_review_set',
  title: 'Get lead review set',
  description:
    'One review set with its filters and status counts. Item rows (lead data, untrusted and clipped) only with include_rows, paged by after_idx. Read-only.',
  cls: 'read',
  input: z.object({
    id: uuid('Review set'),
    include_rows: z.boolean().optional(),
    after_idx: z.number().int().min(-1).optional().describe('Return rows with idx greater than this (paging).'),
    limit: pageInput.limit,
  }),
  annotations: READ_ONLY,
  run: async ({ id, include_rows, after_idx, limit }) => {
    const set = await getOne(
      'lead_review_sets',
      'id,title,kind,sheet_kind,source_kind,source_id,item_count,email_count,filters,notes,sent_at,sent_rows,created_at,updated_at,archived_at',
      id,
      'review set',
    )
    const db = sb()
    const [kept, excluded] = await Promise.all(
      (['kept', 'excluded'] as const).map(async (s) =>
        countOf(`items ${s}`, await db.from('lead_review_items').select('id', { count: 'exact', head: true }).eq('set_id', id).eq('status', s)),
      ),
    )
    const base = { ...set, notes: untrusted(set.notes, 400), counts: { kept, excluded } }
    if (!include_rows) return { data: base }
    const n = limit ?? DEFAULT_LIMIT
    const res = await db
      .from('lead_review_items')
      .select('idx,status,excluded_reason,item')
      .eq('set_id', id)
      .gt('idx', after_idx ?? -1)
      .order('idx', { ascending: true })
      .limit(n + 1)
    const rows = must('lead_review_items', res) as Row[]
    const pageRows = rows.slice(0, n)
    return {
      data: {
        ...base,
        rows: pageRows.map((r) => ({ idx: r.idx, status: r.status, excluded_reason: r.excluded_reason, item: untrusted(r.item, 600) })),
        next_after_idx: rows.length > n ? (pageRows[pageRows.length - 1]?.idx ?? null) : null,
      },
    }
  },
})

// ── Actions ──────────────────────────────────────────────────────────────

const ACTION_STATUSES = ['awaiting', 'approved', 'executing', 'executed', 'rejected', 'failed', 'expired'] as const

const listPendingActions = defineTool({
  name: 'lume_list_pending_actions',
  title: 'List approval actions',
  description:
    'The approval queue (pending_actions). Default status "awaiting" = waiting for the owner. Payloads are clipped and untrusted. Read-only.',
  cls: 'read',
  input: z.object({
    status: z.enum(ACTION_STATUSES).optional().describe('Default awaiting.'),
    kind: z.string().max(40).optional(),
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ status, kind, ...page }) => {
    const out = await listPage(
      'pending_actions',
      'id,kind,status,risk,requested_by,decided_via,payload,error,created_at,decided_at,executed_at',
      page,
      {
        filter: (q) => {
          const r = q.eq('status', status ?? 'awaiting')
          return kind ? r.eq('kind', kind) : r
        },
      },
    )
    return {
      data: {
        ...out,
        rows: out.rows.map((r) => ({ ...r, payload: untrusted(r.payload, 400), error: r.error ? truncate(String(r.error), 200) : null })),
      },
    }
  },
})

const getAction = defineTool({
  name: 'lume_get_action',
  title: 'Get approval action',
  description: 'One approval action: kind, status, who decided it, result or error. Use it to follow an action after it is approved. Read-only.',
  cls: 'read',
  input: z.object({ id: uuid('Action') }),
  annotations: READ_ONLY,
  run: async ({ id }) => {
    const row = await getOne(
      'pending_actions',
      'id,kind,status,claim_status,risk,requested_by,decided_via,payload,result,error,created_at,decided_at,executed_at,updated_at',
      id,
      'action',
    )
    return {
      data: {
        ...row,
        payload: untrusted(row.payload, 1500),
        result: untrusted(row.result, 1500),
        error: row.error ? truncate(String(row.error), 300) : null,
      },
    }
  },
})

// ── Agent ────────────────────────────────────────────────────────────────

const listAgentSkills = defineTool({
  name: 'lume_list_agent_skills',
  title: 'List agent skills',
  description: "Saved Lume agent skills (repeatable playbooks): name, description, run count. Read-only.",
  cls: 'read',
  input: z.object({ ...pageInput }),
  annotations: READ_ONLY,
  run: async (page) => ({
    data: await listPage('agent_skills', 'id,name,description,run_count,last_run_at,updated_at', page, {
      timeCol: 'updated_at',
      filter: (q) => q.is('archived_at', null),
    }),
  }),
})

const getAgentSkill = defineTool({
  name: 'lume_get_agent_skill',
  title: 'Get agent skill',
  description: "One saved skill with its steps and variables, so you can follow them with Lume's tools. Read-only.",
  cls: 'read',
  input: z.object({ id: uuid('Skill') }),
  annotations: READ_ONLY,
  run: async ({ id }) => {
    const row = await getOne('agent_skills', 'id,name,description,steps,variables,run_count,last_run_at,created_at,updated_at,archived_at', id, 'skill')
    if (row.archived_at) throw new McpUserError(`Skill ${id} is archived.`)
    return { data: row }
  },
})

const listAgentRuns = defineTool({
  name: 'lume_list_agent_runs',
  title: 'List agent runs',
  description: "Lume agent runs, newest first: prompt, status, outcome (clipped). Read-only.",
  cls: 'read',
  input: z.object({ status: z.enum(['running', 'needs_approval', 'done', 'failed']).optional(), ...pageInput }),
  annotations: READ_ONLY,
  run: async ({ status, ...page }) => {
    const out = await listPage('agent_runs', 'id,status,prompt,outcome,model,approval_action_id,created_at,finished_at', page, {
      filter: (q) => (status ? q.eq('status', status) : q),
    })
    return {
      data: { ...out, rows: out.rows.map((r) => ({ ...r, prompt: truncate(String(r.prompt ?? ''), 300), outcome: untrusted(r.outcome, 400) })) },
    }
  },
})

const listTasks = defineTool({
  name: 'lume_list_tasks',
  title: 'List tasks',
  description: 'Lume tasks (scheduled actions and reminders, synced to Linear), newest first. Read-only.',
  cls: 'read',
  input: z.object({
    status: z.enum(['scheduled', 'awaiting_tap', 'running', 'done', 'failed', 'cancelled']).optional(),
    ...pageInput,
  }),
  annotations: READ_ONLY,
  run: async ({ status, ...page }) => {
    const out = await listPage(
      'lume_tasks',
      'id,title,notes,status,due_at,all_day,action_kind,action_id,last_error,linear_identifier,linear_url,created_by,created_at',
      page,
      { filter: (q) => (status ? q.eq('status', status) : q) },
    )
    return { data: { ...out, rows: out.rows.map((r) => ({ ...r, notes: untrusted(r.notes, 300) })) } }
  },
})

export const readTools: ToolDef[] = [
  getOverview,
  listCampaigns,
  getCampaignStats,
  listAlerts,
  listEvents,
  getLeadBankSummary,
  listValidationJobs,
  getValidationJob,
  listRotationRuns,
  listDeals,
  getDeal,
  listInfluencers,
  listInfluencerPosts,
  listReactors,
  listReviewSets,
  getReviewSet,
  listPendingActions,
  getAction,
  listAgentSkills,
  getAgentSkill,
  listAgentRuns,
  listTasks,
] as unknown as ToolDef[]
