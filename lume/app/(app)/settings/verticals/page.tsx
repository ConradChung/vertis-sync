import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { PageHead } from '@/components/shell/PageHead'
import { VerticalsSettings } from '@/components/settings/VerticalsSettings'
import { OPERATOR_COOKIE } from '@/lib/operators/cookie'

export const metadata: Metadata = { title: 'Verticals' }

/** Settings → Verticals. Key minting/revoking is offered only without a `lume_op` cookie (the routes enforce it). */
export default async function VerticalsSettingsPage() {
  const store = await cookies()
  const canManageKeys = !store.get(OPERATOR_COOKIE)?.value
  return (
    <>
      <PageHead eyebrow="Settings" title="Verticals" sub="Lines of business, their campaigns, and the Grok Bot keys that run them." />
      <VerticalsSettings canManageKeys={canManageKeys} />
    </>
  )
}
