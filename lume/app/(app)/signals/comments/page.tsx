import type { Metadata } from 'next'
import { SignalsInbox } from '@/components/signals/SignalsInbox'

export const metadata: Metadata = { title: 'Signals: post comments' }

/** `/signals/comments`: accounts with a comment or reaction on a watched post, with the comment and the post. */
export default function SignalsCommentsPage() {
  return <SignalsInbox fixedSource="comment" />
}
