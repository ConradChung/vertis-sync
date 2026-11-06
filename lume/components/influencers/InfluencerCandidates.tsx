'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { SectionTitle, ShimmerBar } from '@/components/overview/parts'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { ago } from '@/lib/import/format'
import { cn } from '@/lib/utils'

/**
 * `/influencers` → Candidates: lists of names staged for the LinkedIn lookup
 * (import_influencer_candidates), one batch at a time. Each row: who the list
 * said (name, title, company), the profile the lookup found (only from a
 * cited source) with its confidence and evidence, and approve / reject.
 * Approving makes an INACTIVE influencer; nothing runs or is spent. "Request
 * lookup" only files the `influencer_lookup` approval (confirm it on the
 * approval card or in Telegram); it never starts the lookup itself.
 */

interface Batch {
  id: string
  name: string
  status: string
  spent_usd: number | string
  max_lookup_usd: number | string | null
  counts?: Record<string, number>
  created_at?: string
}

interface Candidate {
  id: string
  name: string
  title: string | null
  company: string | null
  category: string | null
  linkedin_url: string | null
  confidence: 'high' | 'medium' | 'not_found' | null
  evidence: { url?: string; snippet?: string } | null
  status: string
  lookup_error: string | null
  possible_duplicate_of?: string | null
}

interface BatchDetail {
  batch: Batch
  candidates: Candidate[]
  counts: Record<string, number>
  estimate: { people: number; usd: number; default_cap_usd: number }
}

const usd = (v: number | string | null | undefined) => `$${(Number(v ?? 0) || 0).toFixed(2)}`
/** The source's host for the evidence link (the URL itself when it does not parse). */
const hostOf = (u: string) => {
  try {
    return new URL(u).hostname.replace(/^www\./, '')
  } catch {
    return u.slice(0, 60)
  }
}
const shortUrl = (u: string) => u.replace(/^https?:\/\/(www\.)?/, '').replace(/\/$/, '')
const CONF_TONE: Record<string, string> = { high: 'text-green', medium: 'text-amber', not_found: 'text-fg-46' }
const STATUS_TONE: Record<string, string> = { approved: 'text-green', rejected: 'text-red', duplicate: 'text-fg-46', found: 'text-cyan', not_found: 'text-fg-46', pending_lookup: 'text-fg-70' }

