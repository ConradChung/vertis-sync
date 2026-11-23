import Link from 'next/link'
import { duration, lookupProgress, spendVsCap, statusText, usdText } from '@/lib/runs/model'
import type { ApifyDetail, JobBatchDetail, LookupDetail, OrderDetail } from '@/lib/runs/load'
import { CountBar, Empty, ErrorNote, ExtLink, Facts, Section, SpendMeter, fmt, when } from '@/components/runs/parts'

/** The smaller run kinds: key fields, counts, cost, timestamps and links. */

const n = (v: number | null | undefined) => (v == null ? null : fmt.format(v))

export function LookupDetailView({ d }: { d: LookupDetail }) {
  const { batch } = d
  const prog = lookupProgress(d.counts)
  return (
    <>
      <Section title="Lookup">
        <Facts
          items={[
            ['created', when(batch.created_at)],
            ['updated', when(batch.updated_at)],
            ['candidates', fmt.format(prog.total)],
            ...Object.entries(d.counts)
              .sort((a, b) => b[1] - a[1])
              .map(([k, v]): [string, string] => [statusText(k), fmt.format(v)]),
          ]}
        />
        <CountBar done={prog.done} total={prog.total} label="Looked up" />
        <SpendMeter bar={spendVsCap(batch.spent_usd, batch.max_lookup_usd)} />
        <div className="flex flex-wrap gap-4">
          {d.listId && (
            <Link href={`/import/leads?list=${d.listId}`} className="text-[12px] text-violet-soft hover:text-fg">
              The sheet in Leads
            </Link>
          )}
          {batch.lookup_action_id && (
            <Link href={`/actions/${batch.lookup_action_id}`} className="text-[12px] text-violet-soft hover:text-fg">
              The approval behind this lookup
            </Link>
          )}
        </div>
        <ErrorNote error={batch.error} />
      </Section>
    </>
  )
}

export function OrderDetailView({ d }: { d: OrderDetail }) {
  return (
    <Section title="Order">
      <Facts
        items={[
          ['contacts', n(d.contact_count)],
          ['Leadsfriday order', d.leadsfriday_order_id != null ? `#${d.leadsfriday_order_id}` : null],
          ['Leadsfriday status', d.leadsfriday_status],
          ['credits used', d.credits_deducted != null ? String(d.credits_deducted) : null],
          ['balance after', d.new_balance != null ? String(d.new_balance) : null],
          ['created', when(d.created_at)],
          ['updated', when(d.updated_at)],
          ['took', d.status === 'ingested' || d.status === 'delivered' ? duration(d.created_at, d.updated_at) : null],
        ]}
      />
      <div className="flex flex-wrap gap-4">
        {d.apollo_url && <ExtLink href={d.apollo_url}>Apollo search</ExtLink>}
        {d.ingest_id && <span className="text-[12px] text-fg-46">Ingested as {d.ingest_id.slice(0, 8)}… (validation follows its own approval)</span>}
      </div>
      <ErrorNote error={d.error} />
    </Section>
  )
}

export function JobBatchDetailView({ d }: { d: JobBatchDetail }) {
  return (
    <Section title="Batch">
      <Facts
        items={[
          ['batch date', d.batch_date],
          ['companies added', fmt.format(d.companies_added)],
          ['companies pulled', fmt.format(d.companies_pulled)],
          ['unresolved', fmt.format(d.companies_unresolved)],
          ['contacts', fmt.format(d.contacts_total)],
          ['contacts kept', fmt.format(d.contacts_kept)],
          ['Leadsfriday order', d.leadsfriday_order_id != null ? `#${d.leadsfriday_order_id}` : null],
          ['Leadsfriday status', d.leadsfriday_status],
          ['created', when(d.created_at)],
          ['updated', when(d.updated_at)],
        ]}
      />
      {d.status === 'resolving' && d.companies_pulled > 0 && <CountBar done={d.companies_added} total={d.companies_pulled} label="Companies resolved" />}
      {d.apollo_url && <ExtLink href={d.apollo_url}>Apollo search</ExtLink>}
      <ErrorNote error={d.error} />
    </Section>
  )
}

export function ApifyDetailView({ d }: { d: ApifyDetail }) {
  if (!d.configured || !d.run) {
    return (
      <Section title="Run">
        <Empty>{!d.configured ? 'Apify is not connected here (APIFY_API_TOKEN unset), so only the console link is shown.' : `Could not read the run from Apify: ${d.error ?? 'not found'}.`}</Empty>
        <ExtLink href={d.consoleUrl}>Open in the Apify console</ExtLink>
      </Section>
    )
  }
  const r = d.run
  return (
    <Section title="Run">
      <Facts
        items={[
          ['actor', r.actorId],
          ['items', n(r.itemCount)],
          ['cost', usdText(r.usageTotalUsd)],
          ['started', when(r.startedAt)],
          ['finished', r.finishedAt ? when(r.finishedAt) : null],
          ['took', duration(r.startedAt, r.finishedAt)],
          ['dataset', r.datasetId],
        ]}
      />
      {r.statusMessage && <p className="text-[12.5px] text-fg-70">{r.statusMessage}</p>}
      <div className="flex flex-wrap gap-4">
        <ExtLink href={d.consoleUrl}>Open in the Apify console</ExtLink>
        {r.datasetId && <ExtLink href={`https://console.apify.com/storage/datasets/${encodeURIComponent(r.datasetId)}`}>Dataset</ExtLink>}
      </div>
    </Section>
  )
}
