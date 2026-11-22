#!/usr/bin/env python3
"""
classify.py — zero-bloat ICP filter (library + CLI).

Used two ways:
  * Library: `await classify_domains(domains, rules)` → one result dict per domain
    {domain, verdict, confidence, reason, linkedin_url, doors_hint, ...}. The
    Railway worker (app.py) wraps this behind POST /classify.
  * CLI: CSV in → CSV out (below), unchanged from scripts/icp_filter_crawl4ai.py.

Pipeline per company domain:
  1. Crawl "/" with Crawl4AI (boilerplate tags stripped, external links dropped,
     PruningContentFilter or BM25ContentFilter) and read ONLY fit_markdown.
  2. Subpage sniper: if the homepage is thin (<400 chars) or carries no
     business-model signal, crawl up to N high-signal internal paths
     (/about, /services, /properties, /who-we-serve, /solutions ...).
  3. Cap the combined snippet at 2,500 chars (~600 tokens).
  4. Classify with Claude (default claude-haiku-5-5) using structured output.

Outputs  <out>_qualified.csv, <out>_disqualified.csv, <out>_unreachable.csv
(original columns + is_icp, confidence, property_type, estimated_doors, reason,
icp_status, icp_snippet_chars). Progress is checkpointed to
<out>.checkpoint.jsonl after every domain, so re-running the same command resumes.

Example:
  .venv/bin/python workers/crawl/classify.py \
      --input ~/Downloads/list.csv --output ~/Downloads/list_icp \
      --icp-rules "Residential/multifamily property managers with 200+ doors" \
      --concurrency 10
"""
from __future__ import annotations

import argparse
import asyncio
import json
import os
import re
import sys
import time
from pathlib import Path
from typing import Literal, Optional
from urllib.parse import urlparse

import pandas as pd
from pydantic import BaseModel

# ---------------------------------------------------------------------------
# Config
# ---------------------------------------------------------------------------
SNIPPET_CAP = 2500          # max chars of fit_markdown sent to the LLM per company
THIN_PAGE_CHARS = 400       # below this, the homepage is "thin" -> snipe subpages
RICH_PAGE_CHARS = 1500      # at/above this, skip sniper even without ICP keywords
ICP_KEYWORDS = [
    "property management", "property manager", "multifamily", "multi-family",
    "residential", "commercial", "doors", "units", "hoa", "homeowners association",
    "portfolio", "leasing", "tenants", "rentals", "apartments", "community association",
]
SNIPER_PATHS = [  # priority order
    "who-we-serve", "about", "services", "properties", "solutions",
    "management", "portfolio", "company", "what-we-do", "our-story",
]
DOMAIN_COL_CANDIDATES = [
    "website", "company_website", "company website", "domain", "company_domain",
    "company domain", "url", "website_url", "website url", "organization_website_url",
    "company url", "homepage",
]
DEFAULT_RULES = (
    "Qualify companies that operate as third-party property managers (residential, "
    "multifamily, HOA/community association, or commercial) managing properties for owners. "
    "Disqualify brokerages that only sell, software vendors, lenders, contractors, "
    "and owner-operators with no management service."
)
DEFAULT_MODEL = "claude-haiku-5-5"

# Rules the worker uses when the caller sends none: property manager vs vendor.
PM_RULES = (
    "Qualify companies whose business is managing rental or association property on behalf of "
    "owners: third-party residential, multifamily, single-family-rental, commercial, or "
    "community-association (HOA/condo) management companies. "
    "Disqualify: software, proptech, and other vendors selling to property managers; "
    "an HOA or condo association itself (the association, not a management company); "
    "brokerages that only buy/sell; lenders, investors and REITs that do not offer management "
    "to outside owners; contractors, maintenance, cleaning and other service vendors."
)

LINKEDIN_RE = re.compile(
    r"https?://(?:[a-z]{2,3}\.)?linkedin\.com/company/([A-Za-z0-9_\-%.]+)", re.I)


def linkedin_from_html(html: Optional[str]) -> Optional[str]:
    """First linkedin.com/company/<slug> link on the page, normalised. None if absent."""
    if not html:
        return None
    for m in LINKEDIN_RE.finditer(html):
        slug = m.group(1).strip("/.").split("/")[0]
        if slug and slug.lower() not in {"linkedin", "company"}:
            return f"https://www.linkedin.com/company/{slug}"
    return None

