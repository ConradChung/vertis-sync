import type { Metadata } from 'next'
import { PageHead } from '@/components/shell/PageHead'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { BudgetSettings } from '@/components/settings/BudgetSettings'

export const metadata: Metadata = { title: 'Budget' }

/** Settings → Budget: spend caps the pipelines enforce. */
export default function BudgetSettingsPage() {
  return (
    <>
      <PageHead eyebrow="Settings" title="Budget" sub="Spend caps the pipelines enforce before they start anything paid." />
      <SettingsNav current="/settings/budget" />
      <BudgetSettings />
    </>
  )
}
