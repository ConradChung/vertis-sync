'use client'

import { useEffect, useState } from 'react'
import useSWR from 'swr'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchJson } from '@/hooks/fetcher'
import { sendJson } from '@/lib/validate/client'

interface CapState {
  cap_usd: number
  month_to_date_usd: number | null
  max_usd: number
}

/**
 * Settings → Budget: the shared monthly Apify cap (and, below it, the lead
 * bank threshold). Influencer runs and company
 * research refuse an Apify start that would pass it (Apify account usage +
 * reservations); Apify's own account limit still applies on top.
 */
export function BudgetSettings() {
  return (
    <div className="flex flex-col gap-10">
      <ApifyCapSettings />
      <BankThresholdSettings />
    </div>
  )
}

function ApifyCapSettings() {
  const { data, mutate } = useSWR<CapState>('/api/settings/apify-cap', fetchJson)
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => {
    if (data) setDraft(String(data.cap_usd))
  }, [data])

  const value = Number(draft)
  const valid = Number.isFinite(value) && value > 0 && value <= (data?.max_usd ?? 1000)
  const changed = data ? value !== data.cap_usd : false

  async function save() {
    setState('saving')
    const r = await sendJson<{ cap_usd: number }>('/api/settings/apify-cap', { cap_usd: value }, { method: 'PUT' })
    if (r.status === 200 && r.body) {
      await mutate({ ...(data as CapState), cap_usd: r.body.cap_usd }, { revalidate: true })
      setState('saved')
    } else setState('error')
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-fg">Monthly Apify cap</h2>
        <p className="mt-1 text-[13px] text-fg-70">
          Shared by influencer runs and company research. A start that would pass it is refused. Apify&apos;s own account limit still applies.
        </p>
      </div>
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && changed) void save()
        }}
      >
        <label className="flex flex-col gap-1.5 text-[12px] text-fg-70">
          Cap (USD per month)
          <Input
            type="number"
            inputMode="decimal"
            min={1}
            max={data?.max_usd ?? 1000}
            step="1"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setState('idle')
            }}
            className="w-36 font-mono"
            aria-invalid={!valid}
          />
        </label>
        <Button type="submit" disabled={!data || !valid || !changed || state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </form>
      <p className="text-[12px] text-fg-46" role="status">
        {data?.month_to_date_usd != null && `Spent this month (ledger): $${data.month_to_date_usd.toFixed(2)} of $${data.cap_usd}. `}
        {state === 'saved' && 'Saved — the next Apify start uses it.'}
        {state === 'error' && 'Could not save. Try again.'}
        {!valid && draft !== '' && `Enter an amount between $1 and $${data?.max_usd ?? 1000}.`}
      </p>
    </section>
  )
}

interface BankState {
  threshold: number
  max: number
}

/**
 * Lead bank threshold: a push with more eligible leads than this goes to the
 * lead bank (queued) instead of straight into Instantly, and the twice-daily
 * rotation drips every banked campaign in under the shared workspace cap,
 * oldest queue first. The push tap authorises the banking and the rotation.
 */
function BankThresholdSettings() {
  const { data, mutate } = useSWR<BankState>('/api/settings/bank-threshold', fetchJson)
  const [draft, setDraft] = useState('')
  const [state, setState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  useEffect(() => {
    if (data) setDraft(String(data.threshold))
  }, [data])

  const max = data?.max ?? 100000
  const value = Number(draft)
  const valid = Number.isInteger(value) && value >= 1 && value <= max
  const changed = data ? value !== data.threshold : false

  async function save() {
    setState('saving')
    const r = await sendJson<{ threshold: number }>('/api/settings/bank-threshold', { threshold: value }, { method: 'PUT' })
    if (r.status === 200 && r.body) {
      await mutate({ ...(data as BankState), threshold: r.body.threshold }, { revalidate: true })
      setState('saved')
    } else setState('error')
  }

  return (
    <section className="flex max-w-xl flex-col gap-4">
      <div>
        <h2 className="text-[15px] font-semibold text-fg">Lead bank threshold</h2>
        <p className="mt-1 text-[13px] text-fg-70">
          A push with more eligible leads than this goes to the lead bank and rotates into its campaign automatically as slots free under the workspace contact cap.
        </p>
      </div>
      <form
        className="flex items-end gap-3"
        onSubmit={(e) => {
          e.preventDefault()
          if (valid && changed) void save()
        }}
      >
        <label className="flex flex-col gap-1.5 text-[12px] text-fg-70">
          Leads per push
          <Input
            type="number"
            inputMode="numeric"
            min={1}
            max={max}
            step="1"
            value={draft}
            onChange={(e) => {
              setDraft(e.target.value)
              setState('idle')
            }}
            className="w-36 font-mono"
            aria-invalid={!valid}
          />
        </label>
        <Button type="submit" disabled={!data || !valid || !changed || state === 'saving'}>
          {state === 'saving' ? 'Saving…' : 'Save'}
        </Button>
      </form>
      <p className="text-[12px] text-fg-46" role="status">
        {state === 'saved' && 'Saved — the next push preview uses it.'}
        {state === 'error' && 'Could not save. Try again.'}
        {!valid && draft !== '' && `Enter a whole number between 1 and ${max}.`}
      </p>
    </section>
  )
}
