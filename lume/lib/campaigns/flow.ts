import { CronExpressionParser } from 'cron-parser'
import type { GateKind, GateRow, Json, RotationRuleRow } from '@/lib/db/types'
import type { CampaignJob, FlowCounts, FlowFeeder, FlowStage, LeadSources, StageAction } from '@/lib/campaigns/types'
import { lastResultLabel } from '@/lib/rules/client'
import { nextRun } from '@/lib/rules/nextRun'
import { OWNER_TZ } from '@/lib/time/owner'

/**
 * Pure: the Flow for one campaign. Leads reach a campaign two ways, and the
 * Flow draws both:
 *
 *  - main path, from validation jobs linked to the campaign
 *    (`validation_jobs.instantly_campaign_id`): Import → Validate → Enrich →
 *    Push, then Send → Reply from Instantly's analytics;
 *  - branch, from the campaign's lead bank (`lead_bank.campaign_id`), moved
 *    into Instantly on a schedule by the feeders (Lume rotation rules and the
 *    `instantly-rotate` pg_cron jobs, logged in `rotation_runs`); it joins at
 *    Send.
 *
 * So a campaign filled by rotation shows Import 0 with that path marked
 * "not used" rather than a puzzling 0 next to thousands sent. Stages never
 * run directly: a stage links to its open gate, creates a pending action
 * (pause / resume), or is disabled with the reason.
 */

const VALIDATE_GATES: GateKind[] = ['finder_decision', 'stall']
const PUSH_GATES: GateKind[] = ['campaign_choice', 'push_review']
const FINISHED_STATES = ['completed', 'replied', 'bounced', 'skipped', 'unsubscribed']
const fmt = new Intl.NumberFormat('en-US')

export function sumCounts(
  jobs: CampaignJob[],
  instantly: { sent: number; replies: number } | null,
  sources: LeadSources | null = null
): FlowCounts {
  const sum = (k: keyof CampaignJob) => jobs.reduce((n, j) => n + (typeof j[k] === 'number' ? (j[k] as number) : 0), 0)
  const bank = sources?.bank ?? {}
  return {
    imported: sum('total_rows'),
    validated: sum('valid_count'),
    enriched: sum('enriched_rows'),
    pushed: sum('instantly_pushed'),
    sent: instantly?.sent ?? null,
    replies: instantly?.replies ?? null,
    bank_total: Object.values(bank).reduce((n, v) => n + v, 0),
    bank_queued: bank.queued ?? 0,
    rotated: sources?.runs?.pushed ?? 0,
    in_campaign: sources?.runs?.last?.in_instantly_after ?? null,
  }
}

const gateLink = (g: GateRow, label: string): StageAction => ({
  type: 'link',
  href: `/validate?gate=${g.kind}:${g.target_id}`,
  label,
})

const NO_GATE = 'No open gate — stages only run through gates.'
const plural = (n: number, one: string, many = `${one}s`) => `${fmt.format(n)} ${n === 1 ? one : many}`

