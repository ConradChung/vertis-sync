'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import type { ReplyMode } from '@/lib/inbox/replyMode'

/**
 * The per-campaign reply approval mode (inbox manager 3e): a selector on the
 * Campaigns tab and in Settings → Verticals. Only the owner's own browser
 * session can change it (the route refuses a Grok Bot and the agent);
 * `canChange` false shows it read-only.
 */

export const REPLY_MODE_LABEL: Record<ReplyMode, string> = {
  owner: 'Owner approves',
  client: 'Client approves (Slack)',
  auto: 'Auto (send grant)',
}

export const CLIENT_MODE_NOTE = 'The client approves, edits or skips each reply in their Slack channel (Settings → Slack); you can still approve. A client never approves their own edit.'
export const AUTO_MODE_NOTE = 'Replies with a verdict of GOOD are sent without an approval, after the live thread re-check. BAD, unsubscribe and hostile replies still wait for you.'

interface ReplyModesResponse {
  modes: { campaign_id: string; mode: ReplyMode }[]
}

/** The stored modes (a campaign not listed is `owner`) and a setter. */
export function useReplyModes() {
  const swr = useSWR<ReplyModesResponse>('/api/campaigns/reply-mode', fetchJson)
  const [error, setError] = useState<string | null>(null)
  const modes = new Map((swr.data?.modes ?? []).map((m) => [m.campaign_id, m.mode]))
  const modeOf = (id: string): ReplyMode => modes.get(id) ?? 'owner'
  async function setMode(campaignId: string, mode: ReplyMode): Promise<boolean> {
    setError(null)
    const r = await sendJson('/api/campaigns/reply-mode', { campaign_id: campaignId, mode }, { method: 'PUT' })
    if (r.status === 200) {
      void swr.mutate()
      return true
    }
    const code = (r.body as { error?: string } | null)?.error
    setError(code === 'operator_forbidden' || code === 'session_required' ? 'Only your own browser session can change a reply mode.' : `Could not change the reply mode (${code ?? `HTTP ${r.status}`}).`)
    return false
  }
  return { modeOf, setMode, error, loaded: !!swr.data }
}

export function ReplyModeSelect({
  campaignId,
  campaignName,
  mode,
  canChange,
  onChange,
}: {
  campaignId: string
  campaignName: string
  mode: ReplyMode
  canChange: boolean
  onChange: (campaignId: string, mode: ReplyMode) => Promise<boolean> | void
}) {
  return (
    <span className="inline-flex flex-col gap-0.5" onClick={(e) => e.stopPropagation()} onKeyDown={(e) => e.stopPropagation()}>
      <select
        aria-label={`Reply approval for ${campaignName}`}
        className="rounded-md border border-border bg-transparent px-1.5 py-0.5 text-[12px]"
        value={mode}
        disabled={!canChange}
        title={canChange ? undefined : 'Only your own browser session can change this'}
        onChange={(e) => {
          const next = e.target.value as ReplyMode
          if (next === 'auto' && !window.confirm(`Turn on Auto for “${campaignName}”? ${AUTO_MODE_NOTE}`)) return
          void onChange(campaignId, next)
        }}
      >
        {(Object.keys(REPLY_MODE_LABEL) as ReplyMode[]).map((m) => (
          <option key={m} value={m}>
            {REPLY_MODE_LABEL[m]}
          </option>
        ))}
      </select>
      {mode === 'client' && <span className="text-[11px] text-fg-46">the client approves in Slack, or you</span>}
    </span>
  )
}

/** Settings: every Instantly campaign with its reply mode. */
export function ReplyModesSettings({ canChange }: { canChange: boolean }) {
  const instantly = useSWR<{ configured: boolean; campaigns?: { id: string; name: string }[] }>('/api/instantly/campaigns', fetchJson)
  const { modeOf, setMode, error } = useReplyModes()
  const campaigns = [...(instantly.data?.campaigns ?? [])].sort((a, b) => a.name.localeCompare(b.name))
  return (
    <section aria-labelledby="reply-modes-h">
      <h2 id="reply-modes-h" className="mb-1 text-lg font-semibold">
        Reply approval
      </h2>
      <p className="mb-3 text-sm text-muted-foreground">
        Who approves an email reply to a lead, per campaign. Owner (default): you, /operator or a Grok Bot (never a bot&apos;s own draft). Client: {CLIENT_MODE_NOTE} Auto: {AUTO_MODE_NOTE}
      </p>
      {!canChange && <p className="mb-2 text-sm text-muted-foreground">Signed in as a Grok Bot: you can see the modes but not change them.</p>}
      {error && (
        <p role="alert" className="mb-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {instantly.data && !instantly.data.configured && <p className="text-sm text-muted-foreground">Instantly is not connected.</p>}
      <table className="w-full text-sm">
        <tbody>
          {campaigns.map((c) => (
            <tr key={c.id} className="border-t border-border">
              <td className="py-1.5 pr-3">
                <span title={c.id}>{c.name}</span>
              </td>
              <td className="py-1.5">
                <ReplyModeSelect campaignId={c.id} campaignName={c.name} mode={modeOf(c.id)} canChange={canChange} onChange={setMode} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
