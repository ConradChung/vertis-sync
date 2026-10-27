import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import Link from 'next/link'
import { CsvUploadForm } from '@/components/operator/CsvUploadForm'
import { isInstantlyConfigured, listCampaigns } from '@/lib/adapters/instantly'
import { groupByVertical, type CheckinItem, type Control } from '@/lib/operators/checkin'
import { loadCheckin, type CheckinData } from '@/lib/operators/checkinData'
import { currentOperator } from '@/lib/operators/session'
import { UUID_RE } from '@/lib/http/json'
import { resolveCampaignQuery, type CampaignLite } from '@/lib/validate/campaignQuery'

export const metadata: Metadata = { title: 'Operator check-in' }
export const dynamic = 'force-dynamic'

/**
 * `/operator`: the Grok Bot check-in page (Phase G5). Server-rendered,
 * semantic HTML, real forms, no animation; the only script is the CSV
 * upload. `#operator-summary` is a machine-readable JSON summary. Every form
 * posts to an existing Lume route and comes back here with a flash.
 *
 * Scope: a vertical bot sees its vertical; the master bot and the owner see
 * every vertical (the owner can narrow with `?vertical=<id>`). A bot's visit
 * records its check-in.
 */

type SearchParams = Promise<Record<string, string | string[] | undefined>>

const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v) ?? null

export default async function OperatorPage({ searchParams }: { searchParams: SearchParams }) {
  const params = await searchParams
  const store = await cookies()
  const operator = await currentOperator(store).catch(() => null)
  const verticalParam = one(params.vertical)
  const data = await loadCheckin({ operator, verticalParam: verticalParam && UUID_RE.test(verticalParam) ? verticalParam.toLowerCase() : null })

  const returnTo = !operator && !data.scope.all ? `/operator?vertical=${data.scope.vertical.id}` : '/operator'
  const flash = one(params.flash)
  const flashError = one(params.flash_error)
  const cqJob = one(params.cq_job)
  const cq = one(params.cq)
  const matches = cqJob && cq && UUID_RE.test(cqJob) ? await campaignMatches(cq) : null

  const heading = data.scope.all ? 'All verticals' : data.scope.vertical.name
  const who = operator ? (operator.is_master ? `Master Grok Bot “${operator.label}”` : `Grok Bot “${operator.label}”`) : 'Owner'

  return (
    <article className="operator-page" aria-labelledby="operator-title">
      <h1 id="operator-title">Operator check-in: {heading}</h1>
      <p className="muted">
        Signed in as {who}. Generated {data.summary.generated_at}. Previous check-in: {data.summary.last_checked_at ?? 'never'}.
      </p>
      <pre id="operator-summary" aria-label="Machine-readable summary">
        {JSON.stringify(data.summary, null, 2)}
      </pre>
      {flash && (
        <p className="flash" role="status" id="flash">
          {flash}
        </p>
      )}
      {flashError && (
        <p className="flash-error" role="alert" id="flash-error">
          {flashError}
        </p>
      )}
      {data.errors.length > 0 && (
        <ul className="flash-error" aria-label="Load problems">
          {data.errors.map((e) => (
            <li key={e}>{e}</li>
          ))}
        </ul>
      )}
      {!operator && (
        <nav aria-label="Vertical">
          <p>
            View:{' '}
            <Link href="/operator">All</Link>
            {data.verticals.map((v) => (
              <span key={v.id}>
                {' · '}
                <Link href={`/operator?vertical=${v.id}`}>{v.name}</Link>
              </span>
            ))}
          </p>
        </nav>
      )}

      <NeedsConfirmation data={data} returnTo={returnTo} cqJob={cqJob} cq={cq} matches={matches} />
      <Alerts data={data} returnTo={returnTo} />
      <Outcomes data={data} />
      <Campaigns data={data} />
      <Inputs data={data} returnTo={returnTo} isOperator={!!operator} />
    </article>
  )
}

async function campaignMatches(query: string): Promise<CampaignLite[] | 'unavailable'> {
  if (!isInstantlyConfigured()) return 'unavailable'
  try {
    const r = resolveCampaignQuery(query, await listCampaigns())
    if (r.kind === 'several') return r.matches
    if (r.kind === 'resolved') return [r.campaign]
    return []
  } catch {
    return 'unavailable'
  }
}

// ---------------------------------------------------------------------------

