'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'
import { buildCallbackData } from '@/lib/adapters/pipeline.actions'
import type { GateRow } from '@/lib/db/types'
import type { ButtonSpec } from '@/lib/validate/actions'
import { sendJson } from '@/lib/validate/client'
import { clientOutcome } from '@/lib/validate/decideResult'
import { gateKey } from '@/lib/validate/deepLink'

/** Client-side ceiling for a decision: above the route's 170 s entrypoint wait. */
const DECIDE_CLIENT_TIMEOUT_MS = 200_000

/**
 * What a gate button does. Every decision lands on the same claim a Telegram
 * tap does (POST /api/gates/decide); whichever arrives first wins and the
 * other sees "already handled". `create_action` asks for a confirmation
 * (pending_actions) instead of acting; `action_decide` is that confirmation.
 */
export function useGateRunner(onRefresh: () => void) {
  const [busy, setBusy] = useState<ReadonlySet<string>>(new Set())
  const busyRef = useRef(busy)
  busyRef.current = busy
  const [countOpenKey, setCountOpenKey] = useState<string | null>(null)
  const [pickerTick, setPickerTick] = useState(0)
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])
  useEffect(() => () => timers.current.forEach(clearTimeout), [])

  const setBusyKey = (key: string, on: boolean) =>
    setBusy((prev) => {
      const next = new Set(prev)
      if (on) next.add(key)
      else next.delete(key)
      return next
    })

  const run = useCallback(
    async (gate: GateRow, spec: ButtonSpec, count?: number) => {
      const key = gateKey(gate)
      if (busyRef.current.has(key)) return

      if (spec.mode === 'panel') {
        setPickerTick((t) => t + 1)
        return
      }
      if (spec.needsCount && count === undefined) {
        setCountOpenKey(key)
        return
      }

      setBusyKey(key, true)
      try {
        if (spec.mode === 'decide') {
          let callbackData: string
          try {
            callbackData = buildCallbackData(spec.action, gate.target_id, spec.count ?? count)
          } catch {
            toast.error('That choice is not valid for this gate')
            return
          }
          const r = await sendJson('/api/gates/decide', { callback_data: callbackData }, { timeoutMs: DECIDE_CLIENT_TIMEOUT_MS })
          const outcome = r.status === 0 ? (r.aborted ? 'pending' : 'error') : clientOutcome(r.status, r.body)
          const err = (r.body as { error?: string } | null)?.error
          if (outcome === 'done') toast.success(`${spec.label} — done`)
          else if (outcome === 'sent') toast.success(`${spec.label} sent`, { description: 'Telegram will report the result.' })
          else if (outcome === 'already_handled') toast.info('Already handled — refreshed')
          else if (outcome === 'pending') {
            toast.info('Still working — will refresh')
            timers.current.push(setTimeout(onRefresh, 15_000), setTimeout(onRefresh, 60_000))
          } else if (err === 'pipeline_not_configured') toast.error('Pipeline entrypoint not configured', { description: 'Set LUME_ACTION_SECRET.' })
          else toast.error("Couldn't reach the pipeline", { description: 'Nothing was claimed — the Telegram button still works.' })
          if (spec.needsCount && outcome !== 'error') setCountOpenKey(null)
        } else if (spec.mode === 'create_action' && spec.actionKind) {
          const r = await sendJson<{ error?: string }>('/api/actions', { kind: spec.actionKind, payload: { job_id: gate.target_id } })
          if (r.status === 201) toast.success('Confirmation requested', { description: 'Confirm it here or in Telegram — nothing is pushed until then.' })
          else if (r.status === 409 && r.body?.error === 'duplicate') toast.info('A confirmation is already waiting for this job')
          else if (r.status === 409 && r.body?.error === 'nothing_to_push') toast.info('Nothing to push — every lead is filtered out')
          else if (r.status === 409) toast.info('This job is no longer ready to push — refreshed')
          else toast.error("Couldn't request the confirmation")
        } else if (spec.mode === 'action_decide') {
          const r = await sendJson(`/api/actions/${gate.target_id}/decide`, { decision: spec.action === 'lume_ok' ? 'approve' : 'reject' })
          if (r.status === 404) toast.error('Confirmation endpoint not available yet')
          else if (r.status === 409) toast.info('Already handled — refreshed')
          else if (r.status >= 200 && r.status < 300) toast.success(spec.action === 'lume_ok' ? 'Confirmed' : 'Cancelled')
          else toast.error("Couldn't record the decision")
        }
      } finally {
        setBusyKey(key, false)
        onRefresh()
      }
    },
    [onRefresh]
  )

  return { run, busy, countOpenKey, setCountOpenKey, pickerTick }
}
