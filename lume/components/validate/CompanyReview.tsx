'use client'

import { useState } from 'react'
import { useSWRConfig } from 'swr'
import { toast } from 'sonner'
import { GlassCard } from '@/components/ui/glass-card'
import { SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { jobKey, previewKey, useJobProgress, usePushPreview } from '@/hooks/useJob'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'

const fmt = new Intl.NumberFormat('en-US')

/**
 * The company-name review from instantly-push's own preview: what would be
 * pushed with the current barriers, and the names mode (standard / stricter,
 * the Telegram `push_std` / `push_strict` toggle, stored as `company_strict`).
 */
export function CompanyReview({ jobId }: { jobId: string }) {
  const { mutate } = useSWRConfig()
  const { data, error, isValidating, mutate: reload } = usePushPreview(jobId)
  const { data: job } = useJobProgress(jobId)
  const [saving, setSaving] = useState(false)
  const preview = data?.preview
  const strict = job?.company_strict ?? preview?.strict ?? false

  async function setStrict(next: boolean) {
    if (next === strict) return
    setSaving(true)
    const r = await sendJson(`/api/gates/campaign/${jobId}`, { company_strict: next }, { method: 'PATCH' })
    setSaving(false)
    if (r.status === 409) toast.info('Already handled — refreshed')
    else if (r.status !== 200) toast.error("Couldn't change the names mode")
    void mutate(jobKey(jobId))
    void mutate(previewKey(jobId))
    void mutate('/api/gates')
  }

  const notes: string[] = []
  if (preview) {
    if (preview.junk > 0) notes.push(`${fmt.format(preview.junk)} junk name${preview.junk === 1 ? '' : 's'} dropped`)
    if (preview.missingFirstName > 0) notes.push(`${fmt.format(preview.missingFirstName)} with no first name`)
    if (preview.blankLocation > 0) notes.push(`${fmt.format(preview.blankLocation)} will send a blank location`)
  }

  return (
    <GlassCard className="gap-0 py-0" aria-label="Company names" aria-busy={isValidating || undefined}>
      <SectionTitle title="Company names">
        <div role="radiogroup" aria-label="Names mode" className="flex gap-1 rounded-[8px] bg-white/5 p-0.5">
          {[
            { v: false, label: 'Standard' },
            { v: true, label: 'Stricter' },
          ].map((o) => (
            <button
              key={o.label}
              type="button"
              role="radio"
              aria-checked={strict === o.v}
              disabled={saving || !job}
              onClick={() => void setStrict(o.v)}
              className={cn(
                'rounded-[6px] px-2 py-1 text-[11px] outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50',
                strict === o.v ? 'bg-accent text-fg' : 'text-fg-46 hover:text-fg'
              )}
            >
              {o.label}
            </button>
          ))}
        </div>
      </SectionTitle>
      <div className="flex flex-col gap-2 px-[18px] pb-[18px]">
        {!preview && !error && (
          <>
            <ShimmerBar className="h-3 w-1/2" />
            <ShimmerBar className="h-3 w-full" />
            <ShimmerBar className="h-3 w-5/6" />
          </>
        )}
        {error && !preview && (
          <p className="flex items-center gap-3 text-[12px] text-fg-70" role="alert">
            Couldn&apos;t build the preview.
            <button type="button" className="text-violet-soft hover:text-fg" onClick={() => void reload()}>
              Retry
            </button>
          </p>
        )}
        {preview && (
          <>
            {!preview.instantlyKeyPresent && (
              <p className="text-[11px] text-red" role="alert">
                INSTANTLY_API_KEY is not set on the Supabase edge functions — the push would fail.
              </p>
            )}
            <p className="text-[13px] text-fg">
              <span className="font-mono tabular-nums">{fmt.format(preview.eligible)}</span> ready ·{' '}
              <span className="font-mono text-fg-70 tabular-nums">{fmt.format(preview.filtered)}</span>{' '}
              <span className="text-fg-70">filtered</span>
            </p>
            {notes.length > 0 && <p className="text-[11px] text-fg-46">{notes.join(' · ')}</p>}
            {job && !job.company_barrier && <p className="text-[11px] text-fg-46">Company barrier off — names push as normalized.</p>}
            {preview.samples.length > 0 ? (
              <ol className="mt-1 flex flex-col gap-0.5 font-mono text-[11px]">
                {preview.samples.map((s, i) => (
                  <li key={i} className="flex min-w-0 gap-2">
                    <span className="w-5 shrink-0 text-right text-fg-24">{i + 1}</span>
                    <span className="truncate text-fg-70">
                      {s.normalized}
                      {s.original !== s.normalized && <span className="text-fg-24"> ← {s.original}</span>}
                    </span>
                  </li>
                ))}
              </ol>
            ) : (
              <p className="text-[11px] text-fg-46">No eligible rows.</p>
            )}
          </>
        )}
      </div>
    </GlassCard>
  )
}
