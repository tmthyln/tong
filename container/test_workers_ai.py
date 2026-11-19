import asyncio
import json
import threading
import time

import httpx
import numpy as np
from toponymy.llm_wrappers import AsyncLLMWrapper

from workers_ai import WorkersAIClient, WorkersAINamer, WorkersAIEmbedder


def make_client(handler):
    return WorkersAIClient(base_url="http://workers-ai.tong", transport=httpx.MockTransport(handler))


def test_chat_posts_messages_and_returns_content():
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["url"] = str(request.url)
        seen["body"] = json.loads(request.content)
        return httpx.Response(200, json={"content": '{"topic_name": "唐诗"}'})

    client = make_client(handler)
    out = client.chat([{"role": "user", "content": "hi"}], temperature=0.2, max_tokens=64)
    assert out == '{"topic_name": "唐诗"}'
    assert seen["url"] == "http://workers-ai.tong/chat"
    assert seen["body"] == {
        "messages": [{"role": "user", "content": "hi"}],
        "temperature": 0.2,
        "max_tokens": 64,
    }


def test_chat_raises_on_http_error():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(500, json={"error": "boom"})

    client = make_client(handler)
    try:
        client.chat([{"role": "user", "content": "hi"}])
        assert False, "expected HTTPStatusError"
    except httpx.HTTPStatusError:
        pass


def test_namer_implements_toponymy_async_interface():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # Echo back the last message content so we can assert prompt handling.
        return httpx.Response(200, json={"content": body["messages"][-1]["content"]})

    namer = WorkersAINamer(make_client(handler), llm_specific_instructions="用中文命名。")
    assert isinstance(namer, AsyncLLMWrapper)
    assert namer.supports_system_prompts is True

    out = asyncio.run(namer._call_single_llm("PROMPT", temperature=0.4, max_tokens=128))
    assert out == "PROMPT\n\n用中文命名。"

    out = asyncio.run(namer._call_single_llm_with_system("SYS", "USER", temperature=0.4, max_tokens=128))
    assert out == "USER\n\n用中文命名。"


def test_namer_names_a_layer_concurrently_within_its_limit():
    lock = threading.Lock()
    state = {"in_flight": 0, "peak": 0, "seen": []}

    async def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        with lock:
            state["in_flight"] += 1
            state["peak"] = max(state["peak"], state["in_flight"])
            state["seen"].append(body["max_tokens"])
        await asyncio.sleep(0.05)
        with lock:
            state["in_flight"] -= 1
        n = body["messages"][-1]["content"].split()[0]
        return httpx.Response(200, json={"content": json.dumps({"topic_name": f"主题{n}", "topic_specificity": 0.9}, ensure_ascii=False)})

    namer = WorkersAINamer(make_client(handler), max_concurrency=4)
    prompts = [f"{i} name this" for i in range(12)]
    t = time.time()
    # Two layers = two event loops (toponymy uses asyncio.run per layer).
    for _ in range(2):
        names = asyncio.run(namer.generate_topic_names(prompts))
        assert names == [f"主题{i}" for i in range(12)]
    elapsed = time.time() - t
    assert state["peak"] == 4
    assert elapsed < 12 * 0.05  # sequential would take >= 0.6s per layer
    assert set(state["seen"]) == {128}  # toponymy's topic-name budget, as evaluated


def test_namer_failed_call_yields_blank_name_not_crash():
    def handler(request: httpx.Request) -> httpx.Response:
        if "bad" in json.loads(request.content)["messages"][-1]["content"]:
            return httpx.Response(500, json={"error": "boom"})
        return httpx.Response(200, json={"content": '{"topic_name": "好", "topic_specificity": 0.9}'})

    namer = WorkersAINamer(make_client(handler))
    names = asyncio.run(namer.generate_topic_names(["ok", "bad", "ok"]))
    assert names == ["好", "", "好"]


def test_embedder_sends_one_request_and_returns_array():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(len(body["texts"]))
        return httpx.Response(200, json={"vectors": [[0.1, 0.2]] * len(body["texts"])})

    embedder = WorkersAIEmbedder(make_client(handler))
    result = embedder.encode([f"t{i}" for i in range(200)], show_progress_bar=False)
    assert isinstance(result, np.ndarray)
    assert result.shape == (200, 2)
    # Batching by model limit is the bridge's job; the client sends one request.
    assert calls == [200]


def test_embedder_empty_input():
    embedder = WorkersAIEmbedder(make_client(lambda r: httpx.Response(500)))
    result = embedder.encode([])
    assert isinstance(result, np.ndarray)
    assert result.shape[0] == 0


def test_rate_limited_calls_wait_out_the_window(monkeypatch):
    import workers_ai

    waits = []

    async def fake_async_sleep(s):
        waits.append(("async", s))

    monkeypatch.setattr(workers_ai.asyncio, "sleep", fake_async_sleep)
    monkeypatch.setattr(workers_ai.time, "sleep", lambda s: waits.append(("sync", s)))
    calls = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        calls["n"] += 1
        if calls["n"] % 3:  # two 429s, then success
            return httpx.Response(429, json={"error": "rate limiting (3021)"})
        return httpx.Response(200, json={"content": "ok"})

    client = make_client(handler)
    assert asyncio.run(client.achat([{"role": "user", "content": "hi"}])) == "ok"
    assert client.chat([{"role": "user", "content": "hi"}]) == "ok"
    assert [k for k, _ in waits] == ["async", "async", "sync", "sync"]
    # Waits span the per-minute window, not toponymy's 1-10s retry spacing.
    assert 6 <= waits[0][1] <= 10 and 12 <= waits[1][1] <= 18


def test_rate_limit_gives_up_eventually(monkeypatch):
    import workers_ai

    monkeypatch.setattr(workers_ai.time, "sleep", lambda s: None)
    client = make_client(lambda r: httpx.Response(429, json={"error": "rate limiting"}))
    try:
        client.chat([{"role": "user", "content": "hi"}])
        assert False, "expected HTTPStatusError"
    except httpx.HTTPStatusError as exc:
        assert exc.response.status_code == 429
    assert sum(workers_ai.RATE_LIMIT_WAITS) >= 60  # outlasts one window
