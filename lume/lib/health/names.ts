import type { EnvName } from '@/lib/health/envExample'

/**
 * The secret names Config health checks, derived from the `.env.example`
 * files by `parseLumeEnvExample` / `parseEdgeSecretNames`. They are frozen
 * here because a Vercel function cannot read repo files at runtime;
 * tests/health/names.test.ts re-parses both files and fails on any drift, so
 * edit `.env.example` and then this list.
 */

const req = (name: string): EnvName => ({ name, required: true })
const opt = (name: string): EnvName => ({ name, required: false })

/** lume/.env.example (Vercel). */
export const LUME_ENV_NAMES: readonly EnvName[] = [
  req('NEXT_PUBLIC_SUPABASE_URL'),
  req('NEXT_PUBLIC_SUPABASE_ANON_KEY'),
  req('SUPABASE_SERVICE_ROLE_KEY'),
  req('LUME_ALLOWED_EMAIL'),
  req('LUME_ACTION_SECRET'),
  req('LUME_HOOK_SECRET'),
  req('LUME_MCP_TOKEN'),
  opt('LUME_MCP_WRITES'),
  opt('LUME_MCP_CONFIRM_KINDS'),
  req('LUME_INTERNAL_SECRET'),
  req('LUME_URL'),
  opt('LUME_INTERNAL_URL'),
  req('INSTANTLY_API_KEY'),
  req('INSTANTLY_WEBHOOK_SECRET'),
  req('ANTHROPIC_API_KEY'),
  req('APIFY_API_TOKEN'),
  req('TELEGRAM_BOT_TOKEN'),
  req('TELEGRAM_CHAT_ID'),
  opt('BLITZ_API_KEY'),
  req('SLACK_CLIENT_ID'),
  req('SLACK_CLIENT_SECRET'),
  req('SLACK_SIGNING_SECRET'),
  req('LUME_SLACK_TOKEN_KEY'),
  opt('ROTATE_CAMPAIGN_ID'),
  opt('LUME_AGENT_MODEL'),
  opt('LUME_OWNER_KEY'),
  opt('LINEAR_API_KEY'),
  opt('LINEAR_TEAM_KEY'),
  req('CRAWL_WORKER_URL'),
  req('CRAWL_WORKER_SECRET'),
  opt('ALERT_CHANNELS'),
  opt('JINA_API_KEY'),
  opt('LUME_RESEARCH_APIFY_CAP_USD'),
  opt('LUME_F5BOT_SECRET'),
  opt('PERPLEXITY_API_KEY'),
  opt('LUME_SIGNALS_CLIENT'),
]

/** Root .env.example, edge-function secret block (same list as supabase/functions/config-health/names.ts). */
export const EDGE_ENV_NAMES: readonly EnvName[] = [
  req('TELEGRAM_BOT_TOKEN'),
  req('TELEGRAM_CHAT_ID'),
  req('TELEGRAM_WEBHOOK_SECRET'),
  req('MAILTESTER_API_KEY'),
  req('APIFY_API_TOKEN'),
  req('INSTANTLY_API_KEY'),
  opt('ROTATE_CAMPAIGN_ID'),
  req('ANTHROPIC_API_KEY'),
  opt('LUME_RESEARCH_APIFY_CAP_USD'),
  req('PERPLEXITY_API_KEY'),
  req('CONNECTOR_OS_API_KEY'),
  opt('BLITZ_API_KEY'),
  req('SLACK_BOT_TOKEN'),
  req('SLACK_SIGNING_SECRET'),
  opt('LEADSFRIDAY_BASE_URL'),
  req('GOOGLE_SERVICE_ACCOUNT_JSON'),
  req('JOBSEARCH_SHEET_ID'),
  req('APOLLO_API_KEY'),
  req('LEADSFRIDAY_API_TOKEN'),
  req('LUME_ACTION_SECRET'),
  req('LUME_URL'),
]