export function InfluencerCandidates() {
  const batches = useSWR<{ batches: Batch[] }>('/api/influencers/candidates', fetchJson)
  const [picked, setPicked] = useState<string | null>(null)
  const batchId = picked ?? batches.data?.batches[0]?.id ?? null
  const detail = useSWR<BatchDetail>(batchId ? `/api/influencers/candidates/${batchId}` : null, fetchJson, {
    keepPreviousData: true,
    refreshInterval: (d) => (d?.batch.status === 'looking_up' ? 5_000 : 0),
  })
  const [busy, setBusy] = useState(false)

  const review = async (action: 'approve' | 'reject', ids: string[]) => {
    if (!ids.length || busy) return
    setBusy(true)
    try {
      const r = await sendJson<{ approved?: unknown[]; skipped?: { reason: string }[]; rejected?: number }>('/api/influencers/candidates/review', { action, ids })
      if (r.status !== 200 || !r.body) toast.error(`Couldn't ${action}`)
      else if (action === 'approve') {
        const n = r.body.approved?.length ?? 0
        toast.success(`${n} approved as inactive influencer${n === 1 ? '' : 's'}`, r.body.skipped?.length ? { description: `${r.body.skipped.length} skipped: ${r.body.skipped[0].reason}` } : undefined)
      } else toast.success(`${r.body.rejected ?? 0} rejected`)
    } finally {
      setBusy(false)
      void detail.mutate()
      void batches.mutate()
    }
  }

  const requestLookup = async () => {
    if (!batchId || busy) return
    setBusy(true)
    try {
      const r = await sendJson<{ error?: string }>('/api/actions', { kind: 'influencer_lookup', payload: { batch_id: batchId } })
      if (r.status === 201) toast.success('Lookup approval requested', { description: 'Confirm it on the approval card or in Telegram — nothing is spent until then.' })
      else if (r.status === 409) toast.info('A lookup approval is already waiting, or nothing is left to look up')
      else toast.error("Couldn't request the lookup")
    } finally {
      setBusy(false)
    }
  }

  if (batches.error && !batches.data) return <p className="text-[12px] text-amber" role="alert">Couldn&apos;t load the candidate lists.</p>
  if (!batches.data) return <ShimmerBar className="h-24 w-full" />
  if (!batches.data.batches.length) {
    return (
      <GlassCard className="items-center gap-2 py-10 text-center">
        <p className="text-[15px] font-semibold text-fg">No candidate lists yet</p>
        <p className="text-[12px] text-fg-46">Attach a list of names (.xlsx / .csv) in the Agent chat and ask Lume to import it as influencer candidates.</p>
      </GlassCard>
    )
  }

  const d = detail.data
  const high = d ? d.candidates.filter((c) => c.status === 'found' && c.confidence === 'high').map((c) => c.id) : []
  const pending = d?.counts.pending_lookup ?? 0

  return (
    <div className="flex flex-col gap-4">
      <nav aria-label="Candidate lists" className="flex flex-wrap gap-2">
        {batches.data.batches.map((b) => (
          <button
            key={b.id}
            type="button"
            onClick={() => setPicked(b.id)}
            aria-pressed={b.id === batchId}
            className={cn('rounded-full border border-line px-3 py-1 text-[12px] text-fg-70 hover:text-fg', b.id === batchId && 'border-primary/60 bg-accent text-fg')}
          >
            {b.name} <span className="text-fg-46">· {b.status}</span>
          </button>
        ))}
      </nav>
      {d && (
        <GlassCard className="gap-0 py-0" aria-label="Candidates">
          <SectionTitle title={d.batch.name}>
            <span>
              {d.batch.status} · {usd(d.batch.spent_usd)} spent{d.batch.max_lookup_usd != null ? ` of ${usd(d.batch.max_lookup_usd)} cap` : ''}
            </span>
          </SectionTitle>
          <div className="flex flex-wrap items-center gap-3 px-[18px] pb-3 text-[12px] text-fg-70">
            {Object.entries(d.counts).map(([k, n]) => (
              <span key={k}>
                {k.replace('_', ' ')}: <span className="font-mono text-fg">{n}</span>
              </span>
            ))}
            <span className="flex-1" />
            {pending > 0 && (d.batch.status === 'staged' || d.batch.status === 'capped') && (
              <Button size="sm" variant="secondary" disabled={busy} onClick={() => void requestLookup()}>
                Request lookup ({pending} · ~{usd(d.estimate.usd)})
              </Button>
            )}
            <Button size="sm" disabled={busy || !high.length} onClick={() => void review('approve', high)}>
              Approve all high ({high.length})
            </Button>
          </div>
          <div className="overflow-x-auto px-[18px] pb-[18px]">
            <table className="w-full text-left text-[12px]">
              <thead className="text-fg-46">
                <tr>
                  <th className="py-1.5 pr-3 font-normal">Person</th>
                  <th className="py-1.5 pr-3 font-normal">LinkedIn</th>
                  <th className="py-1.5 pr-3 font-normal">Confidence</th>
                  <th className="py-1.5 pr-3 font-normal">Evidence</th>
                  <th className="py-1.5 pr-3 font-normal">Status</th>
                  <th className="py-1.5 font-normal" />
                </tr>
              </thead>
              <tbody>
                {d.candidates.map((c) => (
                  <tr key={c.id} className="border-t border-line align-top">
                    <td className="py-2 pr-3">
                      <div className="text-fg">{c.name}</div>
                      <div className="text-fg-46">{[c.title, c.company].filter(Boolean).join(' · ')}</div>
                      {c.possible_duplicate_of && <div className="text-amber">Same name as an existing influencer — check it is not the same profile.</div>}
                    </td>
                    <td className="py-2 pr-3">
                      {c.linkedin_url ? (
                        <a href={c.linkedin_url} target="_blank" rel="noopener noreferrer" className="text-violet-soft hover:text-fg">
                          {shortUrl(c.linkedin_url)}
                        </a>
                      ) : (
                        <span className="text-fg-24">—</span>
                      )}
                    </td>
                    <td className={cn('py-2 pr-3 font-mono', CONF_TONE[c.confidence ?? ''] ?? 'text-fg-24')}>{c.confidence ?? '—'}</td>
                    <td className="max-w-[22rem] py-2 pr-3 text-fg-70">
                      {c.evidence?.url && (
                        <a href={c.evidence.url} target="_blank" rel="noopener noreferrer" className="block truncate text-violet-soft hover:text-fg">
                          source: {hostOf(c.evidence.url)}
                        </a>
                      )}
                      {c.evidence?.snippet && <span>{c.evidence.snippet}</span>}
                      {c.lookup_error && <span className="block text-amber">{c.lookup_error}</span>}
                    </td>
                    <td className={cn('py-2 pr-3', STATUS_TONE[c.status] ?? 'text-fg-70')}>{c.status.replace('_', ' ')}</td>
                    <td className="py-2 whitespace-nowrap">
                      {c.status === 'found' && (
                        <button type="button" disabled={busy} onClick={() => void review('approve', [c.id])} aria-label={`Approve ${c.name}`} className="mr-2 text-green hover:text-fg disabled:opacity-40">
                          Approve
                        </button>
                      )}
                      {(c.status === 'found' || c.status === 'not_found' || c.status === 'pending_lookup') && (
                        <button type="button" disabled={busy} onClick={() => void review('reject', [c.id])} aria-label={`Reject ${c.name}`} className="text-fg-46 hover:text-red disabled:opacity-40">
                          Reject
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </GlassCard>
      )}
      {batches.data.batches[0]?.created_at && <p className="text-[11px] text-fg-24">Newest list imported {ago(batches.data.batches[0].created_at)}.</p>}
    </div>
  )
}
