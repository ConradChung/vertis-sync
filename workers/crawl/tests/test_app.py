"""HTTP contract tests for app.py with the engine stubbed out."""
import pytest
from fastapi.testclient import TestClient

import app as worker


@pytest.fixture
def client(monkeypatch):
    monkeypatch.setenv("WORKER_SECRET", "s3cret")
    calls = []
    c = TestClient(worker.app)

    async def fake_classify_domains(domains, rules=None, **kw):
        calls.append((list(domains), rules))
        c.kwargs = kw
        return [{"domain": d, "verdict": "property_manager", "confidence": "high", "reason": "r",
                 "linkedin_url": None, "doors_hint": None, "property_type": "multifamily",
                 "pages": ["/"], "snippet_chars": 10} for d in domains]

    monkeypatch.setattr(worker.engine, "classify_domains", fake_classify_domains)
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


def test_deadline_defaults_to_200s_from_arrival(client):
    import time
    t0 = time.monotonic()
    r = client.post("/classify", json={"domains": ["a.com"]}, headers={"X-Worker-Secret": "s3cret"})
    assert r.status_code == 200 and r.json()["timed_out"] == 0
    left = client.kwargs["deadline_at"] - t0
    assert 190 < left <= 200 - worker.DEADLINE_MARGIN_S + 1


def test_deadline_is_bounded(client):
    h = {"X-Worker-Secret": "s3cret"}
    assert client.post("/classify", json={"domains": ["a.com"], "deadline_s": 281}, headers=h).status_code == 422
    assert client.post("/classify", json={"domains": ["a.com"], "deadline_s": 1}, headers=h).status_code == 422
    assert client.post("/classify", json={"domains": ["a.com"], "deadline_s": 60}, headers=h).status_code == 200


def test_timed_out_rows_are_counted(client, monkeypatch):
    async def half(domains, rules=None, **kw):
        return [worker.engine.timed_out_result(d) if i % 2 else
                {"domain": d, "verdict": "property_manager", "confidence": "high", "reason": "r",
                 "linkedin_url": None, "doors_hint": None, "property_type": None, "pages": [], "snippet_chars": 1}
                for i, d in enumerate(domains)]
    monkeypatch.setattr(worker.engine, "classify_domains", half)
    r = client.post("/classify", json={"domains": ["a.com", "b.com", "c.com"]}, headers={"X-Worker-Secret": "s3cret"})
    body = r.json()
    assert body["timed_out"] == 1 and body["results"][1]["verdict"] == "timed_out"


def test_lock_wait_past_deadline_times_out_everything(client, monkeypatch):
    import asyncio

    class Held:
        async def acquire(self):
            await asyncio.sleep(10)

        def release(self):
            raise AssertionError("never acquired")

    monkeypatch.setattr(worker, "_batch_lock", Held())
    monkeypatch.setattr(worker, "DEADLINE_MARGIN_S", 4.8)
    r = client.post("/classify", json={"domains": ["a.com", "b.com"], "deadline_s": 5},
                    headers={"X-Worker-Secret": "s3cret"})
    assert r.json()["timed_out"] == 2
    assert client.calls == []
