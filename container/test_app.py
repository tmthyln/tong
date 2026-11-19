import json

import numpy as np
from fastapi.testclient import TestClient

import app as app_module
from app import VECTOR_FRAME_CONTENT_TYPE, app, parse_vector_frame, topics_key


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


# Golden frame from server/lib/chunk-vectors.test.ts (encodeVectorFrame).
GOLDEN_FRAME = bytes.fromhex(
    "23000000"
    + '{"texts":["好"],"count":2,"dim":2}'.encode().hex()
    + "00"
    + "0000803f" + "00000040" + "00004040" + "00009040"
)


def encode_frame(vectors, **meta):
    """Python twin of encodeVectorFrame, for tests."""
    arr = np.asarray(vectors, dtype="<f4")
    header = json.dumps({**meta, "count": len(arr), "dim": arr.shape[1] if arr.ndim == 2 else 0}).encode()
    pad = -(4 + len(header)) % 4
    return len(header).to_bytes(4, "little") + header + b"\0" * pad + arr.tobytes()


def test_parse_vector_frame_matches_worker_golden():
    header, vectors = parse_vector_frame(GOLDEN_FRAME)
    assert header == {"texts": ["好"], "count": 2, "dim": 2}
    assert vectors.dtype == np.float32
    assert vectors.tolist() == [[1.0, 2.0], [3.0, 4.5]]
    assert vectors.flags.writeable


def test_parse_vector_frame_rejects_truncated():
    for bad in (GOLDEN_FRAME[:-1], GOLDEN_FRAME[:3]):
        try:
            parse_vector_frame(bad)
            assert False, "expected ValueError"
        except ValueError:
            pass


def test_reduce_binary_frame_equals_json(monkeypatch):
    jobs = []

    def fake_job(key, texts, vectors, coords):
        jobs.append((key, np.asarray(vectors).copy()))
        app_module.TOPIC_JOBS[key] = {"status": "ready", "layers": []}

    monkeypatch.setattr(app_module, "run_topic_job", fake_job)
    client = TestClient(app)
    vectors = np.asarray(make_vectors(25), dtype=np.float32)
    texts = [f"文本{i}" for i in range(20)]
    res_bin = client.post(
        "/reduce",
        content=encode_frame(vectors, texts=texts),
        headers={"Content-Type": VECTOR_FRAME_CONTENT_TYPE},
    ).json()
    app_module.TOPIC_JOBS.clear()
    res_json = client.post("/reduce", json={"vectors": vectors.tolist(), "texts": texts}).json()
    # Seeded UMAP: same float32 input, same layout either way.
    assert res_bin["coords"] == res_json["coords"]
    assert res_bin["topicsKey"] == res_json["topicsKey"] == topics_key(texts)
    assert np.array_equal(jobs[0][1], jobs[1][1]) and jobs[0][1].shape == (20, 8)


def test_reduce_bad_frame_is_422():
    client = TestClient(app)
    res = client.post("/reduce", content=b"\x05\x00\x00\x00{}", headers={"Content-Type": VECTOR_FRAME_CONTENT_TYPE})
    assert res.status_code == 422
    res = client.post("/reduce", content=encode_frame(np.zeros((1, 4))), headers={"Content-Type": VECTOR_FRAME_CONTENT_TYPE})
    assert res.status_code == 422
