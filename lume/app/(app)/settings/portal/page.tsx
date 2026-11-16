import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { PortalSettings } from '@/components/settings/PortalSettings'

export const metadata: Metadata = { title: 'Client portal' }

/** Settings → Client portal: sign-in links and a preview of a client's /portal. */
export default function PortalSettingsPage() {
  return (
    <>
      <PageHead eyebrow="Settings" title="Client portal" sub="Give a client a read-only view of their leads." />
      <SettingsNav current="/settings/portal" />
      <PortalSettings />
    </>
  )
}