KW_RE = re.compile("|".join(re.escape(k) for k in ICP_KEYWORDS), re.I)
NOISE_RE = re.compile(
    r"cookie|opens in a new window|opens an external|privacy policy|terms of (use|service)|"
    r"accept all|skip to (main )?content|all rights reserved|javascript", re.I)


class ICPVerdict(BaseModel):
    domain: str
    is_icp: bool
    confidence: Literal["high", "medium", "low"]
    property_type: str
    estimated_doors: Optional[str]
    reason: str


# ---------------------------------------------------------------------------
# Input helpers
# ---------------------------------------------------------------------------
def normalize_domain(v) -> Optional[str]:
    if v is None or (isinstance(v, float) and pd.isna(v)):
        return None
    s = str(v).strip().lower()
    if not s or s in {"nan", "none", "n/a", "-"}:
        return None
    if "://" not in s:
        s = "http://" + s
    host = urlparse(s).netloc.split("@")[-1].split(":")[0]
    host = host.removeprefix("www.")
    return host if "." in host else None


def load_input(path: Path, domain_col: Optional[str]) -> tuple[pd.DataFrame, str]:
    if path.suffix.lower() in {".xlsx", ".xls"}:
        df = pd.read_excel(path, dtype=str)
    else:
        df = pd.read_csv(path, dtype=str, keep_default_na=False)
    if domain_col:
        if domain_col not in df.columns:
            sys.exit(f"--domain-col '{domain_col}' not in columns: {list(df.columns)}")
        return df, domain_col
    lower = {c.lower().strip(): c for c in df.columns}
    for cand in DOMAIN_COL_CANDIDATES:
        if cand in lower:
            return df, lower[cand]
    for c in df.columns:  # fuzzy fallback
        if any(t in c.lower() for t in ("website", "domain")):
            return df, c
    sys.exit(f"No website/domain column found. Pass --domain-col. Columns: {list(df.columns)}")


def load_rules(arg: Optional[str]) -> str:
    if not arg:
        return DEFAULT_RULES
    p = Path(os.path.expanduser(arg))
    return p.read_text().strip() if p.is_file() else arg.strip()


# ---------------------------------------------------------------------------
# Checkpoint
# ---------------------------------------------------------------------------
class Checkpoint:
    def __init__(self, path: Path):
        self.path = path
        self.done: dict[str, dict] = {}
        if path.exists():
            for line in path.read_text().splitlines():
                try:
                    rec = json.loads(line)
                    self.done[rec["domain"]] = rec
                except Exception:
                    continue  # tolerate a torn last line from a hard kill
        self._lock = asyncio.Lock()

    async def write(self, rec: dict):
        async with self._lock:
            self.done[rec["domain"]] = rec
            with self.path.open("a") as f:
                f.write(json.dumps(rec) + "\n")


# ---------------------------------------------------------------------------
# Crawl
# ---------------------------------------------------------------------------
def build_crawler_bits(filter_kind: str, concurrency: int, mem_threshold: Optional[float] = None):
    from crawl4ai import BrowserConfig, CacheMode, CrawlerRunConfig
    from crawl4ai.async_dispatcher import MemoryAdaptiveDispatcher
    from crawl4ai.content_filter_strategy import BM25ContentFilter, PruningContentFilter
    from crawl4ai.markdown_generation_strategy import DefaultMarkdownGenerator

    if filter_kind == "bm25":
        cf = BM25ContentFilter(user_query=" ".join(ICP_KEYWORDS), bm25_threshold=1.0)
    else:
        cf = PruningContentFilter(threshold=0.48, threshold_type="dynamic", min_word_threshold=5)

    run_cfg = CrawlerRunConfig(
        cache_mode=CacheMode.BYPASS,
        excluded_tags=["nav", "footer", "header", "aside", "form", "script", "style", "noscript"],
        exclude_external_links=True,
        exclude_social_media_links=True,
        markdown_generator=DefaultMarkdownGenerator(
            content_filter=cf, options={"ignore_links": True, "ignore_images": True}
        ),
        page_timeout=25_000,
        wait_until="domcontentloaded",
        verbose=False,
        stream=False,
    )
    browser_cfg = BrowserConfig(headless=True, text_mode=True, light_mode=True, verbose=False)

    # macOS counts file cache as "used", so a fixed 80% threshold can deadlock the
    # dispatcher before the first crawl. Throttle relative to the starting baseline.
    import psutil

    base = psutil.virtual_memory().percent
    thr = mem_threshold or min(max(90.0, base + 6.0), 96.0)
    print(f"[icp] memory baseline {base:.0f}% · throttle at {thr:.0f}%", flush=True)

    def make_dispatcher():
        return MemoryAdaptiveDispatcher(
            memory_threshold_percent=thr,
            critical_threshold_percent=min(thr + 3.0, 99.0),
            recovery_threshold_percent=thr - 2.0,
            check_interval=1.0,
            max_session_permit=concurrency,
        )

    return browser_cfg, run_cfg, make_dispatcher


