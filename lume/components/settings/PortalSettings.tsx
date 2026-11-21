'use client'

import { useState } from 'react'
import { Copy, ExternalLink } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { sendJson } from '@/lib/validate/client'
import type { PortalSignInLinkResponse } from '@/lib/portal/types'

export const DEFAULT_PORTAL_EMAIL = 'frank@getzenport.com'

type State = { kind: 'idle' } | { kind: 'busy' } | { kind: 'copied'; minutes: number } | { kind: 'manual'; url: string; minutes: number } | { kind: 'error'; message: string }

/**
 * Settings → Client portal: hand a client a one-time sign-in link to their
 * read-only /portal, or preview it as them. The link is minted server-side
 * (owner only) and never stored here.
 */
export function PortalSettings() {
  const [email, setEmail] = useState(DEFAULT_PORTAL_EMAIL)
  const [state, setState] = useState<State>({ kind: 'idle' })
  const trimmed = email.trim()
  const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)

  async function copyLink() {
    setState({ kind: 'busy' })
    const r = await sendJson<PortalSignInLinkResponse & { error?: string }>('/api/portal/sign-in-link', { email: trimmed })
    if (r.status !== 200 || !r.body?.url) {
      setState({ kind: 'error', message: r.body?.error ?? (r.status === 0 ? 'Could not reach the server.' : 'Could not create a link.') })
      return
    }
    const { url, expires_in_minutes: minutes } = r.body
    try {
      await navigator.clipboard.writeText(url)
      setState({ kind: 'copied', minutes })
    } catch {
      // Clipboard blocked (permissions / insecure origin): show it to copy by hand.
      setState({ kind: 'manual', url, minutes })
    }
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-fg">Client portal</h2>
        <p className="mt-1 text-[13px] text-fg-70">
          A read-only lead list for a client, built for calling from a phone. They see only their own leads — none of Lume.
        </p>
      </div>
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid) void copyLink()
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1.5 text-[12px] text-fg-70">
          Client email
          <Input
            type="email"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setState({ kind: 'idle' })
            }}
            className="min-w-56 font-mono"
            aria-invalid={!valid}
          />
        </label>
        <Button type="submit" disabled={!valid || state.kind === 'busy'}>
          <Copy /> {state.kind === 'busy' ? 'Creating…' : 'Copy sign-in link'}
        </Button>
        <a
          href={valid ? `/portal?as=${encodeURIComponent(trimmed)}` : undefined}
          aria-disabled={!valid}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg px-2.5 text-sm text-fg-70 hover:bg-secondary hover:text-fg aria-disabled:pointer-events-none aria-disabled:opacity-50"
        >
          <ExternalLink className="size-4" aria-hidden /> Open portal preview
        </a>
      </form>
      {state.kind === 'manual' && (
        <Input readOnly value={state.url} aria-label="Sign-in link" className="font-mono text-[12px]" onFocus={(e) => e.currentTarget.select()} />
      )}
      <p className="text-[12px] text-fg-46" role="status">
        {state.kind === 'copied' && `Link copied — valid ~${state.minutes} min, single use.`}
        {state.kind === 'manual' && `Copy the link above — valid ~${state.minutes} min, single use.`}
        {state.kind === 'error' && state.message}
      </p>
    </section>
  )
}
