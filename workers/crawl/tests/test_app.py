"""HTTP contract tests for app.py with the engine stubbed out."""
import pytest
from fastapi.testclient import TestClient

import app as worker


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WORKER_SECRET", "s3cret")
    calls = []

    async def fake_classify_domains(domains, rules=None, **kw):
        calls.append((list(domains), rules))
        return [{"domain": d, "verdict": "property_manager", "confidence": "high", "reason": "r",
                 "linkedin_url": None, "doors_hint": None, "property_type": "multifamily",
                 "pages": ["/"], "snippet_chars": 10} for d in domains]

    monkeypatch.setattr(worker.engine, "classify_domains", fake_classify_domains)
    c = TestClient(worker.app)
    c.calls = calls
    return c


def test_health_is_open(client):
    r = client.get("/health")
    assert r.status_code == 200 and r.json() == {"ok": True}


def test_classify_requires_secret(client):
    assert client.post("/classify", json={"domains": ["a.com"]}).status_code == 401
    assert client.post("/classify", json={"domains": ["a.com"]},
                       headers={"X-Worker-Secret": "wrong"}).status_code == 401


def test_classify_without_configured_secret_is_503(client, monkeypatch):
    monkeypatch.delenv("WORKER_SECRET")
    r = client.post("/classify", json={"domains": ["a.com"]}, headers={"X-Worker-Secret": "x"})
    assert r.status_code == 503


def test_classify_happy_path_keeps_order_and_flags_bad_domains(client):
    r = client.post("/classify", json={"domains": ["https://www.A.com/x", "nope", "b.com"]},
                    headers={"X-Worker-Secret": "s3cret"})
    assert r.status_code == 200
    body = r.json()
    assert body["ok"] is True
    assert [x["domain"] for x in body["results"]] == ["a.com", "nope", "b.com"]
    assert body["results"][1]["verdict"] == "error" and body["results"][1]["reason"] == "invalid_domain"
    assert client.calls == [(["a.com", "b.com"], None)]


def test_classify_caps_batch_at_50(client):
    r = client.post("/classify", json={"domains": [f"d{i}.com" for i in range(51)]},
                    headers={"X-Worker-Secret": "s3cret"})
    assert r.status_code == 422


def test_classify_rejects_empty(client):
    r = client.post("/classify", json={"domains": []}, headers={"X-Worker-Secret": "s3cret"})
    assert r.status_code == 422
