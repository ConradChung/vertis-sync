import type { Metadata } from 'next'
import { cookies } from 'next/headers'
import { PageHead } from '@/components/shell/PageHead'
import { SettingsNav } from '@/components/settings/SettingsNav'
import { SlackSettings } from '@/components/settings/SlackSettings'
import { OPERATOR_COOKIE } from '@/lib/operators/cookie'

export const metadata: Metadata = { title: 'Slack' }

/** Settings → Slack (3g): client workspaces, install link, channel bindings. Changes only without a `lume_op` cookie (the routes enforce it). */
export default async function SlackSettingsPage() {
  const store = await cookies()
  const canManage = !store.get(OPERATOR_COOKIE)?.value
  return (
    <>
      <PageHead eyebrow="Settings" title="Slack" sub="Clients’ own Slack workspaces: the install link, installed workspaces, and which channel sees which campaigns." />
      <SettingsNav current="/settings/slack" />
      <SlackSettings canManage={canManage} />
    </>
  )
}