function NeedsConfirmation({
  data,
  returnTo,
  cqJob,
  cq,
  matches,
}: {
  data: CheckinData
  returnTo: string
  cqJob: string | null
  cq: string | null
  matches: CampaignLite[] | 'unavailable' | null
}) {
  const groups = data.scope.all ? groupByVertical(data.items) : [{ vertical_id: data.scope.vertical.id, vertical_name: data.scope.vertical.name, items: data.items }]
  return (
    <section aria-labelledby="needs-confirmation">
      <h2 id="needs-confirmation">Needs confirmation ({data.items.length})</h2>
      <p className="muted">Money items first, then validation, then the rest; oldest first inside each.</p>
      {data.items.length === 0 && <p id="needs-confirmation-empty">Nothing needs confirmation.</p>}
      {data.items.length > 0 &&
        groups.map((g) => (
          <section key={g.vertical_id ?? 'none'} aria-label={`Needs confirmation: ${g.vertical_name}`}>
            {data.scope.all && <h3>{g.vertical_name}</h3>}
            <table>
              <thead>
                <tr>
                  <th scope="col">Type</th>
                  <th scope="col">What</th>
                  <th scope="col">Target</th>
                  <th scope="col">Leads</th>
                  <th scope="col">Cost</th>
                  <th scope="col">Decide</th>
                </tr>
              </thead>
              <tbody>
                {g.items.map((it) => (
                  <tr key={it.key} id={`item-${it.key.replace(':', '-')}`} data-priority={it.priority} data-kind={it.kind}>
                    <td>{it.priority === 'money' ? 'Money' : it.priority === 'validation' ? 'Validation' : 'Other'}</td>
                    <td>{it.what}</td>
                    <td style={{ whiteSpace: 'pre-wrap' }}>{it.target}</td>
                    <td>{it.leads === null ? '—' : it.leads.toLocaleString('en-US')}</td>
                    <td>{it.cost ?? '—'}</td>
                    <td>
                      <Controls item={it} returnTo={returnTo} cqJob={cqJob} cq={cq} matches={matches} />
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        ))}
    </section>
  )
}

function Hidden({ returnTo }: { returnTo: string }) {
  return <input type="hidden" name="return_to" value={returnTo} />
}

function GateForm({ callback, label, tone, returnTo }: { callback: string; label: string; tone: string; returnTo: string }) {
  return (
    <form method="post" action="/api/gates/decide">
      <input type="hidden" name="callback_data" value={callback} />
      <Hidden returnTo={returnTo} />
      <button type="submit" data-tone={tone}>
        {label}
      </button>
    </form>
  )
}

function Controls({
  item,
  returnTo,
  cqJob,
  cq,
  matches,
}: {
  item: CheckinItem
  returnTo: string
  cqJob: string | null
  cq: string | null
  matches: CampaignLite[] | 'unavailable' | null
}) {
  const c: Control = item.control
  switch (c.type) {
    case 'approve_deny':
      return (
        <>
          <form method="post" action={`/api/actions/${c.action_id}/decide`}>
            <input type="hidden" name="decision" value="approve" />
            <Hidden returnTo={returnTo} />
            <button type="submit" data-tone="approve">
              Approve
            </button>
          </form>
          <form method="post" action={`/api/actions/${c.action_id}/decide`}>
            <input type="hidden" name="decision" value="reject" />
            <Hidden returnTo={returnTo} />
            <button type="submit" data-tone="reject">
              Deny
            </button>
          </form>{' '}
          <Link href={`/actions/${c.action_id}`}>Details</Link>
        </>
      )
    case 'gate_buttons':
      return (
        <>
          {c.buttons.map((b) => (
            <GateForm key={b.callback_data} callback={b.callback_data} label={b.spends ? `${b.label} (spends)` : b.label} tone={b.tone} returnTo={returnTo} />
          ))}
        </>
      )
    case 'lfo_count':
      return (
        <>
          {c.presets.map((p) => (
            <form key={p} method="post" action="/api/gates/decide">
              <input type="hidden" name="callback_data" value={`lfo_count:${c.target_id}`} />
              <input type="hidden" name="count" value={p} />
              <Hidden returnTo={returnTo} />
              <button type="submit" data-tone="approve">
                Order {p.toLocaleString('en-US')} (${((p * 3) / 1000).toFixed(2)})
              </button>
            </form>
          ))}
          <form method="post" action="/api/gates/decide" className="block">
            <input type="hidden" name="callback_data" value={`lfo_count:${c.target_id}`} />
            <Hidden returnTo={returnTo} />
            <label htmlFor={`count-${c.target_id}`}>Custom count (min 500, $0.003 each)</label>{' '}
            <input id={`count-${c.target_id}`} name="count" type="number" min={500} step={1} required />{' '}
            <button type="submit" data-tone="approve">
              Order custom count
            </button>
          </form>
          <GateForm callback={c.cancel.callback_data} label={c.cancel.label} tone="reject" returnTo={returnTo} />
        </>
      )
    case 'campaign_pick': {
      const listed = cqJob === c.job_id ? matches : null
      return (
        <>
          <form method="post" action={`/api/gates/campaign/${c.job_id}`} className="block">
            <Hidden returnTo={returnTo} />
            <label htmlFor={`cq-${c.job_id}`}>Instantly campaign name</label>{' '}
            <input id={`cq-${c.job_id}`} name="campaign_query" type="text" required defaultValue={cqJob === c.job_id ? (cq ?? '') : ''} />{' '}
            <button type="submit" data-tone="approve">
              Set campaign
            </button>
          </form>
          {Array.isArray(listed) && listed.length > 0 && (
            <ul aria-label="Matching campaigns">
              {listed.map((m) => (
                <li key={m.id}>
                  <form method="post" action={`/api/gates/campaign/${c.job_id}`}>
                    <input type="hidden" name="campaign_id" value={m.id} />
                    <Hidden returnTo={returnTo} />
                    <button type="submit">Pick “{m.name}”</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          {listed === 'unavailable' && <p className="muted">Instantly campaign list unavailable.</p>}
          {c.candidates.length > 0 && (
            <ul aria-label="Campaigns offered in Telegram">
              {c.candidates.map((m) => (
                <li key={m.id}>
                  <form method="post" action={`/api/gates/campaign/${c.job_id}`}>
                    <input type="hidden" name="campaign_id" value={m.id} />
                    <Hidden returnTo={returnTo} />
                    <button type="submit">Pick “{m.name}”</button>
                  </form>
                </li>
              ))}
            </ul>
          )}
          <GateForm callback={c.cancel.callback_data} label={c.cancel.label} tone="reject" returnTo={returnTo} />
        </>
      )
    }
    case 'push_review':
      return (
        <>
          <form method="post" action="/api/actions">
            <input type="hidden" name="kind" value="push_to_instantly" />
            <input type="hidden" name="job_id" value={c.job_id} />
            <Hidden returnTo={returnTo} />
            <button type="submit" data-tone="approve">
              Push these (files a confirmation)
            </button>
          </form>
          <GateForm callback={c.cancel.callback_data} label={c.cancel.label} tone="reject" returnTo={returnTo} />{' '}
          <Link href={c.validate_link}>Barriers, names, templates</Link>
        </>
      )
    case 'link':
      return (
        <p>
          <Link href={c.href}>Open</Link> <span className="muted">({c.reason})</span>
        </p>
      )
  }
}

// ---------------------------------------------------------------------------

function Alerts({ data, returnTo }: { data: CheckinData; returnTo: string }) {
  const name = (id: string | null) => data.verticals.find((v) => v.id === id)?.name
  return (
    <section aria-labelledby="alerts">
      <h2 id="alerts">
        Alerts ({data.alerts.length} unacknowledged, {data.summary.urgent_alerts} urgent)
      </h2>
      {data.alerts.length === 0 && <p id="alerts-empty">No unacknowledged alerts.</p>}
      {data.alerts.length > 0 && (
        <>
          <form method="post" action="/api/alerts/ack" className="block">
            {data.alerts.map((a) => (
              <input key={a.id} type="hidden" name="ids" value={a.id} />
            ))}
            <Hidden returnTo={returnTo} />
            <button type="submit">Acknowledge all ({data.alerts.length})</button>
          </form>
          <table>
            <thead>
              <tr>
                <th scope="col">Severity</th>
                <th scope="col">When (UTC)</th>
                <th scope="col">Alert</th>
                <th scope="col">Source</th>
                <th scope="col">Acknowledge</th>
              </tr>
            </thead>
            <tbody>
              {data.alerts.map((a) => (
                <tr key={a.id} id={`alert-${a.id}`} data-severity={a.severity}>
                  <td className={a.severity === 'urgent' ? 'urgent' : undefined}>{a.severity}</td>
                  <td>{a.created_at}</td>
                  <td>
                    <strong>{a.title}</strong>
                    {a.body && a.body !== a.title && <div style={{ whiteSpace: 'pre-wrap' }}>{a.body}</div>}
                    {a.link && (
                      <div>
                        <a href={a.link}>Open</a>
                      </div>
                    )}
                  </td>
                  <td>
                    {a.source}
                    {data.scope.all && a.campaign_id && name(a.campaign_id) ? ` · ${name(a.campaign_id)}` : ''}
                  </td>
                  <td>
                    <form method="post" action="/api/alerts/ack">
                      <input type="hidden" name="ids" value={a.id} />
                      <Hidden returnTo={returnTo} />
                      <button type="submit">Acknowledge</button>
                    </form>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </section>
  )
}

function Outcomes({ data }: { data: CheckinData }) {
  return (
    <section aria-labelledby="outcomes">
      <h2 id="outcomes">Recent outcomes (last 24 h)</h2>
      <p className="muted">Pending actions decided in the last 24 hours and what the executor did. Gate decisions taken by a pipeline appear as alerts.</p>
      {data.outcomes.length === 0 ? (
        <p id="outcomes-empty">No decisions in the last 24 hours.</p>
      ) : (
        <table>
          <thead>
            <tr>
              <th scope="col">Decided (UTC)</th>
              <th scope="col">Action</th>
              <th scope="col">Status</th>
              <th scope="col">Decided by</th>
              <th scope="col">Error</th>
            </tr>
          </thead>
          <tbody>
            {data.outcomes.map((o) => (
              <tr key={o.id}>
                <td>{o.decided_at ?? '—'}</td>
                <td>
                  <Link href={`/actions/${o.id}`}>{o.kind}</Link>: <span style={{ whiteSpace: 'pre-wrap' }}>{o.summary}</span>
                </td>
                <td>{o.status}</td>
                <td>
                  {o.decided_via === 'operator' && o.decided_by_operator
                    ? `Grok Bot “${data.operatorLabels[o.decided_by_operator] ?? o.decided_by_operator}”`
                    : (o.decided_via ?? '—')}
                </td>
                <td>{o.error ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Campaigns({ data }: { data: CheckinData }) {
  const cell = (s: { sent: number; replies: number; bounced: number } | null, k: 'sent' | 'replies' | 'bounced') =>
    s ? s[k].toLocaleString('en-US') : '—'
  return (
    <section aria-labelledby="campaigns">
      <h2 id="campaigns">Campaigns</h2>
      {data.campaignsNote && <p className="muted">{data.campaignsNote}</p>}
      {data.campaigns.length > 0 && (
        <table>
          <thead>
            <tr>
              <th scope="col">Campaign</th>
              <th scope="col">Sent today</th>
              <th scope="col">Replies today</th>
              <th scope="col">Bounces today</th>
              <th scope="col">Sent 7d</th>
              <th scope="col">Replies 7d</th>
              <th scope="col">Bounces 7d</th>
              <th scope="col">Note</th>
            </tr>
          </thead>
          <tbody>
            {data.campaigns.map((c) => (
              <tr key={c.id}>
                <td>
                  {c.name}
                  {c.name !== c.id && <div className="muted">{c.id}</div>}
                </td>
                <td>{cell(c.today, 'sent')}</td>
                <td>{cell(c.today, 'replies')}</td>
                <td>{cell(c.today, 'bounced')}</td>
                <td>{cell(c.week, 'sent')}</td>
                <td>{cell(c.week, 'replies')}</td>
                <td>{cell(c.week, 'bounced')}</td>
                <td>{c.note ?? ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}

function Inputs({ data, returnTo, isOperator }: { data: CheckinData; returnTo: string; isOperator: boolean }) {
  // An operator's new chat is tagged with its own vertical automatically; the owner can pick one.
  const agentHref = isOperator || data.scope.all ? '/agent?new=1' : `/agent?new=1&vertical=${data.scope.vertical.id}`
  return (
    <section aria-labelledby="inputs">
      <h2 id="inputs">Inputs</h2>
      <h3>Apollo search link → Leadsfriday</h3>
      <form method="post" action="/api/import/apollo-link" className="block">
        <Hidden returnTo={returnTo} />
        <label htmlFor="apollo-url">Apollo people-search URL</label>{' '}
        <input id="apollo-url" name="url" type="url" required placeholder="https://app.apollo.io/#/people?…" />{' '}
        <button type="submit">Submit Apollo link</button>
      </form>
      <p className="muted">Nothing is spent until a count is chosen under Needs confirmation.</p>
      <h3>CSV upload → validation</h3>
      <CsvUploadForm />
      <p className="muted">The upload waits at the Approve / Deny gate under Needs confirmation.</p>
      <h3>Campaign name for a validated job</h3>
      <p className="muted">
        Jobs waiting for an Instantly campaign are listed under Needs confirmation (“Pick a campaign”) with a name box; it matches like the Telegram reply
        did (an exact name wins; one match is picked; several are listed to choose from).
      </p>
      <h3>Lume&apos;s agent</h3>
      <p>
        <Link href={agentHref} id="message-agent">
          Message Lume&apos;s agent (new conversation)
        </Link>
      </p>
    </section>
  )
}
