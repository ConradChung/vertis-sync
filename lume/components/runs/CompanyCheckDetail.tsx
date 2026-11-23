import Link from 'next/link'
import { doorsText, FIT_LABEL, SCOPE_LABEL, TYPE_LABEL } from '@/lib/companyCheck/view'
import type { Fit, PropertyType } from '@/lib/companyCheck/model'
import { checkedOfTotal, duration, spendVsCap, usdText } from '@/lib/runs/model'
import { MAX_CHECKED, type CompanyCheckDetail as Detail } from '@/lib/runs/load'
import { CountBar, Empty, ErrorNote, ExtLink, Facts, Section, SpendMeter, fmt, when } from '@/components/runs/parts'
import { cn } from '@/lib/utils'

const FIT_TONE: Record<Fit, string> = { fit: 'text-lime', not_fit: 'text-red', unclear: 'text-fg-46' }

const siteHref = (w: string) => (/^https?:\/\//i.test(w) ? w : `https://${w}`)

export function CompanyCheckDetail({ d }: { d: Detail }) {
  const { run, job } = d
  const progress = checkedOfTotal(d.summary?.items, run.companies_total)
  const spend = spendVsCap(run.spent_usd, run.max_usd)

  return (
    <>
      <Section title="Run">
        <Facts
          items={[
            ['scope', SCOPE_LABEL[run.scope] ?? run.scope],
            ['estimate', usdText(run.estimate_usd)],
            ['cap', usdText(run.max_usd)],
            ['created', when(run.created_at)],
            ['finished', run.finished_at ? when(run.finished_at) : null],
            ['took', duration(run.created_at, run.finished_at)],
            ['campaign', job?.instantly_campaign_name ?? null],
            ['tag', job?.vertical_name ?? null],
          ]}
        />
        <div>
          <p className="text-[11px] text-fg-46">ICP</p>
          <p className="mt-0.5 text-[13px] text-fg-70">{run.icp_description}</p>
        </div>
        <SpendMeter bar={spend} />
        <CountBar done={progress.checked} total={progress.total} label="Companies checked" />
        <Link href={`/progress?run=${run.job_id}`} className="w-fit text-[12px] text-violet-soft hover:text-fg">
          The job this check ran on
        </Link>
        <ErrorNote error={run.error} />
      </Section>

      <Section title="Companies checked in this run" aside={`${fmt.format(d.companies.length)}${d.truncated ? '+' : ''}`}>
        {d.truncated && <p className="text-[11px] text-amber">Showing the first {fmt.format(MAX_CHECKED)}, most leads first.</p>}
        {d.companies.length ? (
          <div className="max-h-[60vh] overflow-auto rounded-xl">
            <table aria-label="Companies checked in this run" className="w-full min-w-[880px] text-left text-[12px]">
              <thead className="sticky top-0 z-10 bg-background text-fg-46">
                <tr>
                  {['Company', 'Leads', 'Verdict', 'Property type', 'Doors', 'What it does', 'Cost'].map((h) => (
                    <th key={h} className="py-2 pr-3 font-normal whitespace-nowrap first:pl-3">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {d.companies.map((c) => (
                  <tr key={c.company_key} className="border-t border-line align-top">
                    <td className="max-w-48 py-2 pr-3 pl-3">
                      <span className="block truncate text-fg">{c.company_name ?? c.company_key}</span>
                      {c.website ? <ExtLink href={siteHref(c.website)}>{c.company_key}</ExtLink> : <span className="block truncate font-mono text-[10.5px] text-fg-46">{c.company_key}</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-fg tabular-nums">{fmt.format(c.leads)}</td>
                    <td className={cn('py-2 pr-3 whitespace-nowrap', c.icp_fit ? FIT_TONE[c.icp_fit] : 'text-fg-46')}>
                      {c.icp_fit ? FIT_LABEL[c.icp_fit] : c.status}
                      {c.confidence && <span className="ml-1.5 font-mono text-[11px] text-fg-46">{c.confidence}</span>}
                      {c.status === 'cached' && <span className="block text-[10.5px] text-fg-46">cached</span>}
                    </td>
                    <td className="py-2 pr-3 whitespace-nowrap text-fg-70">{c.property_type ? (TYPE_LABEL[c.property_type as PropertyType] ?? c.property_type) : '—'}</td>
                    <td className="py-2 pr-3 font-mono text-fg-70 tabular-nums">{doorsText(c.doors)}</td>
                    <td className="max-w-[24rem] py-2 pr-3 text-fg-70">
                      {c.what_it_does ?? '—'}
                      {c.error && <span className="block text-amber">{c.error}</span>}
                    </td>
                    <td className="py-2 pr-3 font-mono text-fg-46 tabular-nums">{c.status === 'cached' ? '$0 (cached)' : usdText(c.check_cost_usd, 4)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <Empty>No company checked yet.</Empty>
        )}
      </Section>
    </>
  )
}