export function buildStages(input: {
  counts: FlowCounts
  gates: GateRow[]
  jobs: CampaignJob[]
  campaignStatus: string | null
}): FlowStage[] {
  const { counts, gates, jobs, campaignStatus } = input
  const find = (kinds: GateKind[]) => gates.find((g) => kinds.includes(g.kind)) ?? null
  const validateGate = find(VALIDATE_GATES)
  const pushGate = find(PUSH_GATES)
  const running = jobs.some((j) => j.status === 'processing' || j.status === 'pending')

  const jobsUsed = jobs.length > 0
  const bankUsed = counts.bank_total > 0 || counts.rotated > 0
  const unusedHint = 'Not used — leads come from the lead bank'
  // A main-path stage is lit when it has output or a later main-path stage does (it was passed).
  const path = [counts.imported, counts.validated, counts.enriched, counts.pushed]
  const reached = (i: number) => path.slice(i).some((n) => n > 0)
  const mainStatus = (i: number): FlowStage['status'] => (!jobsUsed && bankUsed ? 'unused' : reached(i) ? 'done' : 'idle')

  let send: StageAction
  if (campaignStatus === 'active') send = { type: 'pending', kind: 'pause_campaign', label: 'Pause' }
  else if (campaignStatus === 'paused') send = { type: 'pending', kind: 'resume_campaign', label: 'Resume' }
  else if (campaignStatus === 'draft')
    send = { type: 'disabled', label: 'Launch', reason: 'Draft campaigns launch from the push gate after leads are pushed.' }
  else send = { type: 'disabled', label: 'Run', reason: campaignStatus ? `Campaign is ${campaignStatus}.` : 'Instantly status unknown.' }

  const sendStatus: FlowStage['status'] =
    campaignStatus === 'active' ? 'active' : counts.sent && counts.sent > 0 ? 'done' : 'idle'
  const inCampaign = counts.in_campaign !== null ? `${fmt.format(counts.in_campaign)} leads in campaign` : null

  return [
    {
      id: 'import',
      label: 'Import',
      count: counts.imported,
      status: mainStatus(0),
      hint: !jobsUsed && bankUsed ? unusedHint : plural(jobs.length, 'job'),
      source: 'Rows loaded by validation jobs that target this campaign (Import tab).',
      action: { type: 'link', href: '/import', label: 'Open Import' },
    },
    {
      id: 'validate',
      label: 'Validate',
      count: counts.validated,
      status: validateGate ? 'waiting' : running ? 'active' : mainStatus(1),
      hint: validateGate ? (validateGate.title ?? 'Gate open') : !jobsUsed && bankUsed ? unusedHint : null,
      source: 'Valid emails found in those jobs.',
      action: validateGate ? gateLink(validateGate, 'Open gate') : { type: 'disabled', label: 'Run', reason: NO_GATE },
    },
    {
      id: 'enrich',
      label: 'Enrich',
      count: counts.enriched,
      status: mainStatus(2),
      hint: !jobsUsed && bankUsed ? unusedHint : counts.enriched === 0 && counts.pushed > 0 ? 'Skipped — enrichment off' : null,
      source: 'Rows enriched in those jobs (chosen on the ingest gate).',
      action: { type: 'disabled', label: 'Run', reason: 'Enrichment is chosen on the ingest gate (approve + enrich).' },
    },
    {
      id: 'push',
      label: 'Push',
      count: counts.pushed,
      status: pushGate ? 'waiting' : mainStatus(3),
      hint: pushGate ? (pushGate.title ?? 'Gate open') : !jobsUsed && bankUsed ? unusedHint : null,
      source: 'Leads those jobs pushed into the Instantly campaign.',
      action: pushGate ? gateLink(pushGate, 'Open gate') : { type: 'disabled', label: 'Run', reason: NO_GATE },
    },
    {
      id: 'send',
      label: 'Emails sent',
      count: counts.sent,
      status: sendStatus,
      hint: [campaignStatus, inCampaign].filter(Boolean).join(' · ') || null,
      source:
        'From Instantly: emails sent so far, counting every step of the sequence (follow-ups too), so it can be higher than the number of leads.',
      action: send,
    },
    {
      id: 'reply',
      label: 'Replies',
      count: counts.replies,
      status: counts.replies && counts.replies > 0 ? 'done' : 'idle',
      hint: counts.sent && counts.replies !== null ? `${((counts.replies / Math.max(counts.sent, 1)) * 100).toFixed(1)}% of emails` : null,
      source: 'From Instantly: replies received on this campaign.',
      action: { type: 'tab', tab: 'inbox', label: 'Open inbox' },
    },
  ]
}

/** The branch's first node: the campaign's lead bank. */
export function buildBankStage(counts: FlowCounts, sources: LeadSources | null): FlowStage {
  const bank = sources?.bank ?? {}
  const finished = FINISHED_STATES.reduce((n, k) => n + (bank[k] ?? 0), 0)
  const parts = [
    counts.bank_queued ? `${fmt.format(counts.bank_queued)} queued` : null,
    bank.active ? `${fmt.format(bank.active)} sending` : null,
    finished ? `${fmt.format(finished)} finished` : null,
  ].filter(Boolean)
  return {
    id: 'bank',
    label: 'Lead bank',
    count: counts.bank_total,
    status: counts.bank_total > 0 ? 'done' : 'idle',
    hint: parts.join(' · ') || null,
    source:
      'Leads stored for this campaign in the lead bank (Rotate tab): queued ones wait their turn, sending ones are in Instantly now, finished ones completed, replied, bounced or were skipped.',
    action: { type: 'link', href: '/rotate', label: 'Open Rotate' },
  }
}

// ---------------------------------------------------------------------------
// Schedules in plain English

const DOW_LABEL: Record<string, string> = { '*': 'Daily', '1-5': 'Weekdays', '0,6': 'Weekends', '6,0': 'Weekends' }
const DAY = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']
const timeFmt = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, hour: 'numeric', minute: '2-digit' })

function dowLabel(dow: string): string {
  if (DOW_LABEL[dow]) return DOW_LABEL[dow]
  if (/^[0-6](,[0-6])*$/.test(dow)) return `On ${dow.split(',').map((d) => DAY[Number(d)]).join(', ')}`
  return `On days ${dow}`
}

/**
 * Cron expressions → one plain-English line in the owner's time zone, e.g.
 * pg_cron's UTC `0 13 * * *` + `0 1 * * *` → "Daily at 6:00 AM and 6:00 PM"
 * (PDT). Falls back to the expression when it isn't a simple shape.
 */
