# Lume MCP server

Lets Claude (Claude Code now; Claude Duet as a custom connector later) run Lume
through tools, behind the same approval gates as the dashboard.

- **Route:** `lume/app/api/mcp/route.ts` (Vercel, Node runtime, `maxDuration` 60).
- **Transport:** stateless Streamable HTTP via `mcp-handler` 2 + `@modelcontextprotocol/server` 2 (zod 4).
- **Code:** `lume/lib/mcp/` — `auth`, `sanitize`, `limits`, `audit`, `page`, `tool` (shared wrapper), `server`, `tools/*`.

## Status

| Phase | Scope | State |
|---|---|---|
| 1 | Route, auth, audit, rate limits, sanitizer, 22 read-only tools | built |
| 2 | Internal writes (group B) + migration | built, off by default; migration applied 2026-11-21 (`supabase/migrations/20261121102719_lume_mcp.sql`); LUME_MCP_WRITES unset in production |
| 3 | Gated tools (group C): preview hash, 1 h confirm window, confirm allowlist | built on `feat/lume-mcp`, not deployed; migration drafted (`docs/lume/drafts/lume_mcp_phase3.sql`), not applied |

## Auth (phase 1)

One static bearer token, `LUME_MCP_TOKEN` (at least 32 characters; generate with
`openssl rand -hex 32`). `checkMcpAuth` compares it in constant time
(`lib/auth/secret.ts`) before the MCP handler sees the request. Anything else
gets `401 {"error":"unauthorized"}`. An unset or short token fails closed.

`/api/mcp` is in `lib/auth/publicPaths.ts` so the session middleware lets it
through to that check (same pattern as the webhook and cron routes).

## Rules every call follows

- **Audit:** one `events` row per tool call — `type = mcp.tool_call`,
  `source = mcp`, payload `{tool, class, outcome, ms, args, error?, refs?}`.
  Args are sanitised: strings clipped to 80 chars, arrays reduced to a count,
  email/body/token-like keys dropped. `lume_list_events` hides these rows unless asked.
