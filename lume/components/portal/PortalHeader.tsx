'use client'

import { useState } from 'react'
import Link from 'next/link'
import { useSearchParams } from 'next/navigation'
import { Eye, LogOut } from 'lucide-react'
import { ThemeToggle } from '@/components/theme/ThemeToggle'
import { createClient } from '@/lib/supabase/client'
import { usePortalMe } from '@/hooks/usePortal'
import { LumeMark } from '@/components/shell/LumeMark'

/**
 * The portal's only chrome: client name, who is signed in, sign out. Nothing
 * from the owner's shell (nav, tabs, agent) is reachable from here. In owner
 * preview (`?as=`) sign-out is replaced by a way back to Settings, so the
 * owner doesn't sign themself out by accident.
 */
export function PortalHeader() {
  const as = useSearchParams().get('as')
  const { data: me } = usePortalMe(as)
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    try {
      await createClient().auth.signOut()
    } finally {
      // Middleware decides where a signed-out visitor to /portal goes.
      window.location.assign('/portal')
    }
  }

  return (
    <header className="sticky top-0 z-30 border-b border-(--line) bg-(--surface) pt-[env(safe-area-inset-top)] backdrop-blur-xl">
      <div className="mx-auto flex h-(--portal-header-h) w-full max-w-[1600px] items-center justify-between gap-3 px-4 md:px-8">
        <div className="flex min-w-0 items-center gap-3">
          <span className="glass grid size-10 shrink-0 place-items-center rounded-xl text-fg" title="Lume">
            <LumeMark className="h-3.5 w-auto" />
            <span className="sr-only">Lume</span>
          </span>
          <div className="min-w-0">
            <h1 className="truncate text-[17px] leading-tight font-semibold tracking-[-0.01em] text-fg">{me ? `${me.client} leads` : 'Leads'}</h1>
            <p className="truncate text-[12px] text-fg-46">
              {as && <span className="mr-1.5 rounded-full bg-secondary px-1.5 py-px text-[11px] text-fg-70">Preview</span>}
              {me?.email ?? as ?? ' '}
            </p>
          </div>
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <ThemeToggle />
          {as ? (
            <Link href="/settings/portal" className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] text-fg-70 hover:bg-secondary hover:text-fg md:h-9">
              <Eye className="size-4" aria-hidden /> Exit preview
            </Link>
          ) : (
            <button
              type="button"
              onClick={signOut}
              disabled={busy}
              className="inline-flex h-11 items-center gap-1.5 rounded-xl px-3 text-[13px] text-fg-70 outline-none hover:bg-secondary hover:text-fg focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-50 md:h-9"
            >
              <LogOut className="size-4" aria-hidden />
              {busy ? 'Signing out…' : 'Sign out'}
            </button>
          )}
        </div>
      </div>
    </header>
  )
}