def fit_md(result) -> str:
    """ONLY fit_markdown — never raw_markdown."""
    if not result or not getattr(result, "success", False):
        return ""
    md = getattr(result, "markdown", None)
    text = getattr(md, "fit_markdown", None) or ""
    # drop cookie/consent/a11y boilerplate lines that survive pruning
    text = "\n".join(l for l in text.splitlines() if not NOISE_RE.search(l))
    return re.sub(r"\n{3,}", "\n\n", text).strip()


def pick_subpages(result, domain: str, k: int) -> list[str]:
    links = ((getattr(result, "links", None) or {}).get("internal")) or []
    scored: dict[str, int] = {}
    for l in links:
        href = (l.get("href") or "").split("#")[0].split("?")[0].rstrip("/")
        if not href:
            continue
        u = urlparse(href)
        if u.netloc and u.netloc.removeprefix("www.") != domain:
            continue
        path = u.path.lower()
        if not path or path == "/" or path.count("/") > 2:  # skip deep pages
            continue
        text = (l.get("text") or "").lower()
        for rank, key in enumerate(SNIPER_PATHS):
            if key in path or key.replace("-", " ") in text:
                scored[href] = min(scored.get(href, 99), rank)
                break
    return [h for h, _ in sorted(scored.items(), key=lambda x: x[1])][:k]


def needs_sniper(text: str) -> bool:
    if len(text) < THIN_PAGE_CHARS:
        return True
    return len(text) < RICH_PAGE_CHARS and not KW_RE.search(text)


async def crawl_batch(crawler, domains, run_cfg, make_dispatcher, max_subpages) -> dict[str, dict]:
    """Returns {domain: {"snippet": str, "pages": [urls], "error": str|None}}."""
    out = {d: {"snippet": "", "pages": [], "error": None, "linkedin_url": None} for d in domains}
    home_urls = {f"https://{d}": d for d in domains}
    results = await crawler.arun_many(list(home_urls), config=run_cfg, dispatcher=make_dispatcher())

    by_domain = {}
    for r in results:
        d = home_urls.get(r.url) or normalize_domain(r.url)
        if d in out:
            by_domain[d] = r

    # http://www. fallback wave for homepages that failed over https
    failed = [d for d in domains if not (by_domain.get(d) and by_domain[d].success)]
    if failed:
        fb_urls = {f"http://www.{d}": d for d in failed}
        for r in await crawler.arun_many(list(fb_urls), config=run_cfg, dispatcher=make_dispatcher()):
            d = fb_urls.get(r.url)
            if d and r.success:
                by_domain[d] = r

    # Sniper wave — one arun_many for every domain that needs subpages
    sub_map: dict[str, str] = {}
    for d in domains:
        r = by_domain.get(d)
        if not r or not r.success:
            out[d]["error"] = (getattr(r, "error_message", None) or "homepage crawl failed")[:200]
            continue
        text = fit_md(r)
        out[d]["snippet"] = text
        out[d]["pages"].append("/")
        out[d]["linkedin_url"] = linkedin_from_html(getattr(r, "html", None))
        if max_subpages and needs_sniper(text):
            for u in pick_subpages(r, d, max_subpages):
                sub_map[u] = d
    if sub_map:
        for r in await crawler.arun_many(list(sub_map), config=run_cfg, dispatcher=make_dispatcher()):
            d = sub_map.get(r.url) or sub_map.get(r.url.rstrip("/"))
            text = fit_md(r)
            if d and not out[d]["linkedin_url"]:
                out[d]["linkedin_url"] = linkedin_from_html(getattr(r, "html", None))
            if d and text:
                out[d]["snippet"] += f"\n\n## [{urlparse(r.url).path}]\n{text}"
                out[d]["pages"].append(urlparse(r.url).path)

    for d in domains:
        out[d]["snippet"] = out[d]["snippet"][:SNIPPET_CAP]
    return out


