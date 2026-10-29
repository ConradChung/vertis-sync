# Inbox manager + appointment setter: how it fits Lume (design draft)

Sources: `~/Downloads/inbox-manager-appointment-setter-sop.md` (SOP) and `~/Downloads/grok-bot-quick-start.md`
(quick start). Status: owner-approved 2026-10-28 (decisions at the end).

## The fit in one line

Grok Bot does the judgment and the calendar work: research, verdict, drafting in the owner's voice, Calendly and
Google Calendar. **Lume is its sequencer, trigger, approvals, memory and log.**

The bot never holds an Instantly key. Every send goes through Lume's `send_reply` approval, so there is one audit
trail and one supervised card. Approval works the same whether it comes from Lume, `/operator`, or the owner's chat.

## Mapping SOP to Lume

| SOP piece | Lume today | What we add |
|---|---|---|
| Sequencer API (thread, reply, status) | `draft_reply`, `send_reply` (high, always asks); Instantly webhook route → CRM | Phase 3: `list_replies`, `get_thread`, `label_reply`, plus a **bot reply API** that operator keys can call |
| Trigger (webhook / channel / poll) | Instantly webhook already lands replies in the CRM | Positive reply → `lume_alerts` (scope `replies`, routed to the vertical) and an `/operator` "New replies" section. Optional **push to a Grok webhook routine** per vertical (decision 3). Polling the `/operator` page is the backstop |
| Supervised card: Approve / Skip / Edit | `ApprovalCard` and the `/operator` Needs confirmation section | Reply card shows lead, company, verdict, their message, draft and proposed times. **Edit** saves the edited body before approving |
| Autonomous by written, scoped permission | Skip mode, which never skips emails (owner rule) | **Scoped send grant** per vertical: campaigns × actions (reply, follow-up), off by default, revocable, every send still a `pending_actions` row decided by `grant` (decision 2) |
| Safety: recheck live thread, one reply per event | — | The `send_reply` executor re-reads the thread right before sending and aborts if a newer inbound message exists. There is a unique (`reply_to_uuid`) awaiting/executed guard |
| Verdict GOOD / UNSURE / BAD / NOT NOW | CRM stages | `label_reply` maps the verdict to an Instantly interest status and a CRM stage. BAD or unsubscribe → blocklist |
| Memory files: qualify-rules, voice-samples, voice-rules, reply-templates, settings | **Projects** (being built) | A per-vertical **Inbox project** holds these files. The bot reads and writes them through the Lume project API, so Lume's own agent drafts in the same voice. Corrections append rules to them |
| held-slots, bookings, blocks, reminders, handled | CRM deals and activities | **Bookings** become a CRM activity plus the "Meeting booked" stage, logged by the bot through the bot API. **Handled** comes from `send_reply` history. **Blocks** come from the blocklist. Held slots and reminders stay in Grok memory, because calendar logic lives there |
| One-line report per action | Alert feed, `/operator` Recent outcomes | Executor outcomes for sends, labels and bookings become one-line feed entries |
| Follow-ups | — | Lume query: "times offered, no reply after N days" (from send history plus CRM). The Grok cron routine drafts follow-ups, which are approved like replies |
| Weekly reporter / trigger scout agents | Phase 5 `reply_rates`; master bot research | Reporter reads `reply_rates`. The scout is the master bot's new-vertical playbook |
| Keys as secrets | Operator sign-in links (`/auth/operator?k=`) | One **operator key per agent**: an Inbox Manager key and a Pipeline key per vertical (labels already supported) |

## Agents per vertical (quick start rule "one agent, one job")

- **Pipeline operator:** the existing `/operator` routine (orders, validation, launches).
- **Inbox manager:** the SOP, using the reply API, the Inbox project files and approvals.
- **Master:** creates verticals and their Inbox projects.

## Build order (replaces Phase 3)

1. **3a Replies read side.** `list_replies` and `get_thread` (Instantly `/emails`, 20/min, cached). Positive-reply alerts. A "New replies" section on `/operator`.
2. **3b Send path.**
   - `send_reply` card with Edit.
   - Live-thread recheck and the one-reply guard in the executor.
   - `label_reply`, plus the blocklist on unsubscribe, BAD or hostile replies.
3. **3c Bot API.** Operator-key routes for:
   - replies
   - threads
   - draft
   - submit-for-approval
   - label
   - log-booking
   - project files (read and append-rule)
4. **3d Inbox projects.**
   - Per-vertical project template seeded with the 5 SOP files, with placeholders.
   - A `docs/lume/INBOX-MANAGER-SETUP.md` version of SOP Part B, pre-filled with Lume endpoints.
