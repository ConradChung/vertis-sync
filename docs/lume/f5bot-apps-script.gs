/**
 * GTM-15: forward F5Bot alerts from this Gmail inbox to Lume.
 *
 * Setup (once, in the inbox that receives F5Bot alerts):
 *  1. script.google.com → New project → paste this file.
 *  2. Project Settings → Script Properties → add LUME_F5BOT_SECRET
 *     (the same value as Vercel's LUME_F5BOT_SECRET). Never put it in code.
 *  3. Run forwardF5bot once by hand and accept the Gmail + external-request permissions.
 *  4. Triggers → Add trigger → forwardF5bot, time-driven, every 5 minutes.
 *
 * Each F5Bot email is POSTed once; on a 2xx it gets the label "lume-sent" and
 * is skipped next time. A failure leaves it unlabelled, so the next run
 * retries it (Lume dedupes on the Reddit link, so a retry never double-posts).
 */
const LUME_URL = 'https://lume-amber-alpha.vercel.app/api/webhooks/f5bot'
const LABEL = 'lume-sent'
const QUERY = 'from:f5bot.com -label:' + LABEL + ' newer_than:7d'

function forwardF5bot() {
  const secret = PropertiesService.getScriptProperties().getProperty('LUME_F5BOT_SECRET')
  if (!secret) throw new Error('Set the LUME_F5BOT_SECRET script property first')
  const label = GmailApp.getUserLabelByName(LABEL) || GmailApp.createLabel(LABEL)
  const threads = GmailApp.search(QUERY, 0, 20)
  for (const thread of threads) {
    let ok = true
    for (const m of thread.getMessages()) {
      if (!/f5bot\.com/i.test(m.getFrom())) continue
      const res = UrlFetchApp.fetch(LUME_URL, {
        method: 'post',
        contentType: 'application/json',
        headers: { 'X-Lume-F5bot-Secret': secret },
        payload: JSON.stringify({ message_id: m.getId(), subject: m.getSubject(), body: m.getPlainBody(), html: m.getBody() }),
        muteHttpExceptions: true,
      })
      const code = res.getResponseCode()
      console.log(m.getId() + ' → ' + code + ' ' + res.getContentText().slice(0, 300))
      if (code < 200 || code >= 300) ok = false
    }
    if (ok) thread.addLabel(label)
  }
}
