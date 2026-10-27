// The Instantly campaign_choice gate, asked at the true end of a job.
//
// The Telegram prompt is a force_reply: telegram-inbox matches the owner's
// reply back to this job through instantly_prompt_message_id. The gate itself
// is `instantly_status = 'awaiting_campaign'`, and that must open whether or
// not Telegram sends (ALERT_CHANNELS=feed, no bot configured, Telegram down):
// Lume's campaign_choice card decides it from the feed row's link.
//
// With Telegram on this is exactly the pre-G4 sequence: send, then one PATCH
// carrying both the message id and the status.

import { alert, type AlertDeps, gateKey, lumeLink, titleFrom } from '../_shared/alert.ts'

export interface CampaignPromptDeps {
  botToken: string
  chatId: string
  patchJob: (jobId: string, body: Record<string, unknown>) => Promise<unknown>
  /** Tests only; production uses the helper's defaults. */
  alertDeps?: AlertDeps
}

export async function promptForCampaign(
  jobId: string,
  filename: string,
  validCount: number,
  deps: CampaignPromptDeps,
): Promise<void> {
  const text =
    `📤 Push ${validCount} valid leads to Instantly?\n${filename}\n\n` +
    `Reply to this message with the campaign NAME (partial is fine — I'll match it against your campaign list).`
  let messageId: number | undefined
  await alert({
    source: 'email-validator', severity: 'urgent', title: titleFrom(text), body: text,
    link: lumeLink(`/validate?gate=campaign_choice:${jobId}`, deps.alertDeps?.env), scope: 'validation',
    dedupe_key: gateKey(jobId, 'campaign_choice'),
    telegram: async () => {
      if (!deps.botToken || !deps.chatId) return
      try {
        const res = await fetch(`https://api.telegram.org/bot${deps.botToken}/sendMessage`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            chat_id: deps.chatId,
            text,
            reply_markup: { force_reply: true },
          }),
        })
        const sent = await res.json() as { result?: { message_id?: number } }
        messageId = sent.result?.message_id
      } catch (err) {
        console.error('[email-validator] Instantly campaign prompt failed:', err)
      }
    },
  }, deps.alertDeps)

  try {
    await deps.patchJob(jobId, messageId
      ? { instantly_prompt_message_id: messageId, instantly_status: 'awaiting_campaign' }
      : { instantly_status: 'awaiting_campaign' })
  } catch (err) {
    console.error('[email-validator] Instantly campaign prompt failed:', err)
  }
}
