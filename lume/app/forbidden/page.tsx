import type { Metadata } from 'next'
import { SignOutButton } from '@/components/auth/SignOutButton'

export const metadata: Metadata = { title: 'Forbidden' }

/**
 * The middleware redirects here (307) when a valid session does not belong to
 * LUME_ALLOWED_EMAIL. It is a redirect rather than a 403 rewrite because Next
 * drops a custom status on rewrites; the page itself serves 200 and is public
 * so a signed-out visitor can read it too. API routes get 403 JSON instead.
 */
export default function ForbiddenPage() {
  return (
    <main className="grid min-h-dvh place-items-center p-6">
      <section className="glass w-full max-w-sm rounded-2xl p-7 text-center">
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
