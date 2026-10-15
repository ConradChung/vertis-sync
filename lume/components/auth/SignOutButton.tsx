'use client'

import { useState } from 'react'
import { Button } from '@/components/ui/button'
import { createClient } from '@/lib/supabase/client'

export function SignOutButton() {
  const [busy, setBusy] = useState(false)

  async function signOut() {
    setBusy(true)
    await createClient().auth.signOut()
    window.location.assign('/login')
  }

  return (
    <Button variant="outline" onClick={signOut} disabled={busy}>
      {busy ? 'Signing out…' : 'Sign out'}
    </Button>
  )
}