# ---------------------------------------------------------------------------
# Classify
# ---------------------------------------------------------------------------
SYSTEM_TMPL = """You classify B2B companies against an ICP using a short excerpt of their website.

ICP RULES:
{rules}

Return:
- is_icp: true only if the excerpt shows the company matches the ICP rules.
- confidence: high = explicit evidence; medium = strong implication; low = thin or ambiguous excerpt.
- property_type: e.g. "residential", "multifamily", "HOA", "commercial", "mixed", "n/a".
- estimated_doors: a number or range only if stated or clearly implied (units, doors, homes, sq ft); otherwise null. Never guess.
- reason: one sentence citing the evidence.
Judge only from the excerpt. If it is empty or uninformative, set is_icp false with low confidence."""


async def classify(client, model, system, domain, snippet, sem) -> ICPVerdict:
    import anthropic

    async with sem:
        for attempt in range(4):
            try:
                resp = await client.messages.parse(
                    model=model,
                    max_tokens=2048,
                    output_config={"effort": "low"},
                    system=system,
                    messages=[{
                        "role": "user",
                        "content": f"Domain: {domain}\n\nWebsite excerpt:\n<excerpt>\n{snippet or '(empty)'}\n</excerpt>",
                    }],
                    output_format=ICPVerdict,
                )
                if resp.stop_reason == "refusal" or resp.parsed_output is None:
                    raise RuntimeError(f"no parsed output (stop_reason={resp.stop_reason})")
                v = resp.parsed_output
                v.domain = domain
                return v
            except (anthropic.RateLimitError, anthropic.APIConnectionError, anthropic.InternalServerError):
                await asyncio.sleep(2 ** attempt * 3)
        raise RuntimeError("Anthropic retries exhausted")


# ---------------------------------------------------------------------------
# Library entry point (used by the Railway worker)
# ---------------------------------------------------------------------------
def to_result(domain: str, info: dict, verdict: Optional[ICPVerdict], error: Optional[str] = None) -> dict:
    """Shape one domain's outcome as the worker's response row."""
    base = {
        "domain": domain,
        "linkedin_url": info.get("linkedin_url"),
        "pages": info.get("pages", []),
        "snippet_chars": len(info.get("snippet", "")),
    }
    if verdict is not None:
        return {**base, "verdict": "property_manager" if verdict.is_icp else "not_property_manager",
                "confidence": verdict.confidence, "reason": verdict.reason,
                "property_type": verdict.property_type, "doors_hint": verdict.estimated_doors}
    status = "error" if error else "unreachable"
    return {**base, "verdict": status, "confidence": None,
            "reason": (error or info.get("error") or "homepage crawl failed")[:200],
            "property_type": None, "doors_hint": None}


