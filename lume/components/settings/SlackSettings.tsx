'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import type { LumeCampaignRow } from '@/lib/db/types'
import type { InstantlyCampaign } from '@/lib/adapters/instantly.map'
import type { Vertical } from '@/lib/operators/types'
import { CARD_FIELDS, FIELD_LABEL, type CardField } from '@/lib/slack/card'

/**
 * Settings → Slack (3g), owner only (`canManage` false = a Grok Bot session:
 * read-only; the routes refuse it too). The install link to send a client,
 * the installed workspaces (with Revoke), and the channel bindings: which
 * vertical and campaigns each channel sees, and which lead-card fields.
 */

interface Install {
  team_id: string
  team_name: string | null
  created_at: string
  revoked_at: string | null
}
interface Binding {
  id: string
  team_id: string
  channel_id: string
  channel_name: string | null
  vertical_id: string
  campaign_ids: string[]
  visible_fields: string[]
  active: boolean
}
interface SlackChannel {
  id: string
  name: string
  is_private: boolean
  is_member: boolean
}
interface InstallsResponse {
  configured: boolean
  missing: string[]
  installs: Install[]
  bindings: Binding[]
}

const ERRORS: Record<string, string> = {
  slack_not_configured: 'The Slack app is not configured yet (see the env vars above).',
  operator_forbidden: 'A Grok Bot session cannot change Slack settings.',
  session_required: 'Only your own browser session can do that.',
  not_installed: 'That workspace is not installed (or was revoked).',
  vertical_not_found: 'That vertical no longer exists.',
  campaign_not_in_vertical: 'A chosen campaign is not in that vertical any more.',
  slack_error: 'Slack refused the request.',
}
const errorText = (status: number, body: unknown) => {
  const b = body as { error?: string; code?: string } | null
  const base = (b?.error && ERRORS[b.error]) || b?.error || `Request failed (HTTP ${status})`
  return b?.code ? `${base} (${b.code})` : base
}

interface Draft {
  team_id: string
  channel_id: string
  channel_name: string | null
  vertical_id: string
  campaign_ids: string[]
  visible_fields: CardField[]
  active: boolean
}

