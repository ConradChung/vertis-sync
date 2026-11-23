import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { ConfigHealth } from '@/components/settings/ConfigHealth'

export const metadata: Metadata = { title: 'Config health' }

/** Settings → Config health: secrets present / missing (names only) and on-demand live checks. */
export default function ConfigHealthPage() {
  return (
    <>
      <PageHead eyebrow="Settings" title="Config health" sub="Which secrets are set, and whether Apify, Telegram, Slack and the Railway worker answer." />
      <SettingsNav current="/settings/health" />
      <ConfigHealth />
    </>
  )
}