async def classify_domains(
    domains: list[str],
    rules: Optional[str] = None,
    *,
    model: str = DEFAULT_MODEL,
    concurrency: int = 4,
    llm_concurrency: int = 8,
    max_subpages: int = 2,
    client=None,
    crawl=None,
) -> list[dict]:
    """Crawl + classify `domains` (already normalised, deduped by the caller is fine).

    `client` (AsyncAnthropic) and `crawl` (async fn(domains) -> crawl_batch output)
    are injectable for tests. Results come back in input order."""
    system = SYSTEM_TMPL.format(rules=(rules or PM_RULES).strip())
    uniq = list(dict.fromkeys(domains))
    if crawl is None:
        from crawl4ai import AsyncWebCrawler

        browser_cfg, run_cfg, make_dispatcher = build_crawler_bits("pruning", concurrency)

        async def crawl(ds):
            async with AsyncWebCrawler(config=browser_cfg) as crawler:
                return await crawl_batch(crawler, ds, run_cfg, make_dispatcher, max_subpages)
    if client is None:
        from anthropic import AsyncAnthropic

        client = AsyncAnthropic(max_retries=3)

    crawled = await crawl(uniq)
    sem = asyncio.Semaphore(llm_concurrency)

    async def one(d: str) -> dict:
        info = crawled.get(d) or {"snippet": "", "pages": [], "error": "not crawled", "linkedin_url": None}
        if info.get("error") and not info.get("snippet"):
            return to_result(d, info, None)
        try:
            v = await classify(client, model, system, d, info["snippet"], sem)
        except Exception as e:  # one bad domain never fails the batch
            return to_result(d, info, None, error=f"llm_error: {e}")
        return to_result(d, info, v)

    by_domain = dict(zip(uniq, await asyncio.gather(*(one(d) for d in uniq))))
    return [by_domain[d] for d in domains]


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
async def run(args):
    from anthropic import AsyncAnthropic
    from crawl4ai import AsyncWebCrawler

    in_path = Path(os.path.expanduser(args.input))
    out_base = Path(os.path.expanduser(args.output))
    if out_base.suffix.lower() == ".csv":
        out_base = out_base.with_suffix("")
    out_base.parent.mkdir(parents=True, exist_ok=True)

    df, dcol = load_input(in_path, args.domain_col)
    df["_icp_domain"] = df[dcol].map(normalize_domain)
    domains = list(dict.fromkeys(d for d in df["_icp_domain"] if d))
    if args.limit:
        domains = domains[: args.limit]

    ckpt = Checkpoint(Path(str(out_base) + ".checkpoint.jsonl"))
    skip_status = {"ok"} if args.retry_unreachable else {"ok", "unreachable"}
    todo = [d for d in domains if ckpt.done.get(d, {}).get("icp_status") not in skip_status]
    rules = load_rules(args.icp_rules)
    system = SYSTEM_TMPL.format(rules=rules)

    print(f"[icp] {len(df)} rows · column '{dcol}' · {len(domains)} unique domains · "
          f"{len(domains) - len(todo)} already done · {len(todo)} to process · model {args.model}",
          flush=True)

    if todo:
        if not os.environ.get("ANTHROPIC_API_KEY"):
            repo = Path(__file__).resolve().parents[2]
            for envf in (repo / ".env.local", repo / "lume" / ".env.local"):
                if envf.is_file():
                    for line in envf.read_text().splitlines():
                        k, _, v = line.partition("=")
                        if k.strip().removeprefix("export ") == "ANTHROPIC_API_KEY" and v.strip().strip("'\""):
                            os.environ["ANTHROPIC_API_KEY"] = v.strip().strip("'\"")
                if os.environ.get("ANTHROPIC_API_KEY"):
                    break
        if not os.environ.get("ANTHROPIC_API_KEY"):
            sys.exit("[icp] ANTHROPIC_API_KEY not set (env or vertis-sync/.env.local). Crawling skipped.")
        client = AsyncAnthropic(max_retries=3)
        sem = asyncio.Semaphore(args.llm_concurrency)
        browser_cfg, run_cfg, make_dispatcher = build_crawler_bits(args.filter, args.concurrency, args.mem_threshold)
        batch_size = max(args.concurrency * 3, 10)
        pending: set[asyncio.Task] = set()
        counts = {"ok": 0, "unreachable": 0, "llm_error": 0, "qualified": 0}
        t0 = time.time()
        snippet_chars = 0

        async def classify_and_save(d, info):
            nonlocal snippet_chars
            base = {"domain": d, "pages": info["pages"], "icp_snippet_chars": len(info["snippet"])}
            if info["error"] and not info["snippet"]:
                rec = {**base, "icp_status": "unreachable", "is_icp": None, "confidence": None,
                       "property_type": None, "estimated_doors": None, "reason": info["error"]}
                counts["unreachable"] += 1
                await ckpt.write(rec)
                return
            try:
                v = await classify(client, args.model, system, d, info["snippet"], sem)
            except Exception as e:  # not checkpointed -> retried on next run
                counts["llm_error"] += 1
                print(f"[icp] llm_error {d}: {e}", flush=True)
                return
            snippet_chars += len(info["snippet"])
            counts["ok"] += 1
            counts["qualified"] += int(v.is_icp)
            await ckpt.write({**base, "icp_status": "ok", **v.model_dump()})

        async with AsyncWebCrawler(config=browser_cfg) as crawler:
            for i in range(0, len(todo), batch_size):
                batch = todo[i : i + batch_size]
                crawled = await crawl_batch(crawler, batch, run_cfg, make_dispatcher, args.max_subpages)
                # classification overlaps with the next crawl batch
                for d, info in crawled.items():
                    t = asyncio.create_task(classify_and_save(d, info))
                    pending.add(t)
                    t.add_done_callback(pending.discard)
                done_n = min(i + batch_size, len(todo))
                rate = done_n / max(time.time() - t0, 1e-6)
                print(f"[icp] crawled {done_n}/{len(todo)} ({rate:.1f}/s) · "
                      f"classified ok={counts['ok']} icp={counts['qualified']} "
                      f"unreachable={counts['unreachable']} llm_err={counts['llm_error']}", flush=True)
            if pending:
                await asyncio.gather(*pending)

        avg = snippet_chars / max(counts["ok"], 1)
        print(f"[icp] run done in {time.time() - t0:.0f}s · avg snippet {avg:.0f} chars (~{avg/4:.0f} tok)",
              flush=True)

    # ---- write outputs from the full checkpoint (covers resumed runs) ----
    cols = ["is_icp", "confidence", "property_type", "estimated_doors", "reason", "icp_status", "icp_snippet_chars"]
    res = pd.DataFrame(
        [{"_icp_domain": d, **{c: ckpt.done[d].get(c) for c in cols}} for d in domains if d in ckpt.done]
    )
    if res.empty:
        res = pd.DataFrame(columns=["_icp_domain", *cols])
    merged = df.drop(columns=[c for c in cols if c in df.columns]).merge(res, on="_icp_domain", how="left")
    if args.limit:
        merged = merged[merged["_icp_domain"].isin(domains)]

    ok = merged["icp_status"] == "ok"
    qualified = merged[ok & (merged["is_icp"] == True)]  # noqa: E712
    disq = merged[ok & (merged["is_icp"] == False)]  # noqa: E712
    unreachable = merged[~ok]  # unreachable, llm_error (missing), or blank domain

    paths = {}
    for name, part in (("qualified", qualified), ("disqualified", disq), ("unreachable", unreachable)):
        p = Path(f"{out_base}_{name}.csv")
        part.drop(columns=["_icp_domain"]).to_csv(p, index=False)
        paths[name] = (p, len(part))
    for name, (p, n) in paths.items():
        print(f"[icp] {name:13s} {n:6d} rows -> {p}", flush=True)
    print(json.dumps({"qualified": paths["qualified"][1], "disqualified": paths["disqualified"][1],
                      "unreachable": paths["unreachable"][1], "checkpoint": str(ckpt.path)}), flush=True)