export function SlackSettings({ canManage }: { canManage: boolean }) {
  const data = useSWR<InstallsResponse>('/api/slack/installs', fetchJson)
  const verticals = useSWR<{ verticals: Vertical[] }>('/api/verticals', fetchJson)
  const registry = useSWR<LumeCampaignRow[]>('/api/campaigns', fetchJson)
  const instantly = useSWR<{ configured: boolean; campaigns?: InstantlyCampaign[] }>('/api/instantly/campaigns', fetchJson)
  const [error, setError] = useState<string | null>(null)
  const [link, setLink] = useState<{ url: string; expires_at: string } | null>(null)
  const [days, setDays] = useState('7')
  const [draft, setDraft] = useState<Draft | null>(null)
  const [channels, setChannels] = useState<{ team: string; list: SlackChannel[] } | null>(null)
  const [busy, setBusy] = useState(false)

  const campaignName = useMemo(() => {
    const m = new Map<string, string>()
    for (const c of registry.data ?? []) if (c.external_id) m.set(c.external_id, c.name)
    for (const c of instantly.data?.campaigns ?? []) if (!m.has(c.id)) m.set(c.id, c.name)
    return (id: string) => m.get(id) ?? id
  }, [registry.data, instantly.data])

  const cfg = data.data
  const installs = cfg?.installs ?? []
  const bindings = cfg?.bindings ?? []
  const live = (verticals.data?.verticals ?? []).filter((v) => !v.archived_at)
  const verticalName = (id: string) => live.find((v) => v.id === id)?.name ?? 'archived vertical'
  const teamName = (id: string) => installs.find((i) => i.team_id === id)?.team_name ?? id

  async function call(url: string, body: unknown, method = 'POST'): Promise<unknown | null> {
    setError(null)
    setBusy(true)
    try {
      const r = await sendJson(url, body, { method })
      if (r.status >= 200 && r.status < 300) {
        void data.mutate()
        return r.body ?? {}
      }
      setError(errorText(r.status, r.body))
      return null
    } finally {
      setBusy(false)
    }
  }

  async function loadChannels(team: string) {
    setError(null)
    try {
      const r = await fetchJson<{ channels: SlackChannel[] }>(`/api/slack/installs/${team}/channels`)
      setChannels({ team, list: r.channels })
    } catch (err) {
      setError(err instanceof Error ? (ERRORS[err.message] ?? err.message) : 'Could not list the channels.')
    }
  }

  function startBinding(team: string) {
    setDraft({ team_id: team, channel_id: '', channel_name: null, vertical_id: live[0]?.id ?? '', campaign_ids: [], visible_fields: [...CARD_FIELDS], active: true })
    void loadChannels(team)
  }

  function editBinding(b: Binding) {
    const { id: _id, ...rest } = b
    void _id
    setDraft({ ...rest, visible_fields: CARD_FIELDS.filter((f) => b.visible_fields.includes(f)) })
    void loadChannels(b.team_id)
  }

  async function saveDraft() {
    if (!draft) return
    if (!draft.channel_id || !draft.vertical_id) {
      setError('Pick a channel and a vertical.')
      return
    }
    if (await call('/api/slack/channels', draft, 'PUT')) setDraft(null)
  }

  const toggle = <T,>(list: T[], v: T) => (list.includes(v) ? list.filter((x) => x !== v) : [...list, v])
  const draftVertical = live.find((v) => v.id === draft?.vertical_id)

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/50 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}

      {cfg && !cfg.configured && (
        <section role="status" className="rounded-lg border border-border p-4 text-sm">
          <h2 className="text-base font-semibold">Slack app not configured</h2>
          <p className="mt-1 text-muted-foreground">
            Nothing is posted and the Slack routes answer 503 until these are set on Vercel: <code>{cfg.missing.join(', ')}</code>. Steps:{' '}
            <code>docs/lume/SLACK-CLIENT-SETUP.md</code>.
          </p>
        </section>
      )}

      <section aria-labelledby="slack-link" className="flex flex-col gap-2">
        <h2 id="slack-link" className="text-base font-semibold">
          Install link
        </h2>
        <p className="text-sm text-muted-foreground">
          Send this to a client. It opens Slack’s “Add to Slack” for their own workspace and expires after the days you choose. A new workspace sees nothing until you bind one of its channels below.
        </p>
        <div className="flex flex-wrap items-center gap-2">
          <label className="flex items-center gap-1.5 text-sm">
            Valid for
            <Input className="w-16" type="number" min={1} max={30} value={days} onChange={(e) => setDays(e.target.value)} aria-label="Days the link is valid" />
            days
          </label>
          <Button
            disabled={!canManage || !cfg?.configured || busy}
            onClick={async () => {
              const b = (await call('/api/slack/install-link', { days: Math.min(30, Math.max(1, Number(days) || 7)) })) as { url?: string; expires_at?: string } | null
              if (b?.url && b.expires_at) setLink({ url: b.url, expires_at: b.expires_at })
            }}
          >
            Generate link
          </Button>
        </div>
        {link && (
          <div className="flex flex-wrap items-center gap-2">
            <Input readOnly value={link.url} aria-label="Install link" onFocus={(e) => e.currentTarget.select()} className="min-w-0 flex-1" />
            <Button variant="outline" onClick={() => void navigator.clipboard?.writeText(link.url)}>
              Copy
            </Button>
            <span className="text-xs text-muted-foreground">expires {new Date(link.expires_at).toLocaleString()}</span>
          </div>
        )}
      </section>

      <section aria-labelledby="slack-installs" className="flex flex-col gap-2">
        <h2 id="slack-installs" className="text-base font-semibold">
          Workspaces
        </h2>
        {!installs.length && <p className="text-sm text-muted-foreground">No workspace has installed Lume yet.</p>}
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {installs.map((i) => (
            <li key={i.team_id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
              <span className="font-medium">{i.team_name ?? i.team_id}</span>
              <code className="text-xs text-muted-foreground">{i.team_id}</code>
              <span className={i.revoked_at ? 'text-destructive' : 'text-muted-foreground'}>
                {i.revoked_at ? `revoked ${new Date(i.revoked_at).toLocaleDateString()}` : `installed ${new Date(i.created_at).toLocaleDateString()}`}
              </span>
              <span className="ml-auto flex gap-2">
                {!i.revoked_at && (
                  <>
                    <Button size="sm" variant="outline" disabled={!canManage || !cfg?.configured} onClick={() => startBinding(i.team_id)}>
                      Bind a channel
                    </Button>
                    <Button
                      size="sm"
                      variant="destructive"
                      disabled={!canManage || busy}
                      onClick={() => {
                        if (window.confirm(`Revoke Lume in “${i.team_name ?? i.team_id}”? Nothing is posted or approved from there again until they reinstall.`)) {
                          void call(`/api/slack/installs/${i.team_id}/revoke`, {})
                        }
                      }}
                    >
                      Revoke
                    </Button>
                  </>
                )}
              </span>
            </li>
          ))}
        </ul>
      </section>

      {draft && (
        <section aria-labelledby="slack-bind" className="flex flex-col gap-3 rounded-lg border border-primary/60 p-4 text-sm">
          <h2 id="slack-bind" className="text-base font-semibold">
            Bind a channel in {teamName(draft.team_id)}
          </h2>
          <label className="flex flex-col gap-1">
            Channel
            <select
              className="rounded-md border border-border bg-transparent px-2 py-1"
              value={draft.channel_id}
              onChange={(e) => {
                const c = channels?.list.find((x) => x.id === e.target.value)
                setDraft({ ...draft, channel_id: e.target.value, channel_name: c?.name ?? draft.channel_name })
              }}
            >
              <option value="">{channels?.team === draft.team_id ? 'Pick a channel' : 'Loading channels…'}</option>
              {draft.channel_id && !channels?.list.some((c) => c.id === draft.channel_id) && <option value={draft.channel_id}>#{draft.channel_name ?? draft.channel_id}</option>}
              {(channels?.team === draft.team_id ? channels.list : []).map((c) => (
                <option key={c.id} value={c.id}>
                  {c.is_private ? '🔒' : '#'}
                  {c.name}
                  {c.is_member ? '' : ' (invite @Lume first)'}
                </option>
              ))}
            </select>
            <span className="text-xs text-muted-foreground">Private channels appear once the client has invited @Lume. Lume can only post where it is a member.</span>
          </label>
          <label className="flex flex-col gap-1">
            Vertical
            <select className="rounded-md border border-border bg-transparent px-2 py-1" value={draft.vertical_id} onChange={(e) => setDraft({ ...draft, vertical_id: e.target.value, campaign_ids: [] })}>
              {live.map((v) => (
                <option key={v.id} value={v.id}>
                  {v.name}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="flex flex-col gap-1">
            <legend>Campaigns (none ticked = all of the vertical’s)</legend>
            {(draftVertical?.campaign_ids ?? []).map((c) => (
              <label key={c} className="flex items-center gap-2">
                <input type="checkbox" checked={draft.campaign_ids.includes(c)} onChange={() => setDraft({ ...draft, campaign_ids: toggle(draft.campaign_ids, c) })} />
                {campaignName(c)}
              </label>
            ))}
            {!draftVertical?.campaign_ids.length && <span className="text-muted-foreground">This vertical has no campaigns yet.</span>}
          </fieldset>
          <fieldset className="flex flex-wrap gap-x-4 gap-y-1">
            <legend className="w-full">Lead-card fields the client sees</legend>
            {CARD_FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-1.5">
                <input type="checkbox" checked={draft.visible_fields.includes(f)} onChange={() => setDraft({ ...draft, visible_fields: CARD_FIELDS.filter((x) => (x === f ? !draft.visible_fields.includes(f) : draft.visible_fields.includes(x))) })} />
                {FIELD_LABEL[f]}
              </label>
            ))}
          </fieldset>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={draft.active} onChange={() => setDraft({ ...draft, active: !draft.active })} />
            Active (new positive replies are posted here)
          </label>
          <div className="flex gap-2">
            <Button disabled={!canManage || busy} onClick={() => void saveDraft()}>
              Save binding
            </Button>
            <Button variant="outline" onClick={() => setDraft(null)}>
              Cancel
            </Button>
          </div>
        </section>
      )}

      <section aria-labelledby="slack-bindings" className="flex flex-col gap-2">
        <h2 id="slack-bindings" className="text-base font-semibold">
          Channel bindings
        </h2>
        <p className="text-sm text-muted-foreground">
          Each positive reply on a bound campaign is posted with its lead card and draft. Approve / Edit / Skip appear only for campaigns in Client reply mode (set per campaign in Settings → Verticals).
        </p>
        {!bindings.length && <p className="text-sm text-muted-foreground">No channel is bound yet.</p>}
        <ul className="flex flex-col divide-y divide-border rounded-lg border border-border">
          {bindings.map((b) => (
            <li key={b.id} className="flex flex-col gap-1 px-3 py-2 text-sm">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-medium">#{b.channel_name ?? b.channel_id}</span>
                <span className="text-muted-foreground">in {teamName(b.team_id)}</span>
                <span>→ {verticalName(b.vertical_id)}</span>
                {!b.active && <span className="text-destructive">paused</span>}
                <span className="ml-auto flex gap-2">
                  <Button size="sm" variant="outline" disabled={!canManage || !cfg?.configured} onClick={() => editBinding(b)}>
                    Edit
                  </Button>
                  <Button size="sm" variant="outline" disabled={!canManage || busy || !cfg?.configured} onClick={() => void call('/api/slack/channels', { ...b, active: !b.active, id: undefined }, 'PUT')}>
                    {b.active ? 'Pause' : 'Resume'}
                  </Button>
                  <Button
                    size="sm"
                    variant="destructive"
                    disabled={!canManage || busy}
                    onClick={() => {
                      if (window.confirm(`Unbind #${b.channel_name ?? b.channel_id}? Nothing more is posted there.`)) void call(`/api/slack/channels/${b.id}`, {}, 'DELETE')
                    }}
                  >
                    Remove
                  </Button>
                </span>
              </div>
              <div className="text-xs text-muted-foreground">
                Campaigns: {b.campaign_ids.length ? b.campaign_ids.map(campaignName).join(', ') : 'all of the vertical’s'} · Fields:{' '}
                {b.visible_fields.length ? CARD_FIELDS.filter((f) => b.visible_fields.includes(f)).map((f) => FIELD_LABEL[f]).join(', ') : 'none'}
              </div>
            </li>
          ))}
        </ul>
      </section>
    </div>
  )
}
