'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'

interface ReplyDeskState {
  channel_name: string | null
  channel_id: string | null
  monthly_cap_usd: number
  followup_days: number[]
}

const ERRORS: Record<string, string> = {
  channel_not_found: 'No channel with that name in the Lume workspace.',
  bot_not_in_channel: 'Invite Lume to the channel first (/invite @Lume), then save again.',
  no_slack_install: 'Lume is not installed in a Slack workspace yet.',
  several_slack_installs: 'Several workspaces have Lume; set reply_desk_config.slack.team_id first.',
  slack_install_missing_or_revoked: 'The Lume app was removed from this workspace. Reinstall it.',
  slack_not_configured: 'Slack is not configured on this deployment.',
  invalid_channel_name: 'Use the channel name as Slack shows it, lowercase.',
}

/**
 * Reply desk: the one Slack channel SendPilot posts LinkedIn replies into.
 * Lume reads only that channel; every other channel is ignored.
 */
export function ReplyDeskSettings() {
  const { data, mutate } = useSWR<ReplyDeskState>('/api/settings/reply-desk', fetchJson)
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<{ kind: 'idle' | 'saving' | 'saved' } | { kind: 'error'; text: string }>({ kind: 'idle' })
  useEffect(() => {
    if (data?.channel_name) setDraft(data.channel_name)
  }, [data])

  async function save() {
    setState({ kind: 'saving' })
    const r = await sendJson<{ channel_name?: string; channel_id?: string; error?: string }>('/api/settings/reply-desk', { channel_name: draft.trim() }, { method: 'PUT' })
    if (r.status === 200) {
      await mutate()
      setState({ kind: 'saved' })
    } else setState({ kind: 'error', text: ERRORS[r.body?.error ?? ''] ?? 'Could not save. Try again.' })
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-fg">LinkedIn replies channel</h2>
        <p className="mt-1 text-[13px] text-fg-70">
          The channel SendPilot posts into when a prospect replies. Lume drafts an answer under each notification and posts follow-ups there. Nothing is ever sent on LinkedIn.
        </p>
      </div>
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (draft.trim()) void save()
        }}
      >
        <label className="flex flex-col gap-1.5 text-[12px] text-fg-70">
          Channel name
          <Input
            value={draft}
            placeholder="sendpilot-replies"
            onChange={(e) => {
              setDraft(e.target.value)
              setState({ kind: 'idle' })
            }}
            className="w-56 font-mono"
          />
        </label>
        <Button type="submit" disabled={!draft.trim() || state.kind === 'saving'}>
          {state.kind === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </form>
      <p className="text-[12px] text-fg-46" role="status">
        {state.kind === 'saved' && 'Saved. Lume now listens to this channel only.'}
        {state.kind === 'error' && state.text}
        {state.kind === 'idle' &&
          (data?.channel_id
            ? `Listening to #${data.channel_name}. Claude cap $${data.monthly_cap_usd}/month. Follow-ups on days ${data.followup_days.join(', ')}.`
            : data
              ? 'Not set: Lume ignores every channel until you set one.'
              : '')}
      </p>
    </section>
  )
}
