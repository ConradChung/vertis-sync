import type { Metadata } from 'next'
import { SignOutButton } from '@/components/auth/SignOutButton'

export const metadata: Metadata = { title: 'Forbidden' }

/**
 * Rendered by the middleware rewrite (status 403) when a valid session does
 * not belong to LUME_ALLOWED_EMAIL. Reachable directly too (200).
 */
export default function ForbiddenPage() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="glass w-full max-w-sm rounded-panel-lg p-7 text-center">
        <div className="eyebrow">403</div>
        <h1 className="mt-2 text-2xl font-semibold tracking-[-0.5px]">Not your Lume</h1>
        <p className="mt-2 text-sm text-fg-46">
          This workspace is tied to a single account. Sign out and use the owner&apos;s email.
        </p>
        <div className="mt-6 flex justify-center">
          <SignOutButton />
        </div>
      </section>
    </main>
  )
}
