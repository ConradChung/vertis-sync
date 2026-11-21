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
| 2 | Internal writes (group B) + migration | not started |
| 3 | Gated tools (group C): preview hash, 1 h confirm window, confirm allowlist | not started |

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
| `lume_get_overview` | Polling entry point: unacked/urgent alerts, lead bank queued vs `bank_threshold`, awaiting actions by kind, failed actions/validation/influencer/agent runs in the window, active validation jobs, last rotation run. ~0.4 s. |
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
