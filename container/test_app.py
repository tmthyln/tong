import numpy as np
from fastapi.testclient import TestClient

import app as app_module
from app import app, topics_key


def make_vectors(n=25, dim=8):
    rng = np.random.default_rng(0)
    return rng.normal(size=(n, dim)).tolist()


def setup_function():
    app_module.TOPIC_JOBS.clear()


def test_reduce_without_texts_has_no_topics_key():
    client = TestClient(app)
    res = client.post("/reduce", json={"vectors": make_vectors()})
    assert res.status_code == 200
    body = res.json()
    assert len(body["coords"]) == 25
    assert body.get("topicsKey") is None


def test_reduce_with_texts_spawns_job_and_returns_key(monkeypatch):
    calls = []

    def fake_job(key, texts, vectors, coords):
        calls.append((key, len(texts), len(vectors), len(coords)))
        app_module.TOPIC_JOBS[key] = {"status": "ready", "layers": []}

    monkeypatch.setattr(app_module, "run_topic_job", fake_job)
    client = TestClient(app)
    texts = [f"文本{i}" for i in range(20)]
    res = client.post("/reduce", json={"vectors": make_vectors(25), "texts": texts})
    body = res.json()
    assert body["topicsKey"] == topics_key(texts)
    # Job got the chunk slice only (first len(texts) rows).
    assert calls == [(topics_key(texts), 20, 20, 20)]

    status = client.get(f"/topics/{body['topicsKey']}").json()
    assert status == {"status": "ready", "layers": []}


def test_reduce_same_texts_does_not_respawn(monkeypatch):
    calls = []

    def fake_job(key, texts, vectors, coords):
        calls.append(key)
        app_module.TOPIC_JOBS[key] = {"status": "ready", "layers": []}

    monkeypatch.setattr(app_module, "run_topic_job", fake_job)
    client = TestClient(app)
    texts = [f"文本{i}" for i in range(20)]
    payload = {"vectors": make_vectors(25), "texts": texts}
    client.post("/reduce", json=payload)
    client.post("/reduce", json=payload)
    assert len(calls) == 1


def test_reduce_ignores_mismatched_texts():
    client = TestClient(app)
    res = client.post("/reduce", json={"vectors": make_vectors(5), "texts": ["a"] * 10})
    assert res.json().get("topicsKey") is None


def test_topics_unknown_key():
    client = TestClient(app)
    res = client.get("/topics/deadbeefdeadbeef")
    assert res.json() == {"status": "error", "error": "unknown key"}
