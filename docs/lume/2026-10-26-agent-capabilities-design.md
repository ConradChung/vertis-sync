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

## API research results (2026-10-26)

**Instantly v2** (OpenAPI `https://api.instantly.ai/openapi/api_v2.json`; 100 rps / 6,000 per min workspace-wide; `GET /emails` 20/min):
- Lead states: `POST /leads/list` with `campaign` + `filter` (`FILTER_VAL_COMPLETED_NO_REPLY`, `FILTER_VAL_REPLIED`, `FILTER_VAL_BOUNCED`, `FILTER_VAL_CONTACTED`, …; interest `FILTER_LEAD_*`), `limit` ≤100, `starting_after`. Fields: `status` (1 active, 2 paused, 3 completed, -1 bounced, -2 unsub, -3 skipped), `timestamp_last_contact`, `timestamp_last_reply`, `email_reply_count`, `lt_interest_status`, `payload` (custom vars, e.g. country).
- Delete: `DELETE /leads/{id}`; bulk `DELETE /leads` `{campaign_id, ids[]?, status?, limit≤10000}` → `{count}`. Deleting from a campaign frees uploaded-contacts quota after 5–10 min.
- Cap: `GET /workspace-billing/plan-details` → `subscriptions.outreach.current_lead_count` / `total_lead_limit`.
- Inbox: `GET /emails?campaign_id&email_type=received&is_unread&i_status` → `id` (= `reply_to_uuid`), `eaccount`, `from_address_email`, `subject`, `body`, `thread_id`, `i_status`.
- Labels: `POST /leads/update-interest-status` `{lead_email, interest_value, campaign_id}`; 1 interested, 0 OOO, -1 not interested, -2 wrong person, -3 lost, null reset. May mark the lead completed.
- Blocklist: `POST /block-lists-entries` `{bl_value}`; bulk `/block-lists-entries/bulk-create`.

**Leadsfriday:** order `POST /api/export-apollo/` → `{order_id, credits_deducted, new_balance}`. **No count endpoint and no balance endpoint.** Balance = last `apollo_orders.new_balance`. Price $3 / 1,000 (1 credit = $1), fractional.

**mailtester.ninja:** subscription with a daily cap (Pro $23.99/mo, 100k/day); no per-lead price, no balance endpoint. Show plan + daily cap, not a per-lead cost.

**connector-os (finder):** undocumented. `GET /api/email/v2/quota` → `{quota:{remaining, reset_date, bonus_remaining}}`; 1 credit per found email (not-found free); packs ~$0.025–0.033/credit.

**Design impact:** "Apollo count at the gate" / `edit_order` re-count cannot come from Leadsfriday — needs another source (Apollo search API is owner-rejected for enrichment; a count-only call or the existing gate count path must be checked in Phase 4 planning).
