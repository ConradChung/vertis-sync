import { NextResponse } from 'next/server'
import { requireSecret } from '@/lib/auth/guards'
import { gateOpenedSchema } from '@/lib/api/gateOpened'
import { getGate, logEvent } from '@/lib/db/service'
import { sendGatePing } from '@/lib/adapters/telegram'
import { buildGatePing } from '@/lib/adapters/telegram.messages'
import { alert, alertLink, telegramSkipped, titleFrom } from '@/lib/alerts'
import { scopeForGateKind } from '@/lib/operators/route'

/**
 * Target of the `lume_gate_opened()` DB trigger (pg_net POST, fire-and-forget):
 * a gate just opened, so send the short Telegram ping with a deep link into
 * Lume and log it to the feed. The pipeline's own prompt with the buttons was
 * already sent; this is the second message.
 *
 * Always 200 once the secret and body check out — an unconfigured bot or a
 * failed title lookup must not look like a hook failure to the trigger.
 */
export async function POST(req: Request) {
  const auth = requireSecret(req, 'X-Lume-Hook-Secret', 'LUME_HOOK_SECRET')
  if (!auth.ok) return auth.response

  let raw: unknown
  try {
    raw = await req.json()
  } catch {
    return NextResponse.json({ ok: false, error: 'invalid json' }, { status: 400 })
  }
  const parsed = gateOpenedSchema.safeParse(raw)
  if (!parsed.success) {
    // The body is {kind, target_table, target_id} — ids and enum names, no PII.
    console.error('[hooks/gate-opened] invalid body', parsed.error.issues)
    return NextResponse.json({ ok: false, error: 'invalid body' }, { status: 400 })
  }
  const { kind, target_table, target_id } = parsed.data

  // The view gives the human title; the trigger body does not carry it. A
  // miss (already handled, or a DB hiccup) still pings with the kind.
  let title: string | null = null
  try {
    title = (await getGate(kind, target_id))?.title ?? null
  } catch (err) {
    console.error('[hooks/gate-opened] getGate failed:', err instanceof Error ? err.message : err)
  }

  // One feed row per gate (the same dedupe_key the pipeline's own prompt
  // uses), plus the Telegram ping as before while ALERT_CHANNELS includes it.
  const pingText = buildGatePing(kind, target_id, title).text
  const ping = (await alert({
    source: 'lume.gates', severity: 'urgent', title: titleFrom(pingText), body: pingText,
    link: alertLink(`/validate?gate=${kind}:${target_id}`), scope: scopeForGateKind(kind),
    dedupe_key: `${target_id}:${kind}`,
    telegram: () => sendGatePing(kind, target_id, title),
  })) ?? telegramSkipped
  const pinged = ping.ok

  try {
    await logEvent({
      type: 'lume.gate_ping',
      source: 'lume',
      source_id: target_id,
      title: title ? `${kind} · ${title}` : kind,
      payload: { kind, target_table, pinged, telegram_message_id: pinged ? ping.messageId : null },
    })
  } catch (err) {
    console.error('[hooks/gate-opened] logEvent failed:', err instanceof Error ? err.message : err)
  }

  return NextResponse.json({ ok: true, pinged })
}
