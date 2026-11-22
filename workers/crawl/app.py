"""Crawl worker: "is this website a property manager or a vendor?"

POST /classify  {"domains": [...≤50], "rules"?: str}  header X-Worker-Secret
  → {"ok": true, "results": [{domain, verdict, confidence, reason, linkedin_url, doors_hint, ...}]}
GET  /health    → {"ok": true}

verdict ∈ property_manager | not_property_manager | unreachable | error.
Runs on Railway (see README.md). Supabase edge functions can't run a browser,
so this is the one piece of the pipeline with its own server.
"""
from __future__ import annotations

import asyncio
import hmac
import os
from typing import Optional

from fastapi import FastAPI, Header, HTTPException
from pydantic import BaseModel, Field, field_validator

import classify as engine

MAX_DOMAINS = 50
RULES_MAX_CHARS = 4000

app = FastAPI(title="crawl-worker", docs_url=None, redoc_url=None, openapi_url=None)

# One batch at a time per instance: Chromium is memory-heavy (each batch already
# runs up to CRAWL_CONCURRENCY pages in parallel). Extra requests wait their turn.
_batch_lock = asyncio.Semaphore(1)


class ClassifyRequest(BaseModel):
    domains: list[str] = Field(min_length=1)
    rules: Optional[str] = Field(default=None, max_length=RULES_MAX_CHARS)

    @field_validator("domains")
    @classmethod
    def _cap(cls, v: list[str]) -> list[str]:
        if len(v) > MAX_DOMAINS:
            raise ValueError(f"at most {MAX_DOMAINS} domains per call")
        return v


def _check_secret(given: Optional[str]) -> None:
    expected = os.environ.get("WORKER_SECRET", "")
    if not expected:
        raise HTTPException(503, "worker_secret_not_configured")
    if not given or not hmac.compare_digest(given.encode(), expected.encode()):
        raise HTTPException(401, "unauthorized")


@app.get("/health")
async def health():
    return {"ok": True}


@app.post("/classify")
async def classify_route(body: ClassifyRequest, x_worker_secret: Optional[str] = Header(default=None)):
    _check_secret(x_worker_secret)

    normalized = [(raw, engine.normalize_domain(raw)) for raw in body.domains]
    valid = [d for _, d in normalized if d]
    results_by_domain: dict[str, dict] = {}
    if valid:
        async with _batch_lock:
            rows = await engine.classify_domains(
                valid,
                body.rules,
                model=os.environ.get("CLASSIFY_MODEL", engine.DEFAULT_MODEL),
                concurrency=int(os.environ.get("CRAWL_CONCURRENCY", "4")),
            )
        results_by_domain = {r["domain"]: r for r in rows}

    results = []
    for raw, d in normalized:
        if not d:
            results.append({"domain": raw, "verdict": "error", "confidence": None,
                            "reason": "invalid_domain", "linkedin_url": None, "doors_hint": None,
                            "property_type": None, "pages": [], "snippet_chars": 0})
        else:
            results.append(results_by_domain[d])
    return {"ok": True, "results": results}
