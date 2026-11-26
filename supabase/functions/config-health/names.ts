// Edge-function secret names, copied from the commented block in the root
// `.env.example` ("Supabase edge-function secrets"). Names only, never values.
// lume/tests/health/names.test.ts fails when this list and that file drift.
export const EDGE_SECRET_NAMES = [
  'TELEGRAM_BOT_TOKEN',
  'TELEGRAM_CHAT_ID',
  'TELEGRAM_WEBHOOK_SECRET',
  'MAILTESTER_API_KEY',
  'APIFY_API_TOKEN',
  'INSTANTLY_API_KEY',
  'ROTATE_CAMPAIGN_ID',
  'ANTHROPIC_API_KEY',
  'LUME_RESEARCH_APIFY_CAP_USD',
  'PERPLEXITY_API_KEY',
  'CONNECTOR_OS_API_KEY',
  'BLITZ_API_KEY',
  'SLACK_BOT_TOKEN',
  'SLACK_SIGNING_SECRET',
  'LEADSFRIDAY_BASE_URL',
  'GOOGLE_SERVICE_ACCOUNT_JSON',
  'JOBSEARCH_SHEET_ID',
  'APOLLO_API_KEY',
  'LEADSFRIDAY_API_TOKEN',
  'LUME_ACTION_SECRET',
  'LUME_URL',
] as const
