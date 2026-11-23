"""Live 10-domain check (real crawl + real Claude Haiku, ~$0.002).

Skipped unless RUN_LIVE=1 and ANTHROPIC_API_KEY are set. Pass WORKER_URL (+ WORKER_SECRET)
to hit a deployed worker instead of running the engine in-process.
"""
import asyncio
import json
import os
from pathlib import Path

import pytest

FIXTURE = json.loads((Path(__file__).parent / "fixture_domains.json").read_text())
EXPECTED = {d: "property_manager" for d in FIXTURE["property_manager"]} | \
           {d: "not_property_manager" for d in FIXTURE["not_property_manager"]}

pytestmark = pytest.mark.skipif(os.environ.get("RUN_LIVE") != "1", reason="set RUN_LIVE=1 for the live check")


def _results():
    url = os.environ.get("WORKER_URL")
    if url:
        import httpx
        r = httpx.post(url.rstrip("/") + "/classify", json={"domains": list(EXPECTED)},
                       headers={"X-Worker-Secret": os.environ["WORKER_SECRET"]}, timeout=300)
        r.raise_for_status()
        return r.json()["results"]
    import classify as engine
    return asyncio.run(engine.classify_domains(list(EXPECTED)))


def test_ten_known_domains_all_correct():
    rows = _results()
    for r in rows:
        print(f"{r['domain']:22s} {r['verdict']:22s} {str(r['confidence']):7s} "
              f"li={r['linkedin_url']} doors={r['doors_hint']} | {r['reason'][:90]}")
    wrong = {r["domain"]: r["verdict"] for r in rows if r["verdict"] != EXPECTED[r["domain"]]}
    assert not wrong, f"wrong verdicts: {wrong}"
