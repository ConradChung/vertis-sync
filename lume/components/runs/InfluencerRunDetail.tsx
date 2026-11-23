import Link from 'next/link'
import { apifyRunUrl, costLines, stageStates, usd } from '@/lib/influencers/runView'
import { digestCounts, digestText, duration, groupReactors, runHeadline, DIGEST_LABEL, type PersonView } from '@/lib/runs/model'
import { MAX_REACTORS, type InfluencerRunDetail as Detail } from '@/lib/runs/load'
import { Empty, ErrorNote, ExtLink, Facts, Section, fmt, when } from '@/components/runs/parts'
import { cn } from '@/lib/utils'

/** Rows shown per people group before "+N more" (the full set is in the export). */
const GROUP_ROWS = 150

const STAGE_TONE = {
  done: 'bg-lime/15 text-lime',
  active: 'bg-cyan/10 text-cyan',
  needs_you: 'bg-lime/10 text-positive',
  failed: 'bg-red/12 text-red',
  todo: 'bg-white/[.04] text-fg-46',
} as const

function PeopleTable({ label, rows, showReason }: { label: string; rows: PersonView[]; showReason: boolean }) {
  if (!rows.length) return <Empty>Nobody.</Empty>
  const shown = rows.slice(0, GROUP_ROWS)
  return (
    <div className="max-h-[50vh] overflow-auto rounded-xl">
      <table aria-label={label} className="w-full min-w-[760px] text-left text-[12px]">
        <thead className="sticky top-0 z-10 bg-background text-fg-46">
          <tr>
            {['Person', 'Company', 'Doors', showReason ? 'Reason' : 'Triage', 'Seen', 'Exported'].map((h) => (
              <th key={h} className="py-2 pr-3 font-normal whitespace-nowrap first:pl-3">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {shown.map((p) => (
            <tr key={String(p.id)} className="border-t border-line align-top">
              <td className="max-w-64 py-2 pr-3 pl-3">
                <a href={p.linkedin_url} target="_blank" rel="noopener noreferrer" className="block truncate text-fg hover:text-violet-soft">
                  {p.name ?? p.linkedin_url}
                </a>
                {p.headline && <span className="line-clamp-2 text-[11px] text-fg-46">{p.headline}</span>}
              </td>
              <td className="max-w-48 py-2 pr-3 text-fg-70">
                <span className="block truncate">{p.company_name ?? '—'}</span>
                {p.company_website && <span className="block truncate font-mono text-[10.5px] text-fg-46">{p.company_website}</span>}
              </td>
              <td className="py-2 pr-3 font-mono text-fg-70 tabular-nums">{p.door_count != null ? fmt.format(p.door_count) : '—'}</td>
              <td className="max-w-[22rem] py-2 pr-3 text-fg-70">{showReason ? p.reason : (p.triage ?? '—')}</td>
              <td className="py-2 pr-3 text-fg-46">{p.seen}</td>
              <td className="py-2 pr-3 font-mono text-fg-46">{p.exported_at ? when(p.exported_at) : '—'}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {rows.length > shown.length && <p className="px-3 py-2 text-[11px] text-fg-46">+{fmt.format(rows.length - shown.length)} more (export the run for the full list).</p>}
    </div>
  )
}

export function InfluencerRunDetail({ d }: { d: Detail }) {
  const { run } = d
  const counts = runHeadline(run.counts)
  const cost = costLines(run.cost)
  const stages = stageStates(run)
  const people = groupReactors(d.reactors, run.id)
  const names = new Map(d.influencers.map((i) => [i.id, i.name]))
  const digests = digestCounts(d.signalPosts)
  const action = run.reactions_action_id ?? run.start_action_id

  return (
    <>
      <Section title="Run">
        <Facts
          items={[
            ['stage', run.stage],
            ['created', when(run.created_at)],
            ['approved', run.approved_at ? when(run.approved_at) : null],
            ['finished', run.finished_at ? when(run.finished_at) : null],
            ['took', duration(run.created_at, run.finished_at)],
            ['influencers', d.influencers.map((i) => i.name).join(', ') || `${run.influencer_ids.length}`],
          ]}
        />
        <ol className="flex flex-wrap gap-1.5" aria-label="Stages">
          {stages.map((s) => (
            <li key={s.id} className={cn('rounded-full px-2.5 py-0.5 text-[11px]', STAGE_TONE[s.state])}>
              {s.label}
            </li>
          ))}
        </ol>
        {action && (
          <Link href={`/actions/${action}`} className="w-fit text-[12px] text-violet-soft hover:text-fg">
            The approval behind this run
          </Link>
        )}
        <ErrorNote error={run.error} />
      </Section>

      <Section title="Counts">
        {counts.length ? (
          <Facts items={counts.map((c) => [c.label, fmt.format(c.value)])} />
        ) : (
          <Empty>No counts yet.</Empty>
        )}
      </Section>

      <Section title="Posts scraped" aside={d.posts.length ? `${d.posts.length} post${d.posts.length === 1 ? '' : 's'}` : undefined}>
        {d.posts.length ? (
          <ul className="flex flex-col">
            {d.posts.map((p) => (
              <li key={`${p.influencer_id}:${p.post_id}`} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg px-3 py-2 hover:bg-white/[.04]">
                <span className="min-w-0 text-[12.5px] text-fg">
                  {p.rank != null && <span className="mr-2 font-mono text-fg-46">#{p.rank}</span>}
                  {names.get(p.influencer_id) ?? 'Influencer'}
                  <span className="text-fg-46"> · {when(p.posted_at)}</span>
                </span>
                <span className="flex items-center gap-3 font-mono text-[11.5px] text-fg-46 tabular-nums">
                  {fmt.format(p.likes)} likes · {fmt.format(p.comments)} comments
                  <ExtLink href={p.post_url}>Post</ExtLink>
                </span>
              </li>
            ))}
          </ul>
        ) : (
          <Empty>No posts recorded for this run.</Empty>
        )}
        {d.signalPosts.length > 0 && (
          <div className="flex flex-col gap-1.5">
            <p className="text-[11px] text-fg-46">Frank&apos;s posts this run reacted to (GTM-14)</p>
            <ul className="flex flex-col">
              {d.signalPosts.map((p) => (
                <li key={p.post_id} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg px-3 py-2 hover:bg-white/[.04]">
                  <span className="text-[12.5px] text-fg">
                    {when(p.posted_at)}
                    <span className="text-fg-46"> · reactions {p.reactions_status ?? '—'}</span>
                  </span>
                  <span className="flex items-center gap-3 text-[11.5px] text-fg-70">
                    {digestText(p.digest_status)}
                    {p.digest_posted_at && <span className="font-mono text-fg-46">{when(p.digest_posted_at)}</span>}
                    <ExtLink href={p.post_url}>Post</ExtLink>
                  </span>
                </li>
              ))}
            </ul>
          </div>
        )}
      </Section>

      <Section title="People" aside={`${fmt.format(people.passed.length)} passed · ${fmt.format(people.dropped.length)} dropped · ${fmt.format(people.known.length)} known / skipped`}>
        {d.reactorsTruncated && <p className="text-[11px] text-amber">Showing the first {fmt.format(MAX_REACTORS)} reactors of this run.</p>}
        <details open className="group flex flex-col gap-2">
          <summary className="cursor-pointer list-none text-[12.5px] font-medium text-green [&::-webkit-details-marker]:hidden">Passed · {fmt.format(people.passed.length)}</summary>
          <div className="mt-2">
            <PeopleTable label="Passed" rows={people.passed} showReason={false} />
          </div>
        </details>
        <details className="group flex flex-col gap-2">
          <summary className="cursor-pointer list-none text-[12.5px] font-medium text-red [&::-webkit-details-marker]:hidden">
            Dropped · {fmt.format(people.dropped.length)}
            {people.dropReasons.length > 0 && <span className="ml-2 font-normal text-fg-46">{people.dropReasons.map((r) => `${r.reason}: ${fmt.format(r.count)}`).join(' · ')}</span>}
          </summary>
          <div className="mt-2">
            <PeopleTable label="Dropped" rows={people.dropped} showReason />
          </div>
        </details>
        <details className="group flex flex-col gap-2">
          <summary className="cursor-pointer list-none text-[12.5px] font-medium text-fg-70 [&::-webkit-details-marker]:hidden">Known / skipped · {fmt.format(people.known.length)}</summary>
          <div className="mt-2">
            <PeopleTable label="Known / skipped" rows={people.known} showReason />
          </div>
        </details>
      </Section>

      <Section title="Cards and exports">
        <Facts
          items={[
            ...Object.entries(DIGEST_LABEL).map(([k, label]): [string, string | null] => [label, digests[k] ? fmt.format(digests[k]) : null]),
            ['people exported', fmt.format(people.exported)],
            ['exports of this run', fmt.format(d.exports.length)],
          ]}
        />
        {d.exports.length > 0 && (
          <ul className="flex flex-col">
            {d.exports.map((e) => (
              <li key={e.id} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2 text-[12.5px] hover:bg-white/[.04]">
                <span className="text-fg">
                  {fmt.format(e.row_count)} rows <span className="text-fg-46">· {when(e.created_at)}</span>
                </span>
                <a href={`/api/influencers/exports/${e.id}`} className="text-[12px] text-violet-soft hover:text-fg">
                  Download CSV
                </a>
              </li>
            ))}
          </ul>
        )}
      </Section>

      <Section title="Cost">
        {cost.length ? <Facts items={cost.map((c) => [c.label, c.value])} /> : <Empty>No spend recorded.</Empty>}
      </Section>

      {d.apify.length > 0 && (
        <Section title="Apify runs">
          <ul className="flex flex-col">
            {d.apify.map((a, i) => (
              <li key={a.apify_run_id ?? i} className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1 rounded-lg px-3 py-2 text-[12px] hover:bg-white/[.04]">
                <span className="text-fg">
                  {a.kind} · {names.get(a.influencer_id) ?? 'influencer'}
                  <span className="text-fg-46"> · {a.status}</span>
                </span>
                <span className="flex items-center gap-3 font-mono text-fg-46 tabular-nums">
                  {a.item_count ?? 0} items · {usd(a.cost_usd)}
                  {a.apify_run_id && <ExtLink href={apifyRunUrl(a.apify_run_id)}>Apify</ExtLink>}
                </span>
              </li>
            ))}
          </ul>
        </Section>
      )}
    </>
  )
}
