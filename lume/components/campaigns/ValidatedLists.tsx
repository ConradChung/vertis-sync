'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Eye } from 'lucide-react'
import { fetchJson } from '@/hooks/fetcher'
import { RenamableName, ValidatedPreviewDialog } from '@/components/validate/ValidatedPreview'
import type { ValidatedListRow } from '@/lib/validate/preview'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')
const day = (iso: string) => new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short' })

export const validatedListsKey = (campaignId: string) => `/api/validation-jobs?campaign_id=${encodeURIComponent(campaignId)}&unassigned=1`

function statusText(j: ValidatedListRow): string {
  if (j.unassigned) return 'Not assigned yet'
  const s = j.instantly_status
  if (s === 'done' || s === 'pushed') return 'Pushed'
  if (s === 'pushing') return 'Pushing'
  if (s === 'configuring' || s === 'reviewing_company') return 'Campaign picked'
  return s ? s.replace(/_/g, ' ') : (j.status ?? '—')
}

/**
 * Campaigns → CRM: the validated lists behind this campaign (picked or
 * pushed), plus lists still waiting for a campaign pick ("Not assigned yet"),
 * so the owner can look at a list before choosing. Click a row → the preview.
 */
export function ValidatedLists({ campaignId }: { campaignId: string }) {
  const q = useSWR<{ jobs: ValidatedListRow[] }>(validatedListsKey(campaignId), fetchJson, { keepPreviousData: true })
  const [open, setOpen] = useState<ValidatedListRow | null>(null)
  const jobs = q.data?.jobs ?? []
  if (q.error && !q.data) return <p className="text-[12px] text-fg-46" role="alert">Couldn&apos;t load the validated lists.</p>
  if (!q.data || jobs.length === 0) return null
  return (
    <section aria-label="Validated lists" className="flex flex-col gap-1.5 pb-4">
      <h3 className="text-[13px] font-medium text-fg">Validated lists</h3>
      <ul className="flex flex-col">
        {jobs.map((j) => (
          <li
            key={j.id}
            role="button"
            tabIndex={0}
            aria-label={`Preview ${j.name}`}
            onClick={() => setOpen(j)}
            onKeyDown={(e) => {
              if (e.target !== e.currentTarget) return
              if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault()
                setOpen(j)
              }
            }}
            className="group grid cursor-pointer grid-cols-[minmax(0,1fr)_auto] items-center gap-x-4 gap-y-0.5 rounded-lg px-2.5 py-2 hover:bg-white/4 focus-visible:bg-white/6 focus-visible:outline-none sm:grid-cols-[minmax(0,1fr)_64px_96px_80px_128px_20px]"
          >
            <span className="min-w-0 text-[13px] text-fg">
              <RenamableName jobId={j.id} name={j.name} />
              {j.filename && j.display_name && <span className="block truncate text-[11px] text-fg-46">{j.filename}</span>}
            </span>
            <span className="hidden text-[12px] text-fg-46 tabular-nums sm:block">{day(j.created_at)}</span>
            <span className="text-right font-mono text-[12px] text-green tabular-nums" title="Valid leads">
              {fmt.format(j.valid)} valid
            </span>
            <span className="hidden text-right font-mono text-[12px] text-red tabular-nums sm:block" title="invalid ÷ (valid + invalid)">
              {j.invalid_rate === null ? '—' : `${j.invalid_rate.toFixed(1)}%`}
            </span>
            <span className={cn('hidden truncate text-[12px] capitalize sm:block', j.unassigned ? 'text-amber' : 'text-fg-70')}>{statusText(j)}</span>
            <Eye className="hidden size-3.5 text-fg-24 group-hover:text-fg sm:block" aria-hidden />
          </li>
        ))}
      </ul>
      {open && <ValidatedPreviewDialog jobId={open.id} name={open.name} open onOpenChange={(o) => !o && setOpen(null)} />}
    </section>
  )
}
