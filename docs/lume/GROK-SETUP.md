# Running Lume with Grok Bots

How to hand each line of business (a **vertical**) to its own Grok Bot, how the
master bot stands up new verticals, and how to switch Telegram off once this
works. Written for Conrad; the boxed blocks are meant to be pasted into Grok
Bot as they are, after filling in the `<…>` parts.

Lume production: `https://lume-amber-alpha.vercel.app` (below: `<LUME>`).

## 1. What Grok Bot needs

- **An xAI plan that includes Grok Bot.** Grok Bot is xAI's always-on cloud
  agent. It has no API or webhook that Lume could call, so it uses Lume the
  way you do: through its own browser.
- **One operator key per bot.** A key is a sign-in link,
  `<LUME>/auth/operator?k=…`. Opening it signs the browser in with **your
  full owner rights** and marks every decision as made by that bot
  (`decided_via = operator`). Lume shows the link **once**, when you create
  the key, and keeps only a hash.
  - Create keys in **Settings → Verticals** (`<LUME>/settings/verticals`): use
    "Generate key" on a vertical, or "New master key". Copy the link straight
    into the bot's instructions.
  - Only your own browser session can mint or revoke keys. A bot signed in
    with a key can see the list but not change it.
  - Revoke a key in the same list; the bot is signed out at once. To rotate a
    key, generate a new one and then revoke the old one.
- **Hard limits still hold for bots.** Apify runs are capped at $20 each,
  Leadsfriday orders start at 500 contacts, and anything that sends, spends or
  launches is still an approval. A bot can approve those approvals, which is
  the risk you accepted. The rules in section 2 are what keep it in bounds.

## 2. Instructions for each vertical's bot

Paste this as the bot's standing instructions. Fill in the vertical, the link
and the thresholds.

```text
ROLE
You are the <VERTICAL NAME> operator for Conrad's outbound system, Lume.
You run one line of business: <one line: offer and who it targets>.
Your campaigns: <campaign names or ids from Settings → Verticals>.
You act only through Lume in your browser. Conrad is the owner; you report to him.

SIGN-IN
Sign-in link (secret; never share it, paste it anywhere else or put it in a message):
<LUME>/auth/operator?k=<KEY>
If a Lume page sends you to /login, open the sign-in link again. If that also
lands on /login, your key was revoked: stop and tell Conrad.

CONFIRMATION RULES (what you may approve yourself)
Approve on your own:
- Leadsfriday orders costing $<X> or less (the count × $0.003; e.g. 1,000 contacts = $3.00).
- Validation of CSV imports of <N> rows or fewer (Approve, not Approve + Enrich).
- "Validate only" on the email-finder prompt.
- Picking the Instantly campaign for a validated job when the name is in your campaign list.
- Resuming a stalled job (Resume).
Escalate everything else to Conrad and leave it waiting, including:
- Any Leadsfriday order over $<X>, "Order anyway" below the 500 minimum, or "Reviewed, pull".
- Any Apify actor run (shows its cap; any amount).
- Approve + Enrich, "Find them first" (email-finder credits) and validations over <N> rows.
- Pushing leads to Instantly, launching or resuming a campaign, editing a sequence.
- Anything about a campaign that is not yours, or that you do not understand.
To escalate, message Conrad with: what it is, the target, the lead count and
the cost exactly as Lume shows them, and the link to the item.

NEVER
- Never send a reply to a lead without Conrad's OK.
- Never launch, resume or push leads to a campaign without Conrad's OK.
- Never revoke, mint or share operator keys, and never open Settings → Verticals to change anything.
- Never deny something just to clear the list; if unsure, escalate.
- Never approve an item twice or retry a failed approval; report the failure.
```

Example thresholds to start with: **$X = 3** (about 1,000 contacts) and **N =
1,000 rows**. Raise them once a week of check-ins looks right.

## 3. Routine prompt (every 10–15 minutes)

Set this as the bot's recurring task.