def main():
    ap = argparse.ArgumentParser(description="Crawl4AI + Claude batch ICP filter")
    ap.add_argument("--input", required=True, help="CSV/XLSX with a website/domain column")
    ap.add_argument("--output", required=True, help="output base path (writes <base>_qualified.csv etc.)")
    ap.add_argument("--icp-rules", help="plain-English ICP rules, or a path to a rules .txt/.md file")
    ap.add_argument("--domain-col", help="column holding website/domain (auto-detected if omitted)")
    ap.add_argument("--concurrency", type=int, default=10, help="max concurrent browser sessions")
    ap.add_argument("--llm-concurrency", type=int, default=8, help="max concurrent Claude calls")
    ap.add_argument("--max-subpages", type=int, default=2, choices=[0, 1, 2])
    ap.add_argument("--filter", choices=["pruning", "bm25"], default="pruning")
    ap.add_argument("--model", default=DEFAULT_MODEL)
    ap.add_argument("--mem-threshold", type=float, help="RAM %% at which crawling throttles (default: baseline+6, 90-96)")
    ap.add_argument("--limit", type=int, help="only process the first N unique domains")
    ap.add_argument("--retry-unreachable", action="store_true", help="re-crawl domains previously unreachable")
    args = ap.parse_args()
    asyncio.run(run(args))


if __name__ == "__main__":
    main()
