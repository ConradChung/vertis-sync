# Lume agent — capabilities + in-chat approvals (design)

Owner-approved 2026-10-26. Extends the orb agent (`lume/lib/agent/tools.ts`, tiers in
`lume/lib/agent/permissions.ts`). New tools slot into the existing read / low / high tiers;
high-tier tools keep creating `pending_actions` rows, so Telegram and `/actions/<id>` keep working.

## 1. In-chat approvals (foundation, built first)

- A high-tier tool call renders an inline card in the chat: action, target (campaign / rule /
  order), lead count, estimated cost, **Approve** / **Deny**.
- The card decides the same `pending_actions` row Telegram uses (existing decide/execute path,
  same claim/race protection). After a decision the agent run is resumed automatically with the
  outcome; the owner does not type "ok".
- **Skip permissions**: per-conversation toggle, red banner while on, off by default and off on
  every new chat. While on, high-tier actions execute without a card **except**:
  - anything that spends money: `run_apify_actor`, Leadsfriday orders (count choice), validation
    decisions that trigger paid finder/validator work;
  - anything that emails a lead: `send_reply`.
  Those still show a card. Every auto-approved action is still a `pending_actions` row (decided
  by "skip mode"), so the audit trail is unchanged. Spending caps (Apify $20) still apply.

## 2. Lead cycling + contact cap

| Tool | Tier | Behaviour |
|---|---|---|
| `list_campaign_leads` | read | Leads in a campaign by state: sequence finished, replied, bounced, no reply after N days. |
| `contact_usage` | read | Instantly uploaded contacts vs plan limit, headroom. |
| `remove_leads` | high | Deletes leads from Instantly (only delete frees the cap). Lume snapshots each lead first and marks it `cycled_out`; CRM deal + history stay. Replied / interested leads are always skipped. |
| Cycle-out rule | new rule kind | Daily: remove leads whose sequence finished > N days ago with no reply, then refill up to a target count from the lead bank. Created inactive; activation goes through approval like rotation rules. |

Replied and bounced leads are never auto-removed by the rule.

## 3. Replies

- `list_replies` (read): campaign inbox — reply text, `reply_to_uuid` (email id), receiving
  `eaccount`. Feeds `draft_reply` / `send_reply`.
- `label_reply` (low): sets Instantly lead interest status (interested, not now, wrong person,
  not interested) and moves the matching CRM deal stage. "Unsubscribe" also adds the address to
  the Instantly blocklist.

## 4. Costs + orders

- `get_costs` (read): per-lead prices and credit balances.
  - **Leadsfriday: fixed $3 per 1,000 leads ($0.003/lead); fractional credits allowed**, so order
    cost = count × 0.003 exactly, no rounding to whole credits. Balance = API if available, else
    last `new_balance` recorded on `apollo_orders`.
  - connector-os (email finder), mailtester.ninja (validator): balance via API where one exists,
    otherwise last-known; prices from an owner-editable settings table.
- `edit_order` (low): change an order's Apollo search (drop countries, change titles) while the
  order is still before the count is placed; re-runs the count so the owner sees the new number
  and exact cost before anything is spent.

## 5. Reporting + cleanup

- `reply_rates` (read): reply / interested / bounce rates by country, title or campaign, joined
  to lead-bank attributes per lead.
- `edit_rule`, `delete_rule`, `cancel_order` through approval cards. Cancel only before money is
  spent.

## Errors

A missing key or failed API returns an explicit "not configured" / error to the agent; tools never
fabricate counts, balances or prices.

## Testing

Unit tests per tool (input schema, response mapping per service). Approval-card state tests:
approve, deny, skip-mode auto-run, money/email exceptions still prompting, concurrent decisions.
pgTAP extended for the cycle-out rule kind and any new pending kinds.

## Build order

1. In-chat approvals + skip mode
2. Lead cycling + contact cap
3. Replies
4. Costs + orders
5. Reporting + cleanup

Each phase reviewed and deployed before the next.

## Open (resolve during planning)

- Instantly v2 endpoints: lead list filters for sequence state, lead delete (bulk), uploaded
  contact count / plan limit, interest status, blocklist.
- Balance endpoints for Leadsfriday, connector-os, mailtester.ninja.
- Leadsfriday count endpoint for re-counting an edited Apollo search.