```text
Check in on Lume:
1. Open <LUME>/operator.
2. Read the JSON in the block with id "operator-summary": vertical,
   needs_confirmation, unacked_alerts, urgent_alerts, last_checked_at.
3. If needs_confirmation > 0, go through the "Needs confirmation" table top to
   bottom (money items come first). For each row, apply the CONFIRMATION
   RULES: click Approve / the matching button for what you may approve, and
   escalate the rest to Conrad. For a Leadsfriday count, use an "Order N"
   button or the custom count box only within your limit. For "Pick a
   campaign", type the campaign name in the box and press "Set campaign"; if
   several match, pick the exact one from the list. After each click the page
   reloads with a green message (done) or a red one (read it; report it if it
   is an error).
4. If urgent_alerts > 0, send Conrad each urgent alert's title and body, then
   press Acknowledge on it. Acknowledge the other alerts once you have read
   them ("Acknowledge all" is fine when none needs action).
5. Glance at "Recent outcomes": tell Conrad about anything that failed.
6. If nothing needed you, do not message Conrad.
```

Lume cannot wake the bot, so the delay between a gate opening and a decision is
the routine interval.

## 4. First-run test checklist

Do this once per new bot, with Conrad watching.

1. Open the sign-in link in the bot's browser. It should land on
   `<LUME>/operator` with "Signed in as Grok Bot “<label>”" and the "Operator:
   <vertical>" chip in the header.
2. In Settings → Verticals, the key's "Last check-in" shows "just now".
3. On Overview, the vertical's card shows the check-in (not red).
4. Have the bot read `#operator-summary` back to you; it should match the
   page.
5. Paste a small Apollo search link into the bot's "Apollo search link" box
   (or ask it to). A "Leadsfriday count" row appears under Needs
   confirmation with the cost; have the bot press **Cancel** (nothing is
   spent).
6. Upload a small test CSV through the bot's "CSV upload". It appears as a
   "CSV approval" row; have the bot press **Deny**.
7. After each click the page comes back with a green message and the row is
   gone. Pending-action decisions show under "Recent outcomes" as "Grok Bot
   “<label>”"; gate decisions (like this Deny) are logged as events named
   after the bot.
8. Ask the bot to send you one test alert summary and acknowledge alerts.
9. Revoke-and-reissue drill (optional): revoke the key, confirm the bot is
   sent to /login, issue a new key and update its instructions.

## 5. The master bot

One Grok Bot holds a **master key**: it sees every vertical on `/operator`
(grouped by vertical) and is the one that stands up new verticals.

