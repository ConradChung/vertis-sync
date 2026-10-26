'use client'

import { Suspense, useState, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'

type Status = 'idle' | 'sending' | 'sent' | 'error'

/** Copy for the fixed codes `/auth/callback` can return. */
const CALLBACK_ERRORS: Record<string, string> = {
  missing_code: 'That link was incomplete. Request a new one.',
  expired: 'That link has expired or was already used. Request a new one.',
  exchange_failed: 'Sign-in could not be completed. Request a new link.',
}

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="glass w-full max-w-sm rounded-2xl p-7">
        <div className="brand text-[26px]">
          <span className="inline-block size-4 rounded-sm bg-primary dark:shadow-(--primary-glow) light:ring-1 light:ring-(--lime-edge)" aria-hidden />
          lume
        </div>
        <h1 className="mt-5 text-xl font-semibold tracking-[-0.5px]">Sign in</h1>
        <p className="mt-1 text-sm text-fg-46">A magic link goes to the owner&apos;s email.</p>
        {/* useSearchParams needs a Suspense boundary for static prerendering. */}
        <Suspense fallback={null}>
          <LoginForm />
        </Suspense>
      </section>
    </main>
  )
}

function LoginForm() {
  const searchParams = useSearchParams()
  const code = searchParams.get('error')
  const callbackMessage = code ? (CALLBACK_ERRORS[code] ?? CALLBACK_ERRORS.exchange_failed) : null

  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>(callbackMessage ? 'error' : 'idle')
  const [message, setMessage] = useState<string | null>(callbackMessage)

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    setMessage(null)
    try {
      // The route decides whether anything is sent; the response is the same either way.
      const res = await fetch('/api/auth/magic-link', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email: email.trim() }),
      })
      if (!res.ok) throw new Error(String(res.status))
      setStatus('sent')
    } catch {
      setStatus('error')
      setMessage('Could not reach the server. Try again.')
    }
  }

  return (
    <>
      {status === 'sent' ? (
        <div className="mt-6 rounded-control border border-green/30 bg-green/10 p-3 text-sm text-fg-70" role="status">
          If <span className="font-mono text-fg">{email.trim()}</span> is the owner&apos;s address, a sign-in
          link is on its way. It expires in an hour.
        </div>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 flex flex-col gap-3">
          <label htmlFor="email" className="eyebrow">
            Email
          </label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            autoFocus
            placeholder="you@example.com"
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            disabled={status === 'sending'}
          />
          <Button type="submit" disabled={status === 'sending' || !email.trim()} className="mt-1">
            {status === 'sending' ? 'Sending…' : 'Send magic link'}
          </Button>
        </form>
      )}

      {status === 'error' && message && (
        <p className="mt-4 text-sm text-red" role="alert">
          {message}
        </p>
      )}
    </>
  )
}
