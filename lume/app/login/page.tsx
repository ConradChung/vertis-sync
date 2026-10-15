'use client'

import { Suspense, useState, type FormEvent } from 'react'
import { useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { createClient } from '@/lib/supabase/client'

type Status = 'idle' | 'sending' | 'sent' | 'error'

export default function LoginPage() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="glass w-full max-w-sm rounded-panel-lg p-7">
        <div className="brand text-[26px]">lume</div>
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
  const callbackError = searchParams.get('error')

  const [email, setEmail] = useState('')
  const [status, setStatus] = useState<Status>(callbackError ? 'error' : 'idle')
  const [message, setMessage] = useState<string | null>(
    callbackError === 'missing_code'
      ? 'That link was incomplete. Request a new one.'
      : callbackError
  )

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    setStatus('sending')
    setMessage(null)
    const supabase = createClient()
    const { error } = await supabase.auth.signInWithOtp({
      email: email.trim(),
      options: { emailRedirectTo: `${window.location.origin}/auth/callback` },
    })
    if (error) {
      setStatus('error')
      setMessage(error.message)
      return
    }
    setStatus('sent')
  }

  return (
    <>
      {status === 'sent' ? (
        <div className="mt-6 rounded-control border border-green/30 bg-green/10 p-3 text-sm text-fg-70" role="status">
          Check <span className="font-mono text-fg">{email.trim()}</span> for a sign-in link. It expires in an
          hour.
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
