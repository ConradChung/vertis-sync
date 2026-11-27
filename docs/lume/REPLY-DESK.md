# Reply desk: LinkedIn replies from SendPilot, via Slack

SendPilot posts a notification into a Slack channel whenever a prospect
replies to Frank on LinkedIn. Lume reads that one channel, saves each
notification, works out who replied and what they said, puts the person on
the pipeline, and posts a drafted answer in the thread under the notification.
Frank copies the draft into LinkedIn himself. **Lume never sends a LinkedIn
message.**

Until the steps below are done, nothing changes: Slack does not send Lume any
channel messages, and with no channel set Lume ignores every channel anyway.

## Owner steps in Slack (one time)

1. **Update the app's scopes and events.** Open https://api.slack.com/apps →
   **Lume** → **App Manifest**, and paste `docs/lume/slack-app-manifest.yml`
   from this repo (it adds the bot scopes `channels:history` and
   `groups:history` and the bot events `message.channels` and
   `message.groups`). Save. Slack checks the Events request URL
   (`/api/slack/events`) again; it must say Verified.
   - Doing it by hand instead: **OAuth & Permissions → Bot Token Scopes**: add
     `channels:history` and `groups:history`. **Event Subscriptions →
     Subscribe to bot events**: add `message.channels` and `message.groups`.
     Save changes.
2. **Reinstall the app through Lume's install link**, so Lume stores the
   token with the new scopes: Settings → Slack → **Generate link** → open it
   while signed in to your own workspace → **Allow**. (Slack's own "Reinstall
   to Workspace" button usually keeps the same bot token, but going through
   Lume's link is the sure way.) A reinstall pauses that workspace's lead-card
   channel bindings by design: if you had any, press **Resume** on them in
   Settings → Slack. #sales signal cards and #content-gen do not use bindings
   and are not affected.
3. **Invite the bot to the SendPilot channel.** In that channel, type
   `/invite @Lume`. Slack only delivers messages from channels the bot is in.
4. **Set the channel in Lume.** Settings → Slack → **LinkedIn replies
   channel**: type the channel name exactly as Slack shows it (no `#`) and
   Save. Lume finds the channel, checks the bot is in it, and stores its id
   (`lume_settings.reply_desk_config.slack.channel_id`). Every other channel
   is ignored.

## What happens to a reply

1. A message arrives in the channel. Thread replies and Lume's own posts are
   ignored.
2. The raw message (text, blocks, attachments) is saved to
   `reply_desk_inbound` before anything else.
3. Claude Haiku reads it as untrusted data and returns the person's name,
   company, LinkedIn profile URL (kept only if it is really in the
   notification), their message, the campaign, and a label: interested,
   question, not_now, not_interested or other.
4. interested / question / not_now: the person's deal is created or updated in
   **Conversation** (campaign `linkedin`), matched by LinkedIn URL (an existing
   deal, or a LinkedIn signal person, whose found work email is used). No
   placeholder address: a LinkedIn deal may have no email. Any follow-up
   schedule stops. The reply shows on **/replies** with its waiting timer,
   flagged after 5 minutes.
5. A drafted answer is posted as a thread reply, with **Sent**, **Redo**,
   **Booked** and **Not interested**. not_interested / other get no deal and
   no draft (a new message still stops any follow-ups).

## Buttons

- **Sent**: records the send and starts follow-up drafts on days 2, 5, 9, 14
  and 21 after it, each posted in the same thread when due. If the reply was
  "not now", it schedules one check-in instead: the date they named, or 30
  days.
- **Redo**: a new draft in the same thread.
- **Booked**: deal → Demo, follow-ups stop.
- **Not interested**: deal → Lost, follow-ups stop.

Follow-ups and check-ins are only posted weekdays 8 AM to 6 PM Pacific;
anything due outside waits for the next window. A new message from the person
stops the schedule and gets a fresh draft.

## Drafts

They start from the macros in `lume/lib/replydesk/macros.ts` (the one place
to edit them): more info (the case study), price, software, not now, who is
this, interested. Facts come from `content_facts` (kinds offer, number,
quote). Every draft is checked before posting: short, first person as Frank,
no em dashes, no links unless the person asked for something to read, every
number found in a fact. A draft that fails twice is replaced by the macro's
own text.

## Settings (`lume_settings.reply_desk_config`)

```json
{
  "slack": { "team_id": "T…", "channel_id": "C…", "channel_name": "…" },
  "monthly_cap_usd": 10,
  "followup_days": [2, 5, 9, 14, 21],
  "checkin_days": 30,
  "models": { "extract": "claude-haiku-5-5", "draft": "claude-opus-5-5" }
}
```

Change the follow-up days in SQL, e.g.
`update lume_settings set value = jsonb_set(value, '{followup_days}', '[3,7,14]') where key = 'reply_desk_config';`
The monthly cap is checked before every Claude call and is clamped to $10.

The pg_cron job `lume-reply-desk-tick` runs every 15 minutes and calls
`/api/cron/reply-desk` only when a follow-up is due.

## Not seen yet

No real SendPilot notification has been seen. The handler does not parse the
format; it was tested with plausible sample events. After the first real one,
check `reply_desk_inbound` (raw, extraction, label) and the draft in Slack.