5. **3e Grants** (if approved). Scoped send grants and `decided_via='grant'`.
6. **3f Webhook push** (if approved). Per-vertical Grok webhook URL. Lume POSTs to it on a positive reply or a new confirmation.

Status: 3a–3c built 2026-10-28 on branch `lume`. 3d–3f built 2026-10-29 (not deployed): the Inbox project template
and `docs/lume/INBOX-MANAGER-SETUP.md` (3d), per-campaign reply modes with the Auto grant (3e; `owner` / `client` /
`auto` on `lume_campaign_reply_modes`, replacing the per-vertical grant sketched above), and the per-vertical webhook
push (3f). 3g (the client Slack app) built 2026-10-29 (not deployed): `lume/lib/slack/*`, `app/api/slack/*`, Settings →
Slack; owner steps in `docs/lume/SLACK-CLIENT-SETUP.md`. Routes and the bot flow: `docs/lume/INBOX-MANAGER-API.md`.

## Decisions (owner, 2026-10-28)

- Send path: through Lume.
- Autonomy: scoped send grant allowed (off by default, owner-only, revocable).
- Push: yes, push to a Grok webhook routine plus /operator poll backstop.
- Approving replies (2026-10-29, fixed policy): a Grok Bot never approves a reply it drafted itself. That includes a
  reply Lume's agent drafted in a chat the same bot started or ran. Someone else approves: the owner, the master bot
  (for another bot's draft), or later the client (3g). Sending with no approver happens only through a campaign's Auto
  mode (3e). Code: `lume/lib/operators/policy.ts` `canApproveSend`, with `drafted_by_operator` recorded on the draft.

## Original questions

1. **Send path.** Sends go through Lume (recommended: one trail, approvals, the bot never sees Instantly keys), or the bot gets its own Instantly key.
2. **Autonomy.** The SOP's "autonomous by written scoped permission" conflicts with the earlier rule "emails always ask".
   - Allow a scoped send grant per vertical (owner-only, revocable), or keep every email on approval.
3. **Push.** The quick start says Grok routines can fire "when something happens" (webhook). If Grok gives a webhook URL, Lume can push positive replies and confirmations to it instead of the bot polling every 10–15 minutes.

## Client Slack agent (owner decisions 2026-10-29)

Clients use **their own Slack workspace**. Lume is a distributable Slack app. Each client installs it with OAuth ("Add to Slack"), and Lume stores one bot token per workspace, encrypted.

**Channel binding.** Each installed channel is bound to one vertical and, optionally, specific campaigns. A client can only ever see leads from the campaigns its channel is bound to.

**Posting replies.** Every positive reply on a bound campaign is posted to the client's channel. The post has three parts:
- A **lead card**: name, title, company, website, phone, LinkedIn, location, the reply, and the CRM stage. Fields come from the lead bank, CRM and the original order. Missing fields are shown as missing and never invented. The owner chooses which fields each client sees.
- The **drafted reply**, written by the Inbox Manager: Grok Bot, or Lume's agent as a fallback.
- Buttons: **Approve**, **Edit** (opens a Slack modal), and **Skip**.

**Client Q&A.** In the thread, `@Lume <question>` runs a read-only lead lookup, scoped to the channel's campaigns. Enrichment that costs money is never triggered by a client; it goes to the owner for approval.

**Per-campaign reply approval mode.** This setting lives on the campaign.

| Mode | Who can approve a send |
|---|---|
| `owner` | Owner, `/operator` or a Grok Bot only |
| `client` | The client in Slack, or the owner |
| `auto` | Nobody needs to. Lume sends after the safety checks (this is the scoped send grant) |

The default is `owner`. Changing the mode is owner-only, and every change is logged.

**Safety in every mode:**
- Re-read the live thread right before sending, and abort if a newer inbound message exists.
- Send at most one reply per inbound message.
- Never send on silence.
- Every send is a `pending_actions` row with `decided_via` set to `client`, `grant` or `owner`, plus the Slack user id of whoever approved it.
- Unsubscribe or hostile replies are never auto-sent.

**Build position:** slot **3g**, after 3b (the send path) and 3c (the bot API). It reuses the positive-reply alerts, the lead lookup, and the approval and grant plumbing. The existing `slack-inbox` function (CSV intake) stays separate.

Owner setup:
1. Create the Slack app from the manifest Lume provides. It needs distribution, OAuth redirect, interactivity and event subscriptions pointing at Lume.
2. Send each client the install link.
3. Bind each channel in Settings.