Master instructions (paste, after the per-bot template's NEVER list):

```text
ROLE
You are the master operator for Conrad's outbound system, Lume. You see every
vertical. Your job: watch all verticals for things their own bots missed, and
stand up new verticals when Conrad asks.

SIGN-IN
<LUME>/auth/operator?k=<MASTER KEY>

ROUTINE (every 30 minutes)
Open <LUME>/operator. Items under "No vertical (owner)" are yours to escalate
to Conrad. For a vertical whose bot has not checked in for over 30 minutes
(red on the Overview "Verticals" strip), tell Conrad. Do not decide items that
belong to a vertical with a working bot.

NEW VERTICAL PLAYBOOK
When Conrad asks for a new vertical, open <LUME>/agent and ask Lume's agent
to stand it up. The agent will, step by step and asking you between steps:
1. research the market and the Apify lead sources,
2. propose the pipeline as a diagram (actor → filter → validation → campaign and sequence),
3. build it with approvals (every spend or send is an approval card; apply your confirmation rules),
4. create the vertical (name, scopes, campaigns),
5. offer to issue an operator key for it.
When you approve the key, the sign-in link appears ONCE on the approval card
(or in the agent's reply if skip permissions is on). Copy it immediately into
the new bot (section "Handing a key to a new bot"). It is never shown again;
if lost, ask Conrad to revoke it and issue another.
Never ask for a master key; only Conrad mints those.
```

Handing a key to a new bot:

1. Create a fresh Grok Bot.
2. Paste the per-vertical template (section 2) with that vertical's name,
   campaigns and thresholds, and the sign-in link from the card.
3. Paste the routine prompt (section 3) as its recurring task.
4. Run the first-run checklist (section 4).
5. Tell Conrad the bot is live. Do not keep the link anywhere else.

## 6. Cutover: Telegram off

Every notification already goes to the Lume alert feed (`lume_alerts`, shown
on `/operator`) as well as Telegram. `ALERT_CHANNELS` decides whether Telegram
still gets them; unset means both.

1. **Turn Telegram notifications off** (both places; the edge functions and
   Lume read their own copy):
   ```bash
   cd ~/vertis-sync/lume
   npx vercel env add ALERT_CHANNELS production   # value: feed
   npx vercel env add ALERT_CHANNELS preview      # value: feed (optional)
   npx vercel --prod                              # redeploy so the function picks it up
   cd ~/vertis-sync
   supabase secrets set ALERT_CHANNELS=feed --project-ref rcfrumrbauwvyzfebxck
   ```
   Edge functions read secrets at start-up, so the next cold start uses it.
   To roll back, set `ALERT_CHANNELS=telegram,feed` in both places.
2. **Watch for 3 days.** Each day check: every vertical card on Overview has a
   recent check-in; `/operator` (all verticals) has no old items under Needs
   confirmation; Recent outcomes show the bots deciding; nothing that used to
   ping Telegram is missing from the alert feed.
3. **Retire Telegram** once the three days are clean: remove the Telegram bot
   webhook and stop using the chat. Keep the `telegram-inbox` function
   deployed: it is still the decision entrypoint Lume calls (`X-Lume-Secret`)
   for every gate.

### What still lives only in Telegram

| Telegram-only piece | Lume equivalent | Matters after cutover? |
| --- | --- | --- |
| Reply to the campaign-name prompt (`awaiting_campaign`) | `/operator` "Pick a campaign" name box (same matching: exact name wins, one match is picked, several are listed) and the `/validate` campaign panel | No, covered |
| Tap a campaign from the "N campaigns match" list (`camp_pick`) | Pick buttons on `/operator` after a several-match search, and stored candidates | No, covered |
| Reply to the Leadsfriday count prompt with a custom count | `/operator` custom count box (500–50,000) | No, covered |
| Location / company barrier toggles, stricter names (`bar_loc`, `bar_co`, `push_strict`, `push_std`) | `/validate` push panel (linked from the `/operator` row) | No, covered |
| Continue to the name review (`push_next`) | `/operator` "Push these" files the push confirmation directly | No, covered |
| Apply a sequence template to a campaign with no copy (`camp_tpl`) | None. The agent's `update_campaign_sequence` (an approval) can write the copy | Yes, when a fresh campaign has no sequence; use the agent |
| Create the no-location sibling campaign (`camp_nolo`) | None. The agent can `duplicate_campaign` + `update_campaign_sequence` | Yes, only for jobs with leads that have no city; use the agent or turn the location barrier on |
| "Stop tracking" a Leadsfriday order (`lfo_abort`) and leadsfriday-order's edit that strips that button from the receipt | None in the UI yet: the entrypoint accepts `lfo_abort` from Lume, but no screen has the button. The button-strip edit is Telegram cosmetics | Stop: rarely (a wrong order keeps being polled until it delivers or times out). The edit: no |
| Paste `lf <order id>` to re-track an order | None | Rarely; ask Conrad to re-track from Telegram before it is retired, or add it to Lume later |
| CSV sent as a Telegram document, Apollo link pasted in the chat | `/operator` CSV upload and Apollo link boxes, and the Import screen | No, covered |
| Approving a Lume pending action with `lume_ok` in Telegram | Approve on `/operator`, the agent card or `/actions/<id>` | No. An operator-key request cannot be approved from Telegram at all (its link must be shown once in Lume) |

## 7. Seeded verticals

| Vertical | Default | Scopes | Campaign ids | Status |
| --- | --- | --- | --- | --- |
| Job search / GTM roles | no | orders, validation, campaign | `gmail:recruiter` (Recruiter · GTM engineers, Gmail), `muse:auto-apply` (Muse auto-apply) | Mapped. No Instantly campaign, so `/operator` shows no send stats for it |
| Kaspen / Zenport | **yes** (gets anything unrouted) | orders, validation, campaign | `04ca2257-5ea6-434e-bf62-f55add156914`, `869d73b3-5bf3-4f1c-ba8c-43ac6d0f529d` (Instantly) | Mapped |
| HNWI / wealth management | no | validation, campaign | none | **Needs campaigns: fill in Settings → Verticals** |
| PM reactions | no | campaign, validation | none | **Needs campaigns: fill in Settings → Verticals** |
| Roofers | no | campaign | none | **Needs campaigns: fill in Settings → Verticals** |

The "Muse" seed is not a separate vertical: migration
`lume_seed_muse_vertical` added `muse:auto-apply` to Job search / GTM roles.

Routing, in order: an item whose campaign is in a vertical's list goes to that
vertical; else, if exactly one vertical has the item's scope, to that one;
else to the default (Kaspen / Zenport). Several verticals share `validation`
and `campaign`, so until HNWI, PM reactions and Roofers have campaign ids,
their items land on Kaspen / Zenport's page. Map their campaigns before
handing them to bots.
