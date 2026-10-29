'use client'

import { useMemo, useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import type { LumeCampaignRow } from '@/lib/db/types'
import type { InstantlyCampaign } from '@/lib/adapters/instantly.map'
import { WebhookPanel } from '@/components/settings/WebhookPanel'
import { VERTICAL_SCOPES, type Operator, type Vertical, type VerticalScope } from '@/lib/operators/types'

/**
 * Settings → Verticals (Phase G6): create, edit (name, scopes, campaigns,
 * default) and archive verticals; mint Grok Bot operator keys (shown once,
 * with the full sign-in link and a copy button); list keys with last check-in
 * and revoke. A Grok Bot session (`canManageKeys` false) sees the keys but
 * cannot mint or revoke (the routes refuse it too).
 */

interface CampaignOption {
  id: string
  name: string
  source: 'registry' | 'instantly'
}

const ERRORS: Record<string, string> = {
  duplicate_name: 'A vertical with that name already exists.',
  default_taken: 'Another vertical is already the default; unset it first.',
  operator_forbidden: 'A Grok Bot session cannot mint or revoke keys.',
  session_required: 'Only your own browser session can do that.',
  vertical_not_found: 'That vertical no longer exists.',
  name_taken: 'A project with the Inbox name already exists but is not linked to this vertical; link it in Agent → Projects.',
  vertical_out_of_scope: 'A vertical Grok Bot can only do that for its own vertical.',
}
const errorText = (status: number, body: unknown) => {
  const code = (body as { error?: string } | null)?.error
  return (code && ERRORS[code]) || code || `Request failed (HTTP ${status})`
}

function relative(iso: string | null): string {
  if (!iso) return 'never'
  const mins = Math.round((Date.now() - new Date(iso).getTime()) / 60_000)
  if (mins < 1) return 'just now'
  if (mins < 60) return `${mins} min ago`
  const h = Math.round(mins / 60)
  return h < 48 ? `${h} h ago` : `${Math.round(h / 24)} d ago`
}

export function VerticalsSettings({ canManageKeys }: { canManageKeys: boolean }) {
  const verticals = useSWR<{ verticals: Vertical[] }>('/api/verticals?archived=1', fetchJson)
  const operators = useSWR<{ operators: Operator[] }>('/api/operators', fetchJson)
  const registry = useSWR<LumeCampaignRow[]>('/api/campaigns', fetchJson)
  const instantly = useSWR<{ configured: boolean; campaigns?: InstantlyCampaign[] }>('/api/instantly/campaigns', fetchJson)
  const [error, setError] = useState<string | null>(null)
  const [minted, setMinted] = useState<{ label: string; url: string } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const options = useMemo<CampaignOption[]>(() => {
    const out = new Map<string, CampaignOption>()
    for (const c of registry.data ?? []) if (c.external_id) out.set(c.external_id, { id: c.external_id, name: c.name, source: 'registry' })
    for (const c of instantly.data?.campaigns ?? []) if (!out.has(c.id)) out.set(c.id, { id: c.id, name: c.name, source: 'instantly' })
    return [...out.values()].sort((a, b) => a.name.localeCompare(b.name))
  }, [registry.data, instantly.data])

  const refresh = () => {
    void verticals.mutate()
    void operators.mutate()
  }

  async function call(url: string, body: unknown, method = 'POST'): Promise<unknown | null> {
    setError(null)
    const r = await sendJson(url, body, { method })
    if (r.status >= 200 && r.status < 300) {
      refresh()
      return r.body
    }
    setError(errorText(r.status, r.body))
    return null
  }

  async function inboxProject(v: Vertical) {
    setError(null)
    setNotice(null)
    const r = await sendJson(`/api/verticals/${v.id}/inbox-project`, {})
    const b = r.body as { project?: { name: string }; created_project?: boolean; seeded?: string[]; error?: string } | null
    if (r.status === 200 || r.status === 201) {
      const seeded = b?.seeded ?? []
      setNotice(
        `${b?.created_project ? 'Created' : 'Already there:'} “${b?.project?.name}”. ` +
          (seeded.length ? `Added ${seeded.join(', ')}.` : 'All five notes were already there; nothing was overwritten.') +
          ' Fill the {{placeholders}} in Agent → Projects.'
      )
      return
    }
    if (b?.error === 'vertical_has_project') {
      setError(`“${v.name}” is already linked to the project “${b.project?.name}”. Unlink it in Agent → Projects first, or add the notes there by hand.`)
      return
    }
    setError(errorText(r.status, r.body))
  }

  async function mint(target: { vertical_id: string } | { master: true }, label: string) {
    const body = (await call('/api/operators', { ...target, label })) as { sign_in_url?: string } | null
    if (body?.sign_in_url) setMinted({ label, url: body.sign_in_url })
  }

  const all = verticals.data?.verticals ?? []
  const live = all.filter((v) => !v.archived_at)
  const keys = operators.data?.operators ?? []
  const nameOf = (id: string | null) => all.find((v) => v.id === id)?.name ?? '—'

  return (
    <div className="flex max-w-5xl flex-col gap-8">
      {error && (
        <p role="alert" className="rounded-lg border border-destructive/50 px-3 py-2 text-sm text-destructive">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="rounded-lg border border-primary/50 px-3 py-2 text-sm">
          {notice}
        </p>
      )}
      {minted && (
        <section aria-labelledby="new-key" className="rounded-lg border border-primary/60 p-4">
          <h2 id="new-key" className="text-base font-semibold">
            Sign-in link for “{minted.label}”
          </h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Shown once. Copy it into the Grok Bot’s instructions now; Lume keeps only a hash. Anyone with this link has your full owner rights.
          </p>
          <div className="mt-3 flex gap-2">
            <Input readOnly value={minted.url} aria-label="Sign-in link" onFocus={(e) => e.currentTarget.select()} />
            <Button onClick={() => void navigator.clipboard?.writeText(minted.url)}>Copy</Button>
            <Button variant="outline" onClick={() => setMinted(null)}>
              Done
            </Button>
          </div>
        </section>
      )}

      <section aria-labelledby="verticals-h">
        <h2 id="verticals-h" className="mb-3 text-lg font-semibold">
          Verticals
        </h2>
        {verticals.error && <p className="text-sm text-destructive">Could not load verticals.</p>}
        <div className="flex flex-col gap-4">
          {live.map((v) => (
            <div key={v.id} className="flex flex-col">
              <VerticalEditor
                key={`${v.id}:${v.name}:${v.campaign_ids.join(',')}:${v.scopes.join(',')}:${v.is_default}`}
                vertical={v}
                options={options}
                canManageKeys={canManageKeys}
                onSave={(patch) => call(`/api/verticals/${v.id}`, patch, 'PATCH')}
                onArchive={() => {
                  if (confirm(`Archive “${v.name}”? Its bots keep their keys until you revoke them.`)) void call(`/api/verticals/${v.id}`, { archived: true }, 'PATCH')
                }}
                onMint={(label) => mint({ vertical_id: v.id }, label)}
                onInboxProject={() => void inboxProject(v)}
              />
              <div className="rounded-b-lg border border-t-0 border-border px-4 pb-3">
                <WebhookPanel verticalId={v.id} verticalName={v.name} canManage={canManageKeys} />
              </div>
            </div>
          ))}
          <VerticalEditor key="new" vertical={null} options={options} canManageKeys={false} onSave={(v) => call('/api/verticals', v)} />
        </div>
        {all.some((v) => v.archived_at) && (
          <p className="mt-3 text-xs text-muted-foreground">
            Archived: {all.filter((v) => v.archived_at).map((v) => v.name).join(', ')}
          </p>
        )}
      </section>

      <section aria-labelledby="keys-h">
        <div className="mb-3 flex items-center justify-between">
          <h2 id="keys-h" className="text-lg font-semibold">
            Operator keys
          </h2>
          {canManageKeys && (
            <MintButton label="New master key" defaultLabel="Master bot" onMint={(label) => mint({ master: true }, label)} />
          )}
        </div>
        {!canManageKeys && <p className="mb-2 text-sm text-muted-foreground">Signed in as a Grok Bot: you can view keys but not mint or revoke them.</p>}
        <table className="w-full text-sm">
          <thead className="text-left text-muted-foreground">
            <tr>
              <th className="py-1 pr-3 font-medium">Label</th>
              <th className="py-1 pr-3 font-medium">Vertical</th>
              <th className="py-1 pr-3 font-medium">Last check-in</th>
              <th className="py-1 pr-3 font-medium">Created</th>
              <th className="py-1 font-medium">Status</th>
            </tr>
          </thead>
          <tbody>
            {keys.map((k) => (
              <tr key={k.id} className="border-t border-border">
                <td className="py-1.5 pr-3">{k.label}</td>
                <td className="py-1.5 pr-3">{k.is_master ? 'Master (all verticals)' : nameOf(k.vertical_id)}</td>
                <td className="py-1.5 pr-3">{relative(k.last_seen_at)}</td>
                <td className="py-1.5 pr-3">{k.created_at.slice(0, 10)}</td>
                <td className="py-1.5">
                  {k.revoked_at ? (
                    <span className="text-muted-foreground">Revoked {k.revoked_at.slice(0, 10)}</span>
                  ) : canManageKeys ? (
                    <Button
                      size="xs"
                      variant="destructive"
                      onClick={() => {
                        if (confirm(`Revoke “${k.label}”? Its bot is signed out at once.`)) void call(`/api/operators/${k.id}/revoke`, {})
                      }}
                    >
                      Revoke
                    </Button>
                  ) : (
                    'Live'
                  )}
                </td>
              </tr>
            ))}
            {keys.length === 0 && (
              <tr>
                <td colSpan={5} className="py-2 text-muted-foreground">
                  No keys yet.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </section>
    </div>
  )
}

function MintButton({ label, defaultLabel, onMint }: { label: string; defaultLabel: string; onMint: (label: string) => void }) {
  const [open, setOpen] = useState(false)
  const [name, setName] = useState(defaultLabel)
  if (!open) {
    return (
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        {label}
      </Button>
    )
  }
  return (
    <span className="flex items-center gap-2">
      <Input className="w-48" value={name} onChange={(e) => setName(e.target.value)} aria-label="Key label" />
      <Button
        size="sm"
        disabled={!name.trim()}
        onClick={() => {
          onMint(name.trim())
          setOpen(false)
        }}
      >
        Generate
      </Button>
      <Button size="sm" variant="ghost" onClick={() => setOpen(false)}>
        Cancel
      </Button>
    </span>
  )
}

function VerticalEditor({
  vertical,
  options,
  canManageKeys,
  onSave,
  onArchive,
  onMint,
  onInboxProject,
}: {
  vertical: Vertical | null
  options: CampaignOption[]
  canManageKeys: boolean
  onSave: (v: { name: string; scopes: VerticalScope[]; campaign_ids: string[]; is_default: boolean }) => Promise<unknown>
  onArchive?: () => void
  onMint?: (label: string) => void
  onInboxProject?: () => void
}) {
  const [name, setName] = useState(vertical?.name ?? '')
  const [scopes, setScopes] = useState<VerticalScope[]>(vertical?.scopes ?? [])
  const [campaigns, setCampaigns] = useState<string[]>(vertical?.campaign_ids ?? [])
  const [isDefault, setIsDefault] = useState(vertical?.is_default ?? false)
  const [extra, setExtra] = useState('')
  const known = new Set(options.map((o) => o.id))
  const unknown = campaigns.filter((c) => !known.has(c))
  const toggle = <T,>(xs: T[], x: T) => (xs.includes(x) ? xs.filter((y) => y !== x) : [...xs, x])

  return (
    <form
      className="rounded-lg border border-border p-4"
      onSubmit={async (e) => {
        e.preventDefault()
        const done = await onSave({ name: name.trim(), scopes, campaign_ids: campaigns, is_default: isDefault })
        if (done && !vertical) {
          setName('')
          setScopes([])
          setCampaigns([])
          setIsDefault(false)
        }
      }}
    >
      <div className="flex flex-wrap items-center gap-3">
        <Input className="w-64" value={name} onChange={(e) => setName(e.target.value)} placeholder={vertical ? 'Name' : 'New vertical name'} aria-label="Vertical name" />
        <label className="flex items-center gap-1.5 text-sm">
          <input type="checkbox" checked={isDefault} onChange={(e) => setIsDefault(e.target.checked)} /> Default (gets unrouted items)
        </label>
        <div className="ml-auto flex gap-2">
          <Button type="submit" size="sm" disabled={!name.trim()}>
            {vertical ? 'Save' : 'Create vertical'}
          </Button>
          {vertical && onInboxProject && (
            <Button type="button" size="sm" variant="outline" onClick={onInboxProject} title="Creates “<vertical> · Inbox” with the five Inbox Manager notes; never overwrites a note">
              Create Inbox project
            </Button>
          )}
          {vertical && canManageKeys && onMint && <MintButton label="Generate key" defaultLabel={`${vertical.name} bot`} onMint={onMint} />}
          {vertical && onArchive && (
            <Button type="button" size="sm" variant="ghost" onClick={onArchive}>
              Archive
            </Button>
          )}
        </div>
      </div>
      <fieldset className="mt-3 flex flex-wrap gap-3 text-sm">
        <legend className="mb-1 text-xs text-muted-foreground">Scopes (route items with no campaign)</legend>
        {VERTICAL_SCOPES.map((s) => (
          <label key={s} className="flex items-center gap-1.5">
            <input type="checkbox" checked={scopes.includes(s)} onChange={() => setScopes(toggle(scopes, s))} /> {s}
          </label>
        ))}
      </fieldset>
      <fieldset className="mt-3 text-sm">
        <legend className="mb-1 text-xs text-muted-foreground">Campaigns ({campaigns.length})</legend>
        <div className="grid max-h-48 grid-cols-1 gap-1 overflow-y-auto sm:grid-cols-2">
          {options.map((o) => (
            <label key={o.id} className="flex items-center gap-1.5">
              <input type="checkbox" checked={campaigns.includes(o.id)} onChange={() => setCampaigns(toggle(campaigns, o.id))} />
              <span className="truncate" title={o.id}>
                {o.name}
              </span>
            </label>
          ))}
          {unknown.map((id) => (
            <label key={id} className="flex items-center gap-1.5">
              <input type="checkbox" checked onChange={() => setCampaigns(campaigns.filter((c) => c !== id))} />
              <span className="truncate text-muted-foreground">{id}</span>
            </label>
          ))}
        </div>
        <div className="mt-2 flex gap-2">
          <Input className="w-72" value={extra} onChange={(e) => setExtra(e.target.value)} placeholder="Other campaign id (e.g. gmail:recruiter)" aria-label="Other campaign id" />
          <Button
            type="button"
            size="sm"
            variant="outline"
            disabled={!/^[A-Za-z0-9_:-]{1,80}$/.test(extra.trim())}
            onClick={() => {
              setCampaigns([...new Set([...campaigns, extra.trim()])])
              setExtra('')
            }}
          >
            Add
          </Button>
        </div>
      </fieldset>
    </form>
  )
}
