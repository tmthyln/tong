import httpx
import json
import numpy as np

from workers_ai import WorkersAIClient, WorkersAINamer, WorkersAIEmbedder


def make_client(handler):
    transport = httpx.MockTransport(handler)
    return WorkersAIClient(
        base_url="http://workers-ai.tong",
        client=httpx.Client(transport=transport),
    )


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


def test_namer_implements_toponymy_interface():
    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        # Echo back the last message content so we can assert prompt handling.
        return httpx.Response(200, json={"content": body["messages"][-1]["content"]})

    namer = WorkersAINamer(make_client(handler), llm_specific_instructions="用中文命名。")
    assert namer.supports_system_prompts is True

    out = namer._call_llm("PROMPT", temperature=0.4, max_tokens=128)
    assert out == "PROMPT\n\n用中文命名。"

    out = namer._call_llm_with_system_prompt("SYS", "USER", temperature=0.4, max_tokens=128)
    assert out == "USER\n\n用中文命名。"


def test_embedder_batches_and_returns_array():
    calls = []

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        calls.append(len(body["texts"]))
        return httpx.Response(200, json={"vectors": [[0.1, 0.2]] * len(body["texts"])})

    embedder = WorkersAIEmbedder(make_client(handler), batch_size=90)
    result = embedder.encode([f"t{i}" for i in range(200)], show_progress_bar=False)
    assert isinstance(result, np.ndarray)
    assert result.shape == (200, 2)
    assert calls == [90, 90, 20]


def test_embedder_empty_input():
    embedder = WorkersAIEmbedder(make_client(lambda r: httpx.Response(500)))
    result = embedder.encode([])
    assert isinstance(result, np.ndarray)
    assert result.shape[0] == 0
