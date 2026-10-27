import { redirect } from 'next/navigation'

/** Settings has one page so far. */
export default function SettingsPage() {
  redirect('/settings/verticals')
}
