# Research + signal layer, jurisdiction, cold-email SOP — design (2026-10-29)

Owner brief: extend enrichment into a research + signal layer, add jurisdictions, and give the agent a
cold-email SOP it uses and is linted against. Findings that shaped this design (vs the brief's assumptions):

- No crawler exists today. `operating-city-enricher` = Perplexity `sonar` → Haiku (`claude-haiku-4-5`) →
  `{operating_city, secondary_cities, confidence, icp_status}`, no source URLs, stored per job in
  `validation_rows.enrichment` / `row_data`.
- No companies table. `lead_bank` is flat text (`company_name`, `website`, `company_domain`, `operating_cities`).
- `instantly-push` sends only `location` + `Operating Cities Copied` custom variables.
- The Agent's pipeline graph is model-written ```flow JSON (`lume/lib/agent/diagram.ts`), not code-built.
- Copy is drafted in chat; `update_campaign_sequence` → `update_sequence` approval (`lib/actions/build.ts`,
  `execute.ts`) is the approval gate.

## Owner decisions (2026-10-29)

- **No Google reviews** for now (most expensive actor). Drop `review_signal`, `review_spike`. Priority becomes
  open_role > door_count > pms > jurisdiction.
- **Apify budget: $29 / calendar month** for this layer (crawl + job search + re-crawl). Every run is priced
  before it starts; month-to-date spend (sum of `company_crawls.cost_usd`, plus Apify's account monthly usage
  when readable) must stay under the cap; the scheduler stops for the month when the next run would cross it.
  Cap is a config value (`LUME_RESEARCH_APIFY_CAP_USD`, default 29), never hardcoded in prompts.
- **SOP format:** `lume/sops/cold-email-sop.md` with a YAML front-matter block (machine rules for the linter)
  and prose below. Plus `lume/sops/cold-email-sop.Rmd` that knits to PDF from the same `.md` (single source:
  the Rmd reads the md, renders the rules as tables and the prose as body; it never duplicates content).
- **No backfill** of existing `lead_bank` / `validation_rows` data. `companies` fills only from new research.
  Owner will run baseline campaigns without personalization variables first.
- Edge functions (not n8n). Haiku for extraction (move to `claude-haiku-5-5`), stronger model
  (`claude-opus-5-5`) only for copy drafting. Every extracted value needs a source URL. Nothing reaches
  Instantly without the approval gate.

## Phases

- **P1 Schema** — `companies` (normalized domain, unique), `lead_bank.company_id` (nullable fk, no backfill),
  `company_facts` (company_id, field, value jsonb, confidence high|medium|low, source_url, snippet,
  extracted_at, crawl_id; history kept), `company_crawls` (snapshot: pages, cost_usd, status, started/finished),
  `signals` (company_id, signal_type, detail, detected_at, source_url, expires_at default +30d, dedupe key),
  `jurisdictions` (editable config: country, region, city match, jurisdiction, compliance_name, authority,
  copy_hook, verified_at, active), `lead_personalization_log` (lead, campaign, field_used, rendered, at).
  RLS on, service role only.
- **P2 Extraction** — edge function `company-research`: Apify website crawler (cheerio, ≤8 pages: home, about,
  contact, careers, residents/portal); deterministic PMS detector over crawled links (portal host = high, text
  mention = medium; appfolio / managebuilding (buildium) / rentmanager + rmportal / propertyware / rentcafe
  (yardi) / other / unknown); Haiku extracts door_count, after_hours, city, region, country with exact snippet +
  page URL; a value is kept only if its snippet occurs verbatim in that page's text. door_count stored raw plus
  `copy_value` rounded down. Budget gate before every run.
- **P3 Signals** — open_role first (careers page from the crawl + an Apify job-board actor; PM titles:
  maintenance coordinator, property manager, leasing agent/consultant, assistant property manager);
  `signals-recrawl` cron diffs snapshots → door_growth, new_market. Expiry filtered at query time. Budget-gated.
- **P4 Jurisdiction** — resolver from (country, region, city) to a `jurisdictions` row; seeds BC RTA/RTB,
  ON RTA/LTB, UK Renters' Rights Act (status verified at build time, stored in the table only), UAE/Dubai
  RERA/Ejari, US state rows with null hook.
- **P5 Render** — `lib/copy/render.ts`: one field per lead by priority, high confidence only, else the SOP
  fallback sentence; Instantly custom vars `{{hook}}` + `{{hook_field}}`; log to `lead_personalization_log`.
  Only through existing approval-gated assign/push paths.
- **P6 SOP** — md + Rmd; SOP loaded as its own cached system block on every agent run; `lib/copy/sopLint.ts`
  (banned phrases, word count, proof point repeated in thread, subject casing, >1 personalization field,
  step-1 yes/no meeting CTA); lint runs when the `update_sequence` approval is built AND in the executor before
  writing; failures block and name the rule + step.
- **P7 Agent** — `research_company(url)` tool (runs P2–P4, returns facts + a server-built flow spec whose
  nodes carry their source URLs in `details.data`); `draft_sequence` tool (claude-opus-5-5 + SOP + facts,
  linted).
- **P8 Campaigns** — "Live signals" filter → lead set → existing assign approval.
