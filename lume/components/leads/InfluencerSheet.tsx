'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { GlassCard } from '@/components/ui/glass-card'
import { ShimmerBar } from '@/components/overview/parts'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import { cn } from '@/lib/utils'
import { ExpandButton, SheetOverlay, scrollBoxClass, useSheetExpand } from '@/components/leads/SheetFrame'

/**
 * An influencer candidate batch as a sheet in Leads. The candidates stay in
 * influencer_candidates (the lookup engine reads and writes them); this is
 * their review: name, title, company, category, notes, the LinkedIn profile
 * the lookup found from a cited source, confidence, evidence, status and a
 * possible-duplicate note. "Look up LinkedIn" only files the
 * influencer_lookup approval; Approve makes INACTIVE influencers; nothing
 * runs or is spent here.
 */

interface Batch {
  id: string
  name: string
  status: string
  spent_usd: number | string
  max_lookup_usd: number | string | null
}

interface Candidate {
  id: string
  name: string
  title: string | null
  company: string | null
  category: string | null
  notes: string | null
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
const STATUS_LABEL: Record<string, string> = { pending_lookup: 'pending lookup', not_found: 'not found' }
const REJECTABLE = new Set(['found', 'not_found', 'pending_lookup'])

export function InfluencerSheet({ batchId, name }: { batchId: string; name: string }) {
  const { expanded, toggle: toggleExpanded } = useSheetExpand()
  const detail = useSWR<BatchDetail>(`/api/influencers/candidates/${batchId}`, fetchJson, {
    keepPreviousData: true,
    refreshInterval: (d) => (d?.batch?.status === 'looking_up' ? 5_000 : 0),
  })
  const [busy, setBusy] = useState(false)
  const [picked, setPicked] = useState<Set<string>>(new Set())

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
      setPicked(new Set())
      void detail.mutate()
    }
  }

  const requestLookup = async () => {
    if (busy) return
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

  if (detail.error && !detail.data) return <p className="text-[12px] text-amber" role="alert">Couldn&apos;t load this sheet.</p>
  if (!detail.data) return <ShimmerBar className="h-24 w-full" />
  const d = { ...detail.data, candidates: detail.data.candidates ?? [], counts: detail.data.counts ?? {} }
  const high = d.candidates.filter((c) => c.status === 'found' && c.confidence === 'high').map((c) => c.id)
  const pending = d.counts.pending_lookup ?? 0
  const chosen = d.candidates.filter((c) => picked.has(c.id))
  const approvable = chosen.filter((c) => c.status === 'found').map((c) => c.id)
  const rejectable = chosen.filter((c) => REJECTABLE.has(c.status)).map((c) => c.id)
  const toggle = (id: string) =>
    setPicked((s) => {
      const n = new Set(s)
      if (n.has(id)) n.delete(id)
      else n.add(id)
      return n
    })

  return (
    <GlassCard className="min-w-0 gap-0 py-0" aria-label="Influencer candidates">
      <header className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-[15px] font-medium text-fg">{name}</h2>
          <p className="text-[11.5px] text-fg-46">
            Influencer candidates · {d.batch.status} · {usd(d.batch.spent_usd)} spent{d.batch.max_lookup_usd != null ? ` of ${usd(d.batch.max_lookup_usd)} cap` : ''} ·{' '}
            {Object.entries(d.counts)
              .map(([k, n]) => `${n} ${STATUS_LABEL[k] ?? k}`)
              .join(' · ')}
          </p>
        </div>
        {pending > 0 && (d.batch.status === 'staged' || d.batch.status === 'capped') && (
          <Button size="sm" variant="secondary" disabled={busy} onClick={() => void requestLookup()}>
            Look up LinkedIn (≈{usd(d.estimate.usd)})
          </Button>
        )}
        <Button size="sm" variant="outline" disabled={busy || !approvable.length} onClick={() => void review('approve', approvable)}>
          Approve selected ({approvable.length})
        </Button>
        <Button size="sm" variant="outline" disabled={busy || !rejectable.length} onClick={() => void review('reject', rejectable)}>
          Reject selected ({rejectable.length})
        </Button>
        <Button size="sm" disabled={busy || !high.length} onClick={() => void review('approve', high)}>
          Approve all high ({high.length})
        </Button>
      </header>
      <SheetOverlay expanded={expanded}>
      <div className="flex justify-end px-4 py-2">
        <ExpandButton expanded={expanded} onClick={toggleExpanded} />
      </div>
      <div className={scrollBoxClass(expanded)}>
        <table aria-label={`${name} candidates`} className="w-full min-w-max text-left text-[12px]">
          <thead className="sticky top-0 z-10 bg-background text-fg-46">
            <tr>
              <th className="w-8 py-2 pl-4" />
              {['Name', 'Title', 'Company', 'Category', 'Notes', 'LinkedIn', 'Confidence', 'Evidence', 'Status', 'Possible duplicate'].map((h) => (
                <th key={h} className="py-2 pr-3 font-normal whitespace-nowrap">
                  {h}
                </th>
              ))}
              <th className="py-2 pr-4 font-normal" />
            </tr>
          </thead>
          <tbody>
            {d.candidates.map((c) => (
              <tr key={c.id} className="border-t border-line align-top">
                <td className="py-2 pl-4">
                  <input type="checkbox" aria-label={`Select ${c.name}`} checked={picked.has(c.id)} onChange={() => toggle(c.id)} />
                </td>
                <td className="py-2 pr-3 text-fg">{c.name}</td>
                <td className="max-w-48 py-2 pr-3 text-fg-70">{c.title ?? '—'}</td>
                <td className="max-w-48 py-2 pr-3 text-fg-70">{c.company ?? '—'}</td>
                <td className="py-2 pr-3 text-fg-70">{c.category ?? '—'}</td>
                <td className="max-w-56 truncate py-2 pr-3 text-fg-70" title={c.notes ?? ''}>
                  {c.notes ?? '—'}
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
                <td className={cn('py-2 pr-3 whitespace-nowrap', STATUS_TONE[c.status] ?? 'text-fg-70')}>{STATUS_LABEL[c.status] ?? c.status}</td>
                <td className="max-w-56 py-2 pr-3">
                  {c.possible_duplicate_of ? <span className="text-amber">Same name as an existing influencer — check it is not the same profile.</span> : <span className="text-fg-24">—</span>}
                </td>
                <td className="py-2 pr-4 whitespace-nowrap">
                  {c.status === 'found' && (
                    <button type="button" disabled={busy} onClick={() => void review('approve', [c.id])} aria-label={`Approve ${c.name}`} className="mr-2 text-green hover:text-fg disabled:opacity-40">
                      Approve
                    </button>
                  )}
                  {REJECTABLE.has(c.status) && (
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
      </SheetOverlay>
    </GlassCard>
  )
}