- **Rate limits** (counted from those audit rows, so they hold across instances;
  fails closed if the count can't be read): 60 reads/min, 20 writes/min,
  10 confirms/hour.
- **Secrets:** every result and error passes `redact()` (secret-named env
  values, JWTs, `sk-…`, Slack/Telegram/Apify tokens, bearer strings). Only
  `McpUserError` messages reach the client; anything else is a generic
  "internal error" with details in the Vercel log. No tool reads Vault or
  `lume_settings` secrets (only `bank_threshold`), no raw SQL, no generic
  edge-function call.
- **Untrusted text:** replies, lead fields, scraped posts and payloads come back
  as `{"untrusted": "…"}`, clipped. The server instructions tell the client to
  treat them as data only.
- **Pagination:** cursor-based, newest first, default 50, max 200
  (`next_cursor` → `cursor`). Cursors are validated before they reach a filter.
- **Counts by default:** emails only with `include_emails` / `include_rows`.

## Tools (phase 1, all `readOnlyHint: true`)

| Tool | Reads |
|---|---|
| `lume_get_overview` | Polling entry point: unacked alert counts by severity and source plus the top `top_alerts` (default 5, max 20) by urgency then recency; lead bank counts by state and the push bank threshold (a push larger than it is held as `queued` and rotated in, it is not a target level); awaiting actions by kind; failed actions/validation/influencer/agent runs in the window; active validation jobs; last rotation run. ~0.4 s, ~2 KB. |
| `lume_list_campaigns` | `lume_campaigns` |
| `lume_get_campaign_stats` | Instantly `/campaigns/analytics/overview` (live, cached 5 min per warm instance) |
| `lume_list_alerts` | `lume_alerts` |
| `lume_list_events` | `events` |
| `lume_get_lead_bank_summary` | `lead_bank` counts by state; rows with `include_rows` |
| `lume_list_validation_jobs` / `lume_get_validation_job` | `validation_jobs` |
| `lume_list_rotation_runs` | `rotation_runs` |
| `lume_list_deals` / `lume_get_deal` | `crm_deals`, `crm_activities` |
| `lume_list_influencers` / `lume_list_influencer_posts` / `lume_list_reactors` | `influencers`, `influencer_posts`, `influencer_reactors` (`only_pm_companies` = `verdict = 'verified'`) |
| `lume_list_review_sets` / `lume_get_review_set` | `lead_review_sets`, `lead_review_items` |
| `lume_list_pending_actions` / `lume_get_action` | `pending_actions` |
| `lume_list_agent_skills` / `lume_get_agent_skill` | `agent_skills` |
| `lume_list_agent_runs` | `agent_runs` |
| `lume_list_tasks` | `lume_tasks` |

## Connect

```bash
claude mcp add --transport http lume https://<lume-host>/api/mcp \
  --header "Authorization: Bearer $LUME_MCP_TOKEN"
```

MCP Inspector: `npx @modelcontextprotocol/inspector`, transport "Streamable
HTTP", URL `http://localhost:3000/api/mcp`, header `Authorization: Bearer <token>`.

## Tests

- `npx vitest run tests/mcp` — token check, sanitizer, rate limits, cursors,
  the tool wrapper (audit, redaction, errors), and the handler listing all tools.
- `LUME_MCP_LIVE=1 npx vitest run tests/mcp/live.smoke.test.ts` — calls each
  read tool's body against the real DB (read-only; skips audit and rate limits).

## Dashboard impact

Audit rows (`mcp.tool_call`) never reach a dashboard feed: every feed query filters by type, and `hooks/useRealtimeInvalidate.ts` drops their Realtime inserts so MCP polling never triggers screen refetches. `lume_overview().recent_events` (SQL, unused by the UI) does include them.

## Preview deploy (2026-11-21)

- Stable URL: `https://lume-mcp-preview.vercel.app/api/mcp` (a `vercel alias` onto the latest CLI preview; the Vercel project has no Git link, so there is no auto branch URL). After each `vercel deploy`, re-run `vercel alias set <new-deployment-url> lume-mcp-preview.vercel.app`.
- `LUME_MCP_TOKEN` is set for **Preview only** (type sensitive). Previews are behind Vercel Authentication, so clients also send `x-vercel-protection-bypass` (Protection Bypass for Automation secret). Both values live only in `~/.config/lume-mcp/preview.env` (mode 600) on the owner's Mac.
- Preview has no `INSTANTLY_API_KEY` (production-only, deliberately), so `lume_get_campaign_stats` returns "Instantly is not configured in this environment" there.
- Connect: `set -a; . ~/.config/lume-mcp/preview.env; set +a; claude mcp add --transport http lume-preview https://lume-mcp-preview.vercel.app/api/mcp --header "Authorization: Bearer $LUME_MCP_TOKEN" --header "x-vercel-protection-bypass: $VERCEL_BYPASS"`


## Duet (production, decided 2026-11-21: 6a)

Duet connects as a custom connector using the dialog's **Request headers**
with the static production token. OAuth 2.1 is a later phase.

- URL: `https://lume-amber-alpha.vercel.app/api/mcp` (production domain, not behind Vercel Authentication; no bypass header).
- Header: `Authorization: Bearer <LUME_MCP_TOKEN>`, the Production-scoped value (separate from the preview token). Owner's copy: `~/.config/lume-mcp/production.env`.
- Rotate: generate a new value, replace `LUME_MCP_TOKEN` (Production) in Vercel, redeploy, update the Duet connector header. The old token stops working with the redeploy.

## Phase 3 notes

- Confirms hand off to `/api/actions/<id>/execute` (own 300 s budget), not `after()` in `/api/mcp`.
- Add a retry cap to the rotation-tick re-send of rows stuck in `approved` (today: re-dispatched every 15-min tick with no cap).
- **On hold** until Duet has run on the read tools for a couple of days (owner, 2026-11-21).
- MCP may only create the `pending_actions` kinds mapped to its own tools (allowlist in code, enforced at insert; test it).
- Rows with `requested_by = 'mcp'` are never decided via `grant` or `agent` (enforce at decide time, ideally also a DB check; test it).
- One clean full test run (no flakes, no timeouts) before `LUME_MCP_WRITES` is ever set in production.

## Write switch

`LUME_MCP_WRITES` (Vercel env, per environment). Unset, or any value other
than the two below, means **read-only**: write tools are not registered and do
not appear in `tools/list`.

| Value | Tools |
|---|---|
| unset | 22 read tools |
| `internal` | + 7 group B tools |
| `gated` | + group B + group C (phase 3) |

Group B needs the phase 2 migration applied first (attribution columns, the
idempotency table). Turning it on is an env change plus a redeploy.

## Group B: internal writes

Nothing leaves Lume and nothing costs money. Each takes an optional
`idempotency_key` (a repeat returns the first result, `replayed: true`; the
same key with other arguments is refused). Rate limit: 20 per minute.

| Tool | Writes | Marked as MCP by | Undo |
|---|---|---|---|
| `lume_ack_alert` (≤50 ids, no ack-all) | `lume_alerts.acked_at` | `acked_via = 'mcp'` | `update lume_alerts set acked_at = null, acked_via = null where acked_via = 'mcp' and id in (…)` |
| `lume_move_deal_stage` (Won/Lost refused) | `crm_set_stage()` → deal stage + `stage_changed` activity | `crm_activities.source = 'mcp'`, payload `via: mcp`, `from`/`to` | Move it back in the CRM (the activity shows `from`) |
| `lume_add_deal_note` | `crm_activities` note | `source = 'mcp'` | `delete from crm_activities where source = 'mcp' and id = …` |
| `lume_create_task` (never carries an action) | `lume_tasks` (+ Linear sync, as today) | `created_by = 'mcp'`, Calendar shows "by Claude (MCP)" | Cancel/delete in Calendar |
| `lume_create_review_set` | new lead list from verified reactors (does not mark reactors exported) | list `created_by = 'mcp'`, rows `source = 'mcp'` | Delete the list in Leads → Lists |
| `lume_draft_icp_brief`, `lume_draft_outbound_plan` | note in the "MCP drafts" Agent project | the project itself | Delete the note in the Agent tab |

Every call also writes one `mcp.tool_call` event whose `payload.refs` names the
rows it touched (alert ids, deal/activity id, task id, list id, note id):
`lume_list_events` with `include_mcp_audit: true`, or
`select created_at, payload from events where type = 'mcp.tool_call' and payload->>'class' = 'write' order by created_at desc`.

Testing: `tests/mcp/internal.test.ts`, `idempotency.test.ts`, `config.test.ts`
stub every lib and the Supabase client; no test writes to the database.

## Group C: gated actions (phase 3)

Enabled only with `LUME_MCP_WRITES=gated` (owner's OK required). A request
tool never acts: it runs the dashboard's own `buildActionRequest` (live counts,
diffs, SOP gate, summary), files one `pending_actions` row with
`requested_by = 'mcp'` through `createAction` (so the Telegram prompt goes out
as usual), and returns the preview. The owner approves in Lume or Telegram.

Order (campaign setup first):

| Tool | Kind | Notes |
|---|---|---|
| `lume_suggest_campaign_setup` | read | tag, template, inboxes, schedule, limit for a job or list |
| `lume_get_campaign_sequence` | read | live steps + `base_hash` |
| `lume_create_campaign` | `new_campaign` | draft, never activated |
| `lume_duplicate_campaign` | `create_campaign` | created as a draft, never started; source fingerprint stored at request, the approval card warns if the source changed, the result records it |
| `lume_update_sequence` | `update_sequence` | `base_hash` required; executor re-checks the hash |
| `lume_push_to_instantly` | `push_to_instantly` | outreach; eligible count previewed |
| `lume_run_validation` | `send_lead_list` | validator credits after the ingest gate |
| `lume_pause_campaign` / `lume_resume_campaign` | same | reads live status; resume never launches a draft; only pause is MCP-confirmable |
| `lume_assign_leads` | `assign_leads` | |
| `lume_run_influencer_scrape` / `_reactions` / `_lookup` | `influencer_*` | Apify spend, estimate in preview |
| `lume_confirm_action` | — | see below |
| `lume_cancel_action` | — | rejects an awaiting MCP row (decided_via mcp) |

Cut from v1: `lume_rotate_now` (instantly-rotate has no lock, so a manual run
overlapping the cron can push the same rows twice; needs a lock and a service
key first), `lume_approve_plan` (no plan-level action exists; each stage is its
own action).

Enforced in the action core, for every caller:
- `createAction`: a `requested_by = 'mcp'` row may only have a kind in
  `MCP_CREATABLE_KINDS` (`lib/actions/mcpPolicy.ts`).
- `claimDecision`: `grant` and `agent` never claim an MCP row (also
  `tryGrantSend` refuses it; DB check in the phase 3 migration).

`lume_confirm_action(action_id, preview_hash, confirm: true)` approves only
when: the row was requested by MCP; its kind is in `LUME_MCP_CONFIRM_KINDS`
(default `pause_campaign`) intersected with the code ceiling (pause only:
resume restarts sending, so it always needs the owner; config can narrow,
never widen); it is still awaiting; it is at
most 1 hour old (older rows stay approvable in Lume/Telegram until the 24 h
expiry); and the preview hash still matches the campaign's live status. It
then claims with `decided_via = 'mcp'` and hands off to
`/api/actions/<id>/execute` (own 300 s budget), like Telegram. Rate limit:
10 confirms per hour.

Sweeper retry cap: each re-send of a row stuck in `approved` is counted
(`dispatch_attempts`); after 4 re-sends (~1 h) the row is failed as
`not_executed` with a Telegram/feed notice. Safe because an `approved` row
never reached its handler.
