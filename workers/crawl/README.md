# Crawl worker (Railway)

Answers "is this website a property manager or a vendor?" for Lume and the edge
functions. It runs on Railway because Supabase edge functions can't run a
headless browser. GTM-17.

- `classify.py`: crawl4ai + Claude Haiku engine. Importable (`classify_domains`) and also a CSV CLI (`python classify.py --help`).
- `app.py`: FastAPI. `GET /health`, `POST /classify` (≤50 domains, header `X-Worker-Secret`).
- Response rows: `{domain, verdict, confidence, reason, linkedin_url, doors_hint, property_type, pages, snippet_chars}`.
  The verdict is one of `property_manager`, `not_property_manager`, `unreachable` or `error`.

## Railway

Root directory `workers/crawl`. It builds from `Dockerfile`, and `railway.json` sets the health check and app sleeping.
Variables:

| Name | Value |
| -- | -- |
| `ANTHROPIC_API_KEY` | Anthropic key |
| `WORKER_SECRET` | long random string, the same one as `CRAWL_WORKER_SECRET` in Vercel and edge secrets |
| `CRAWL_CONCURRENCY` | optional, default 4 (Chromium memory) |
| `CLASSIFY_MODEL` | optional, default `claude-haiku-5-5` |

## Tests

```bash
cd workers/crawl
../../.venv/bin/pip install -r requirements-dev.txt
../../.venv/bin/python -m pytest tests -q                                   # unit, no network
RUN_LIVE=1 ANTHROPIC_API_KEY=… ../../.venv/bin/python -m pytest tests -q -s -k live   # 10 real sites, ~$0.002
RUN_LIVE=1 WORKER_URL=https://… WORKER_SECRET=… ../../.venv/bin/python -m pytest tests -q -s -k live  # deployed worker
```
