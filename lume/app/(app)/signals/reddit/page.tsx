import type { Metadata } from 'next'
import { SignalsInbox } from '@/components/signals/SignalsInbox'

export const metadata: Metadata = { title: 'Signals: Reddit' }

/** `/signals/reddit`: Reddit mentions, one row per author, with subreddit, thread and excerpt. */
export default function SignalsRedditPage() {
  return <SignalsInbox fixedSource="reddit" />
}
