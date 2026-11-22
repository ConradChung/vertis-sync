"""Unit tests: no browser, no network. The crawl and the Anthropic client are fakes."""
import asyncio
import types

import pytest

import classify as engine


def fake_client(verdicts: dict[str, bool], fail: set[str] = frozenset()):
    async def parse(**kw):
        content = kw["messages"][0]["content"]
        domain = content.split("\n", 1)[0].removeprefix("Domain: ").strip()
        if domain in fail:
            raise ValueError("boom")
        v = engine.ICPVerdict(domain=domain, is_icp=verdicts[domain], confidence="high",
                              property_type="multifamily" if verdicts[domain] else "n/a",
                              estimated_doors="5,000 units" if verdicts[domain] else None,
                              reason="excerpt says so")
        return types.SimpleNamespace(stop_reason="end_turn", parsed_output=v)
    return types.SimpleNamespace(messages=types.SimpleNamespace(parse=parse))


def fake_crawl(snippets: dict[str, str | None], linkedin: dict[str, str] = {}):
    async def crawl(ds):
        out = {}
        for d in ds:
            s = snippets.get(d)
            out[d] = {"snippet": s or "", "pages": ["/"] if s else [],
                      "error": None if s else "net::ERR_NAME_NOT_RESOLVED",
                      "linkedin_url": linkedin.get(d)}
        return out
    return crawl


def run(coro):
    return asyncio.run(coro)


def test_linkedin_from_html_picks_company_page():
    html = ('<a href="https://www.linkedin.com/in/someone">x</a>'
            '<a href="https://linkedin.com/company/acme-pm/about/">LinkedIn</a>')
    assert engine.linkedin_from_html(html) == "https://www.linkedin.com/company/acme-pm"
    assert engine.linkedin_from_html('<a href="https://uk.linkedin.com/company/foo">') == \
        "https://www.linkedin.com/company/foo"
    assert engine.linkedin_from_html("<p>no links</p>") is None
    assert engine.linkedin_from_html(None) is None


def test_normalize_domain():
    assert engine.normalize_domain("https://www.Greystar.com/about") == "greystar.com"
    assert engine.normalize_domain("appfolio.com") == "appfolio.com"
    assert engine.normalize_domain("not a domain") is None
    assert engine.normalize_domain("") is None


def test_classify_domains_shapes_results_in_input_order():
    rows = run(engine.classify_domains(
        ["vendor.com", "pm.com", "dead.com"],
        client=fake_client({"pm.com": True, "vendor.com": False}),
        crawl=fake_crawl({"pm.com": "We manage 5,000 apartments", "vendor.com": "Software for PMs"},
                         linkedin={"pm.com": "https://www.linkedin.com/company/pm"}),
    ))
    assert [r["domain"] for r in rows] == ["vendor.com", "pm.com", "dead.com"]
    vendor, pm, dead = rows
    assert pm["verdict"] == "property_manager"
    assert pm["doors_hint"] == "5,000 units"
    assert pm["linkedin_url"] == "https://www.linkedin.com/company/pm"
    assert vendor["verdict"] == "not_property_manager"
    assert dead["verdict"] == "unreachable" and dead["confidence"] is None
    for r in rows:
        assert {"domain", "verdict", "confidence", "reason", "linkedin_url", "doors_hint"} <= r.keys()


def test_llm_failure_on_one_domain_does_not_fail_batch():
    rows = run(engine.classify_domains(
        ["a.com", "b.com"],
        client=fake_client({"a.com": True, "b.com": True}, fail={"b.com"}),
        crawl=fake_crawl({"a.com": "manage homes", "b.com": "manage homes"}),
    ))
    assert rows[0]["verdict"] == "property_manager"
    assert rows[1]["verdict"] == "error" and rows[1]["reason"].startswith("llm_error")


def test_default_rules_are_pm_vs_vendor():
    seen = {}

    async def parse(**kw):
        seen["system"] = kw["system"]
        return types.SimpleNamespace(stop_reason="end_turn", parsed_output=engine.ICPVerdict(
            domain="x.com", is_icp=False, confidence="low", property_type="n/a",
            estimated_doors=None, reason="r"))

    client = types.SimpleNamespace(messages=types.SimpleNamespace(parse=parse))
    run(engine.classify_domains(["x.com"], client=client, crawl=fake_crawl({"x.com": "text"})))
    assert "vendors selling to property managers" in seen["system"]
