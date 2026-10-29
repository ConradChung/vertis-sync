'use client'

import { useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'
import type { WebhookView } from '@/lib/webhooks/store'

/**
 * A vertical's outbound webhook (inbox manager 3f): the Grok routine Lume
 * pushes to on a positive reply, a new confirmation or a draft awaiting
 * approval. The secret is shown masked; a generated one is shown once.
 * Only the owner's own session can change it or send a test (`canManage`).
 */

const ERR: Record<string, string> = {
  https_only: 'The URL must start with https://.',
  private_host: 'Use a public host name (no localhost, private or IP-address hosts).',
  no_credentials: 'Leave user and password out of the URL.',
  invalid_url: 'That is not a valid URL.',
  operator_forbidden: 'A Grok Bot session cannot change webhooks.',
  session_required: 'Only your own browser session can do that.',
  no_webhook: 'Save a webhook first.',
}

export function WebhookPanel({ verticalId, verticalName, canManage }: { verticalId: string; verticalName: string; canManage: boolean }) {
  const hook = useSWR<{ webhook: WebhookView | null }>(`/api/verticals/${verticalId}/webhook`, fetchJson)
  const current = hook.data?.webhook ?? null
  const [url, setUrl] = useState<string | null>(null)
  const [secret, setSecret] = useState('')
  const [revealed, setRevealed] = useState<string | null>(null)
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null)
  const shownUrl = url ?? current?.url ?? ''
  const fail = (status: number, body: unknown) => {
    const code = (body as { error?: string } | null)?.error
    setMsg({ ok: false, text: (code && ERR[code]) || code || `Request failed (HTTP ${status})` })
  }

  async function save() {
    setMsg(null)
    const r = await sendJson(`/api/verticals/${verticalId}/webhook`, { url: shownUrl.trim(), ...(secret.trim() ? { secret: secret.trim() } : {}) }, { method: 'PUT' })
    if (r.status !== 200) return fail(r.status, r.body)
    const b = r.body as { secret?: string }
    setRevealed(b.secret ?? null)
    setSecret('')
    setUrl(null)
    setMsg({ ok: true, text: 'Webhook saved.' })
    void hook.mutate()
  }

  async function remove() {
    if (!confirm(`Remove the webhook for “${verticalName}”? Its bot falls back to polling /operator.`)) return
    const r = await sendJson(`/api/verticals/${verticalId}/webhook`, {}, { method: 'DELETE' })
    if (r.status !== 200) return fail(r.status, r.body)
    setMsg({ ok: true, text: 'Webhook removed.' })
    void hook.mutate()
  }

  async function test() {
    setMsg(null)
    const r = await sendJson(`/api/verticals/${verticalId}/webhook/test`, {})
    const b = r.body as { ok?: boolean; status?: number; error?: string; attempts?: number } | null
    if (r.status === 200 && b?.ok) setMsg({ ok: true, text: `Test delivered (HTTP ${b.status}).` })
    else if (r.status === 200) setMsg({ ok: false, text: `Test failed: ${b?.error ?? 'unknown'} after ${b?.attempts ?? 1} attempt(s).` })
    else fail(r.status, r.body)
    void hook.mutate()
  }

  return (
    <fieldset className="mt-3 text-sm" aria-label={`Webhook for ${verticalName}`}>
      <legend className="mb-1 text-xs text-muted-foreground">Grok webhook (optional push; the bot still polls /operator)</legend>
      <div className="flex flex-wrap items-center gap-2">
        <Input
          className="w-96"
          value={shownUrl}
          disabled={!canManage}
          onChange={(e) => setUrl(e.target.value)}
          placeholder="https://… (the Grok routine's webhook URL)"
          aria-label="Webhook URL"
        />
        <Input
          className="w-56"
          type="password"
          autoComplete="off"
          value={secret}
          disabled={!canManage}
          onChange={(e) => setSecret(e.target.value)}
          placeholder={current ? `secret ${current.secret_masked} (blank keeps it)` : 'secret (blank: generate one)'}
          aria-label="Webhook secret"
        />
        {canManage && (
          <>
            <Button type="button" size="sm" disabled={!shownUrl.trim()} onClick={() => void save()}>
              Save webhook
            </Button>
            {current && (
              <>
                <Button type="button" size="sm" variant="outline" onClick={() => void test()}>
                  Send test
                </Button>
                <Button type="button" size="sm" variant="ghost" onClick={() => void remove()}>
                  Remove
                </Button>
              </>
            )}
          </>
        )}
      </div>
      {current && (
        <p className="mt-1 text-xs text-muted-foreground">
          Secret {current.secret_masked}.{' '}
          {current.last_delivery_at
            ? `Last push ${current.last_delivery_ok ? 'delivered' : `failed (${current.last_error ?? 'error'})`} ${current.last_delivery_at.slice(0, 16).replace('T', ' ')} UTC.`
            : 'No push yet.'}
        </p>
      )}
      {revealed && (
        <div className="mt-2 flex items-center gap-2" role="status">
          <span className="text-xs">Generated secret, shown once:</span>
          <Input readOnly className="w-96" value={revealed} aria-label="Generated webhook secret" onFocus={(e) => e.currentTarget.select()} />
          <Button type="button" size="sm" onClick={() => void navigator.clipboard?.writeText(revealed)}>
            Copy
          </Button>
          <Button type="button" size="sm" variant="outline" onClick={() => setRevealed(null)}>
            Done
          </Button>
        </div>
      )}
      {msg && (
        <p role={msg.ok ? 'status' : 'alert'} className={msg.ok ? 'mt-1 text-xs' : 'mt-1 text-xs text-destructive'}>
          {msg.text}
        </p>
      )}
    </fieldset>
  )
}