export function plainSchedule(crons: string[], tz: string, now: Date = new Date()): string {
  const groups = new Map<string, { at: number; label: string }[]>()
  const other: string[] = []
  for (const raw of crons) {
    const f = raw.trim().split(/\s+/)
    if (f.length !== 5) {
      other.push(raw)
      continue
    }
    const [m, h, dom, mon, dow] = f
    const step = /^\*\/(\d+)$/.exec(m)
    if (step && h === '*' && dom === '*' && mon === '*' && dow === '*') {
      other.push(`Every ${step[1]} minutes`)
      continue
    }
    if (/^\d+$/.test(m) && h === '*' && dom === '*' && mon === '*' && dow === '*') {
      other.push(`Hourly at :${m.padStart(2, '0')}`)
      continue
    }
    if (/^\d+$/.test(m) && /^\d+$/.test(h) && dom === '*' && mon === '*') {
      try {
        const next = CronExpressionParser.parse(`${m} ${h} * * *`, { currentDate: now, tz }).next().toDate()
        // Sort by wall-clock minute of day in the owner's zone.
        const parts = new Intl.DateTimeFormat('en-US', { timeZone: OWNER_TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(next)
        const at = Number(parts.find((p) => p.type === 'hour')?.value ?? 0) * 60 + Number(parts.find((p) => p.type === 'minute')?.value ?? 0)
        const key = dowLabel(dow)
        groups.set(key, [...(groups.get(key) ?? []), { at, label: timeFmt.format(next) }])
        continue
      } catch {
        // fall through
      }
    }
    other.push(`${raw.trim()} (${tz})`)
  }
  const lines = [...groups.entries()].map(([days, times]) => {
    const t = times.sort((a, b) => a.at - b.at).map((x) => x.label)
    return `${days} at ${t.length > 1 ? `${t.slice(0, -1).join(', ')} and ${t.at(-1)}` : t[0]}`
  })
  return [...lines, ...other].join('; ') || 'No schedule'
}

function soonest(crons: string[], tz: string, now: Date): string | null {
  const next = crons.map((c) => nextRun(c, now, tz)).filter((x): x is string => !!x)
  return next.sort()[0] ?? null
}

// ---------------------------------------------------------------------------
// Feeders (the forked branch)

/**
 * Rotation rules targeting the campaign, plus the `instantly-rotate` pg_cron
 * jobs when `rotation_runs` shows they rotate this campaign (one combined
 * "Auto-rotation" node). pg_cron runs in UTC; rules in the owner's zone.
 */
export function buildFeeders(rules: RotationRuleRow[], sources: LeadSources | null, now: Date = new Date()): FlowFeeder[] {
  const out: FlowFeeder[] = rules.map((r) => {
    const last = lastResultLabel(r.last_result as Record<string, Json> | null)
    const count = typeof r.last_result?.count === 'number' ? r.last_result.count : null
    return {
      id: `rule:${r.id}`,
      kind: 'rule',
      name: r.name,
      schedule: plainSchedule([r.cron], OWNER_TZ, now),
      cron: [r.cron],
      active: r.active,
      next_run: r.active ? (r.next_run_at ?? nextRun(r.cron, now)) : null,
      last_run: r.last_run_at,
      last_result: last.text,
      leads_added: count,
      leads_added_label: count !== null ? 'last batch' : `up to ${fmt.format(r.daily_cap)} per run`,
      href: `/rotate#rule-${r.id}`,
    }
  })

  const crons = sources?.crons ?? []
  const runs = sources?.runs
  if (crons.length || (runs && runs.count > 0)) {
    const exprs = crons.map((c) => c.schedule)
    const last = runs?.last ?? null
    let result = 'No runs yet'
    if (last) {
      const bits = [
        last.pushed ? `added ${plural(last.pushed, 'lead')}` : 'added none',
        last.deleted ? `removed ${fmt.format(last.deleted)} finished` : null,
        last.in_instantly_after !== null ? `${fmt.format(last.in_instantly_after)} in campaign after` : null,
        last.errors ? plural(last.errors, 'error') : null,
      ].filter(Boolean)
      result = bits.join(' · ')
    }
    const active = crons.some((c) => c.active)
    out.push({
      id: 'system:instantly-rotate',
      kind: 'system',
      name: 'Auto-rotation',
      schedule: exprs.length ? plainSchedule(exprs, 'UTC', now) : 'Schedule unknown',
      cron: exprs,
      active,
      next_run: active ? soonest(crons.filter((c) => c.active).map((c) => c.schedule), 'UTC', now) : null,
      last_run: last?.ran_at ?? null,
      last_result: result,
      leads_added: runs?.pushed ?? 0,
      leads_added_label: `added over ${plural(runs?.count ?? 0, 'run')}`,
      href: '/rotate',
    })
  }
  return out
}
