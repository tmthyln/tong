# Hierarchical Topic Labels Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add hierarchical, zoom-dependent, bilingual (zh default / en on hover) topic labels to the document-map scatterplot, computed by toponymy inside the existing UMAP container, with LLM calls routed to Workers AI via container outbound interception (issue #4).

**Architecture:** The Worker's visualization request now also carries chunk texts. The container's `/reduce` endpoint returns UMAP coords immediately and spawns an in-process background job that runs toponymy; results are cached in container memory keyed by an input hash. Python code reaches Workers AI by HTTP-calling the virtual hostname `workers-ai.tong`, which `UmapContainer`'s `static outboundByHost` handler serves inside the Workers runtime using `env.AI`. The frontend polls a new `/topics` endpoint and renders labels layered by zoom level.

**Tech Stack:** Hono + Cloudflare Workers (TS), `@cloudflare/containers` 0.2.1 outbound interception, FastAPI + toponymy 0.5.2 + jieba (Python container), Vue 3 + d3 (frontend), vitest + pytest.

**Spec:** `docs/superpowers/specs/2026-07-08-topic-labels-design.md`

## Global Constraints

- Topic-naming LLM: `@cf/moonshotai/kimi-k2.6`. Keyphrase embedding: `@cf/google/embeddinggemma-300m` (same as chunks).
- Virtual outbound hostname: `workers-ai.tong` (paths `/chat`, `/embed`).
- Python deps pinned: `toponymy==0.5.2`, `jieba==0.42.1`, `httpx==0.28.1`; bump `scikit-learn` to `1.6.1` (toponymy needs >=1.6).
- Topics API layer order: **coarse → fine** (toponymy produces fine → coarse internally; reverse it).
- Label shape everywhere: `{ label_zh: string, label_en: string, x: number, y: number, size: number }` — x/y in **raw UMAP coordinate space** (frontend applies its own scales).
- Topics job statuses: `pending` | `ready` | `error`. Unknown key → `{"status": "error", "error": "unknown key"}`.
- No function typed to return `unknown` (user rule). Verify with vitest/pytest, not curl against a live dev server (user rule).
- Toponymy interfaces verified against tag `0.5.2`: custom LLM wrapper subclasses `toponymy.llm_wrappers.LLMWrapper` and implements `_call_llm(prompt, temperature, max_tokens) -> str`, `_call_llm_with_system_prompt(system_prompt, user_prompt, temperature, max_tokens) -> str`, plus attr `supports_system_prompts: bool` and `callback = None`. Embedder needs `.encode(texts, show_progress_bar=None, **kwargs) -> np.ndarray`. `KeyphraseBuilder(tokenizer=...)` wants an object with `.encode(text) -> list` and `.decode(tokens) -> str`.

---

### Task 1: Workers AI bridge (Worker side)

The container will call `http://workers-ai.tong/{chat,embed}`. This task builds the handler that serves those calls from inside the Workers runtime and wires it to `UmapContainer` via outbound interception.

**Files:**
- Create: `server/lib/workers-ai-bridge.ts`
- Test: `server/lib/workers-ai-bridge.test.ts`
- Modify: `server/containers/umap.ts`
- Modify: `server/index.ts` (add `ContainerProxy` re-export after line 19)

**Interfaces:**
- Consumes: `env.AI.run` (cast pattern copied from `server/lib/relationship-extraction.ts:47`).
- Produces: `handleWorkersAiRequest(request: Request, env: Env): Promise<Response>`; POST `/chat` body `{ messages: {role, content}[], temperature?, max_tokens? }` → `{ content: string }`; POST `/embed` body `{ texts: string[] }` → `{ vectors: number[][] }`. Task 2's Python client depends on these exact shapes.

- [ ] **Step 1: Write the failing test**

```ts
// server/lib/workers-ai-bridge.test.ts
import { describe, it, expect, vi } from 'vitest'
import {
  handleWorkersAiRequest,
  TOPIC_NAMING_MODEL,
  KEYPHRASE_EMBEDDING_MODEL,
} from './workers-ai-bridge'

function makeEnv(run: ReturnType<typeof vi.fn>): Env {
  return { AI: { run } } as unknown as Env
}

function post(path: string, body: unknown): Request {
  return new Request(`http://workers-ai.tong${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

describe('handleWorkersAiRequest /chat', () => {
  it('forwards messages to kimi and returns choices content', async () => {
    const run = vi.fn().mockResolvedValue({
      choices: [{ message: { content: '{"topic_name": "唐诗"}' } }],
    })
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }], temperature: 0.2, max_tokens: 64 }),
      makeEnv(run)
    )
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ content: '{"topic_name": "唐诗"}' })
    expect(run).toHaveBeenCalledWith(TOPIC_NAMING_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      max_tokens: 64,
    })
  })

  it('falls back to .response and applies default params', async () => {
    const run = vi.fn().mockResolvedValue({ response: 'plain' })
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv(run)
    )
    expect(await res.json()).toEqual({ content: 'plain' })
    expect(run).toHaveBeenCalledWith(TOPIC_NAMING_MODEL, {
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.4,
      max_tokens: 256,
    })
  })

  it('rejects missing messages', async () => {
    const res = await handleWorkersAiRequest(post('/chat', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(400)
  })
})

describe('handleWorkersAiRequest /embed', () => {
  it('batches texts by 90 and concatenates vectors', async () => {
    const run = vi.fn().mockImplementation((_model: string, args: { text: string[] }) =>
      Promise.resolve({ data: args.text.map(() => [0.1, 0.2]) })
    )
    const texts = Array.from({ length: 200 }, (_, i) => `t${i}`)
    const res = await handleWorkersAiRequest(post('/embed', { texts }), makeEnv(run))
    const body = (await res.json()) as { vectors: number[][] }
    expect(body.vectors).toHaveLength(200)
    expect(run).toHaveBeenCalledTimes(3)
    expect(run).toHaveBeenCalledWith(KEYPHRASE_EMBEDDING_MODEL, { text: texts.slice(0, 90) })
  })

  it('rejects missing texts', async () => {
    const res = await handleWorkersAiRequest(post('/embed', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(400)
  })
})

describe('handleWorkersAiRequest routing', () => {
  it('404s unknown paths', async () => {
    const res = await handleWorkersAiRequest(post('/nope', {}), makeEnv(vi.fn()))
    expect(res.status).toBe(404)
  })

  it('405s non-POST', async () => {
    const res = await handleWorkersAiRequest(
      new Request('http://workers-ai.tong/chat'),
      makeEnv(vi.fn())
    )
    expect(res.status).toBe(405)
  })

  it('500s when AI.run throws', async () => {
    const run = vi.fn().mockRejectedValue(new Error('boom'))
    const res = await handleWorkersAiRequest(
      post('/chat', { messages: [{ role: 'user', content: 'hi' }] }),
      makeEnv(run)
    )
    expect(res.status).toBe(500)
    expect(await res.json()).toEqual({ error: 'boom' })
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/lib/workers-ai-bridge.test.ts`
Expected: FAIL — cannot resolve `./workers-ai-bridge`.

- [ ] **Step 3: Write the implementation**

```ts
// server/lib/workers-ai-bridge.ts
// Serves the container's virtual-host requests (http://workers-ai.tong/*)
// from inside the Workers runtime, via UmapContainer's outbound interception.

export const TOPIC_NAMING_MODEL = '@cf/moonshotai/kimi-k2.6'
export const KEYPHRASE_EMBEDDING_MODEL = '@cf/google/embeddinggemma-300m'

const EMBED_BATCH_SIZE = 90

interface ChatMessage {
  role: string
  content: string
}

interface ChatRequestBody {
  messages?: ChatMessage[]
  temperature?: number
  max_tokens?: number
}

interface ChatCompletionResponse {
  choices?: Array<{ message?: { content?: string } }>
  response?: string
}

interface EmbedRequestBody {
  texts?: string[]
}

interface EmbeddingResponse {
  data?: number[][]
}

type AiRun = (model: string, args: Record<string, unknown>) => Promise<unknown>

export async function handleWorkersAiRequest(request: Request, env: Env): Promise<Response> {
  if (request.method !== 'POST') {
    return Response.json({ error: 'method not allowed' }, { status: 405 })
  }
  const path = new URL(request.url).pathname
  try {
    if (path === '/chat') return await handleChat(request, env)
    if (path === '/embed') return await handleEmbed(request, env)
    return Response.json({ error: 'not found' }, { status: 404 })
  } catch (err) {
    const message = err instanceof Error ? err.message : 'workers-ai bridge failure'
    return Response.json({ error: message }, { status: 500 })
  }
}

async function handleChat(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as ChatRequestBody
  if (!Array.isArray(body.messages) || body.messages.length === 0) {
    return Response.json({ error: 'messages required' }, { status: 400 })
  }
  const result = (await (env.AI.run as AiRun)(TOPIC_NAMING_MODEL, {
    messages: body.messages,
    temperature: body.temperature ?? 0.4,
    max_tokens: body.max_tokens ?? 256,
  })) as ChatCompletionResponse
  const content = result.choices?.[0]?.message?.content ?? result.response ?? ''
  return Response.json({ content })
}

async function handleEmbed(request: Request, env: Env): Promise<Response> {
  const body = (await request.json()) as EmbedRequestBody
  if (!Array.isArray(body.texts) || body.texts.length === 0) {
    return Response.json({ error: 'texts required' }, { status: 400 })
  }
  const vectors: number[][] = []
  for (let i = 0; i < body.texts.length; i += EMBED_BATCH_SIZE) {
    const result = (await (env.AI.run as AiRun)(KEYPHRASE_EMBEDDING_MODEL, {
      text: body.texts.slice(i, i + EMBED_BATCH_SIZE),
    })) as EmbeddingResponse
    vectors.push(...(result.data ?? []))
  }
  return Response.json({ vectors })
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run server/lib/workers-ai-bridge.test.ts`
Expected: PASS (7 tests).

- [ ] **Step 5: Wire outbound interception**

Replace the whole of `server/containers/umap.ts` with:

```ts
import { Container } from '@cloudflare/containers'
import { handleWorkersAiRequest } from '../lib/workers-ai-bridge'

export class UmapContainer extends Container {
  defaultPort = 8080
  sleepAfter = '5m'

  // Python in the container reaches Workers AI by requesting this virtual
  // hostname; the handler runs in the Workers runtime with env.AI access.
  static outboundByHost = {
    'workers-ai.tong': (request: Request, env: Env) => handleWorkersAiRequest(request, env),
  }
}
```

In `server/index.ts`, after `export { UmapContainer } from './containers/umap'` (line 18), add:

```ts
// Required by @cloudflare/containers outbound interception (outboundByHost).
export { ContainerProxy } from '@cloudflare/containers'
```

- [ ] **Step 6: Type-check and full test suite**

Run: `npm run build && npx vitest run`
Expected: build succeeds, all tests pass. If `outboundByHost`'s handler type complains about `Env`, match the package's `OutboundHandler` signature — handlers are `(req: Request, env: Env, ctx) => Promise<Response> | Response` (see `node_modules/@cloudflare/containers/dist/lib/container.d.ts:14`).

- [ ] **Step 7: Commit**

```bash
git add server/lib/workers-ai-bridge.ts server/lib/workers-ai-bridge.test.ts server/containers/umap.ts server/index.ts
git commit -m "feat(topics): Workers AI bridge via container outbound interception (#4)"
```

---

### Task 2: Container Python — Workers AI client + toponymy wrappers

**Files:**
- Modify: `container/requirements.txt`
- Create: `container/requirements-dev.txt`
- Create: `container/workers_ai.py`
- Test: `container/test_workers_ai.py`
- Modify: `.gitignore` (add `container/.venv`)

**Interfaces:**
- Consumes: Task 1's HTTP contract (`/chat` → `{content}`, `/embed` → `{vectors}`).
- Produces: `WorkersAIClient(base_url=..., client=...)` with `.chat(messages, temperature=0.4, max_tokens=256) -> str` and `.embed(texts) -> list[list[float]]`; `WorkersAINamer(client, llm_specific_instructions=None)` (a toponymy `LLMWrapper`); `WorkersAIEmbedder(client, batch_size=90)` with `.encode(texts, ...) -> np.ndarray`. Task 3 and Task 4 consume all three.

- [ ] **Step 1: Update dependencies**

Replace `container/requirements.txt` with:

```
fastapi==0.115.12
uvicorn[standard]==0.34.0
umap-learn==0.5.7
scikit-learn==1.6.1
numpy==1.26.4
toponymy==0.5.2
jieba==0.42.1
httpx==0.28.1
```

(scikit-learn bumped from 1.5.2: toponymy 0.5.2 requires >=1.6; umap-learn 0.5.7 is compatible.)

Create `container/requirements-dev.txt`:

```
-r requirements.txt
pytest==8.3.4
```

Append to `.gitignore`:

```
container/.venv
```

- [ ] **Step 2: Create the test venv**

```bash
cd container && python3 -m venv .venv && .venv/bin/pip install -r requirements-dev.txt
```

Expected: installs cleanly (toponymy pulls transformers/datasets/fast_hdbscan — this is large, several minutes). If a resolver conflict appears, resolve it by adjusting the *pinned* versions in requirements.txt (keep toponymy==0.5.2), and note the change in the commit message.

- [ ] **Step 3: Write the failing test**

```python
# container/test_workers_ai.py
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
```

- [ ] **Step 4: Run test to verify it fails**

Run: `cd container && .venv/bin/python -m pytest test_workers_ai.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'workers_ai'`.

- [ ] **Step 5: Write the implementation**

```python
# container/workers_ai.py
"""HTTP client for the Worker-side Workers AI bridge, plus toponymy wrappers.

The Worker intercepts outbound requests to http://workers-ai.tong (see
server/containers/umap.ts) and serves them with env.AI inside the Workers
runtime, so no credentials are needed here.
"""

import os
from typing import Optional

import httpx
import numpy as np
from toponymy.llm_wrappers import LLMWrapper

WORKERS_AI_BASE_URL = os.environ.get("WORKERS_AI_BASE_URL", "http://workers-ai.tong")


class WorkersAIClient:
    def __init__(self, base_url: str = WORKERS_AI_BASE_URL, client: Optional[httpx.Client] = None):
        self.base_url = base_url.rstrip("/")
        self.client = client or httpx.Client(timeout=httpx.Timeout(120.0))

    def chat(self, messages: list[dict], temperature: float = 0.4, max_tokens: int = 256) -> str:
        response = self.client.post(
            f"{self.base_url}/chat",
            json={"messages": messages, "temperature": temperature, "max_tokens": max_tokens},
        )
        response.raise_for_status()
        return response.json()["content"]

    def embed(self, texts: list[str]) -> list[list[float]]:
        response = self.client.post(f"{self.base_url}/embed", json={"texts": list(texts)})
        response.raise_for_status()
        return response.json()["vectors"]


class WorkersAINamer(LLMWrapper):
    """Toponymy LLM wrapper backed by kimi-k2.6 via the Workers AI bridge."""

    supports_system_prompts = True

    def __init__(self, client: WorkersAIClient, llm_specific_instructions: Optional[str] = None):
        self.client = client
        self.callback = None  # DebugCallbackMixin expects this attribute
        self.extra_prompting = (
            "\n\n" + llm_specific_instructions if llm_specific_instructions else ""
        )

    def _call_llm(self, prompt: str, temperature: float, max_tokens: int) -> str:
        return self.client.chat(
            [{"role": "user", "content": prompt + self.extra_prompting}],
            temperature=temperature,
            max_tokens=max_tokens,
        )

    def _call_llm_with_system_prompt(
        self, system_prompt: str, user_prompt: str, temperature: float, max_tokens: int
    ) -> str:
        return self.client.chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt + self.extra_prompting},
            ],
            temperature=temperature,
            max_tokens=max_tokens,
        )


class WorkersAIEmbedder:
    """Satisfies toponymy's TextEmbedderProtocol via the Workers AI bridge."""

    def __init__(self, client: WorkersAIClient, batch_size: int = 90):
        self.client = client
        self.batch_size = batch_size

    def encode(self, texts, show_progress_bar=None, **kwargs) -> np.ndarray:
        texts = list(texts)
        if not texts:
            return np.zeros((0, 1), dtype=np.float32)
        vectors: list[list[float]] = []
        for i in range(0, len(texts), self.batch_size):
            vectors.extend(self.client.embed(texts[i : i + self.batch_size]))
        return np.asarray(vectors, dtype=np.float32)
```

- [ ] **Step 6: Run test to verify it passes**

Run: `cd container && .venv/bin/python -m pytest test_workers_ai.py -v`
Expected: PASS (5 tests). If `WorkersAINamer` instantiation fails on the abstract base or a missing mixin attribute, inspect `container/.venv/lib/python*/site-packages/toponymy/llm_wrappers.py` and set the attribute it needs — do not fork the base class.

- [ ] **Step 7: Commit**

```bash
git add container/requirements.txt container/requirements-dev.txt container/workers_ai.py container/test_workers_ai.py .gitignore
git commit -m "feat(topics): container-side Workers AI client and toponymy wrappers (#4)"
```

---

### Task 3: Container Python — topic computation pipeline

**Files:**
- Create: `container/topics.py`
- Test: `container/test_topics.py`

**Interfaces:**
- Consumes: `WorkersAINamer`, `WorkersAIEmbedder`, `WorkersAIClient` from Task 2.
- Produces: `compute_topics(texts, embedding_vectors, coords_2d, namer, embedder, min_points=15) -> list[list[dict]]` (layers coarse→fine; entries `{label_zh, label_en, x, y, size}`) and `translate_labels(labels_zh, client) -> list[str]`. Task 4 consumes `compute_topics`.

- [ ] **Step 1: Write the failing test**

```python
# container/test_topics.py
import json

import httpx
import numpy as np

from topics import CHINESE_STOP_WORDS, JiebaTokenizer, compute_topics, translate_labels
from workers_ai import WorkersAIClient, WorkersAINamer, WorkersAIEmbedder


class FakeEmbedder:
    """Deterministic per-text vectors so toponymy gets stable input."""

    def encode(self, texts, show_progress_bar=None, **kwargs):
        out = []
        for t in texts:
            rng = np.random.default_rng(abs(hash(t)) % (2**32))
            out.append(rng.normal(size=16))
        return np.asarray(out, dtype=np.float32)


def make_fake_namer():
    counter = {"n": 0}

    def handler(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        prompt = body["messages"][-1]["content"]
        if "English gloss" in prompt:
            labels = json.loads(prompt[prompt.index("[") :])
            return httpx.Response(200, json={"content": json.dumps([f"gloss {i}" for i in range(len(labels))])})
        counter["n"] += 1
        return httpx.Response(200, json={"content": json.dumps({"topic_name": f"主题{counter['n']}"})})

    client = WorkersAIClient(base_url="http://workers-ai.tong", client=httpx.Client(transport=httpx.MockTransport(handler)))
    return WorkersAINamer(client), client


def test_jieba_tokenizer_protocol():
    tok = JiebaTokenizer()
    tokens = tok.encode("我喜欢唐诗")
    assert isinstance(tokens, list) and len(tokens) >= 2
    assert tok.decode(tokens) == "我喜欢唐诗"


def test_too_few_points_returns_empty():
    namer, _ = make_fake_namer()
    texts = ["你好世界"] * 5
    vecs = np.zeros((5, 16), dtype=np.float32)
    coords = np.zeros((5, 2), dtype=np.float32)
    assert compute_topics(texts, vecs, coords, namer, FakeEmbedder()) == []


def test_translate_labels_roundtrip():
    _, client = make_fake_namer()
    assert translate_labels(["唐诗", "宋词"], client) == ["gloss 0", "gloss 1"]


def test_translate_labels_failure_returns_blanks():
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(200, json={"content": "not json at all"})

    client = WorkersAIClient(base_url="http://workers-ai.tong", client=httpx.Client(transport=httpx.MockTransport(handler)))
    assert translate_labels(["唐诗", "宋词"], client) == ["", ""]


def test_compute_topics_end_to_end_with_blobs():
    # Three well-separated blobs of 30 points each, texts drawn from three themes.
    rng = np.random.default_rng(42)
    themes = [
        "唐代诗人李白写了很多关于月亮和酒的诗歌作品",
        "现代中国经济发展迅速科技公司在市场上竞争激烈",
        "中国传统烹饪讲究火候食材新鲜菜肴味道鲜美可口",
    ]
    texts, coords, vecs = [], [], []
    centers_2d = [(0.0, 0.0), (10.0, 0.0), (0.0, 10.0)]
    for b, theme in enumerate(themes):
        for i in range(30):
            texts.append(theme + f"第{i}段")
            coords.append(rng.normal(loc=centers_2d[b], scale=0.3))
            center = np.zeros(16)
            center[b * 5 : b * 5 + 5] = 3.0
            vecs.append(center + rng.normal(scale=0.1, size=16))
    namer, _ = make_fake_namer()

    layers = compute_topics(texts, np.asarray(vecs, np.float32), np.asarray(coords, np.float32), namer, FakeEmbedder())

    assert isinstance(layers, list) and len(layers) >= 1
    for layer in layers:
        assert len(layer) >= 1
        for entry in layer:
            assert set(entry) == {"label_zh", "label_en", "x", "y", "size"}
            assert entry["label_zh"].startswith("主题")
            assert entry["label_en"].startswith("gloss")
            assert entry["size"] >= 1
    # Finest layer (last) should have found roughly the three blobs.
    assert len(layers[-1]) >= 2


def test_stop_words_present():
    assert "的" in CHINESE_STOP_WORDS
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container && .venv/bin/python -m pytest test_topics.py -v`
Expected: FAIL — `ModuleNotFoundError: No module named 'topics'`.

- [ ] **Step 3: Write the implementation**

```python
# container/topics.py
"""Hierarchical topic labeling of the document map with toponymy.

Runs inside the UMAP container. LLM + embedding calls go through the
Workers AI bridge (see workers_ai.py). Output layers are ordered
coarse -> fine; label x/y are centroids in raw UMAP coordinate space.
"""

import json
import re

import jieba
import numpy as np
from toponymy.clustering import ToponymyClusterer
from toponymy.keyphrases import KeyphraseBuilder
from toponymy.toponymy import Toponymy

from workers_ai import WorkersAIClient

CHINESE_STOP_WORDS = frozenset(
    "的 了 是 在 和 有 我 你 他 她 它 们 这 那 就 都 而 及 与 或 被 把 从 对 到 中 上 下 "
    "不 很 地 得 着 之 为 于 以 其 并 等 也 说 又 去 来 会 能 要 只 但 还 没 好 一个 我们 "
    "没有 什么 这个 那个 因为 所以 如果 虽然 但是 而且".split()
)

MIN_POINTS_FOR_TOPICS = 15


class JiebaTokenizer:
    """Adapter matching toponymy's TokenizerLike protocol for Chinese text."""

    def encode(self, text: str) -> list:
        return jieba.lcut(text)

    def decode(self, tokens: list) -> str:
        return "".join(tokens)


def translate_labels(labels_zh: list, client: WorkersAIClient) -> list:
    """One batched LLM call turning Chinese topic labels into English glosses."""
    if not labels_zh:
        return []
    prompt = (
        "Translate each Chinese topic label into a concise English gloss (2-5 words). "
        "Respond with ONLY a JSON array of strings, same order and length as the input.\n\n"
        + json.dumps(list(labels_zh), ensure_ascii=False)
    )
    try:
        raw = client.chat([{"role": "user", "content": prompt}], temperature=0.1, max_tokens=2048)
        match = re.search(r"\[.*\]", raw, re.DOTALL)
        glosses = json.loads(match.group(0)) if match else None
        if isinstance(glosses, list) and len(glosses) == len(labels_zh):
            return [str(g) for g in glosses]
    except Exception:
        pass
    return [""] * len(labels_zh)


def compute_topics(
    texts,
    embedding_vectors,
    coords_2d,
    namer,
    embedder,
    min_points: int = MIN_POINTS_FOR_TOPICS,
) -> list:
    """Returns layers (coarse -> fine) of {label_zh, label_en, x, y, size}."""
    texts = list(texts)
    if len(texts) < min_points:
        return []

    coords = np.asarray(coords_2d, dtype=np.float32)
    vectors = np.asarray(embedding_vectors, dtype=np.float32)

    clusterer = ToponymyClusterer(
        min_clusters=3, base_min_cluster_size=5, max_layers=4, verbose=False
    )
    keyphrase_builder = KeyphraseBuilder(
        tokenizer=JiebaTokenizer(),
        ngram_range=(1, 3),
        stop_words=CHINESE_STOP_WORDS,
        verbose=False,
    )
    model = Toponymy(
        llm_wrapper=namer,
        text_embedding_model=embedder,
        clusterer=clusterer,
        keyphrase_builder=keyphrase_builder,
        object_description="Chinese text passages",
        corpus_description="a personal library of Chinese documents used for language learning",
        verbose=False,
    )

    try:
        model.fit(texts, vectors, coords)
    except (ValueError, IndexError):
        # Degenerate data: too few clusterable points / no layers formed.
        return []

    # Toponymy layer 0 is the finest; our API is coarse -> fine.
    layers = []
    for layer, names in zip(model.cluster_layers_, model.topic_names_):
        labels = np.asarray(layer.cluster_labels)
        entries = []
        for cluster_index, name in enumerate(names):
            mask = labels == cluster_index
            if not mask.any() or not name:
                continue
            centroid = coords[mask].mean(axis=0)
            entries.append(
                {
                    "label_zh": str(name),
                    "label_en": "",
                    "x": float(centroid[0]),
                    "y": float(centroid[1]),
                    "size": int(mask.sum()),
                }
            )
        if entries:
            layers.append(entries)
    layers.reverse()

    all_labels = [entry["label_zh"] for layer in layers for entry in layer]
    glosses = translate_labels(all_labels, namer.client)
    i = 0
    for layer in layers:
        for entry in layer:
            entry["label_en"] = glosses[i]
            i += 1

    return layers
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container && .venv/bin/python -m pytest test_topics.py -v`
Expected: PASS (6 tests). The end-to-end blob test exercises real toponymy (fast_hdbscan JIT on first run — allow ~1 min). If toponymy's naming prompts for higher layers use a different response path (e.g. `generate_topic_cluster_names` expecting a JSON object of names), adapt the fake handler in the test to return what the *real* base-class parser accepts — inspect the failing prompt text in the assertion output; the production wrapper needs no change since the base class does the parsing/retries.

- [ ] **Step 5: Commit**

```bash
git add container/topics.py container/test_topics.py
git commit -m "feat(topics): toponymy pipeline with jieba keyphrases and bilingual labels (#4)"
```

---

### Task 4: Container — background job, in-memory cache, /topics endpoint

**Files:**
- Modify: `container/app.py` (full replacement below)
- Modify: `container/Dockerfile` (copy all .py files)
- Test: `container/test_app.py`

**Interfaces:**
- Consumes: `compute_topics` (Task 3), `WorkersAIClient`/`WorkersAINamer`/`WorkersAIEmbedder` (Task 2).
- Produces: POST `/reduce` accepts optional `texts: list[str]` (aligned with the *first* `len(texts)` vectors) and then returns `{coords, topicsKey}`; GET `/topics/{key}` returns `{"status": "pending"} | {"status": "ready", "layers": [...]} | {"status": "error", "error": str}`. Task 5's Worker route consumes both.

- [ ] **Step 1: Write the failing test**

```python
# container/test_app.py
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd container && .venv/bin/python -m pytest test_app.py -v`
Expected: FAIL — `ImportError: cannot import name 'topics_key'`.

- [ ] **Step 3: Write the implementation**

Replace `container/app.py` with:

```python
import hashlib
import json
import threading

import numpy as np
from fastapi import BackgroundTasks, FastAPI
from pydantic import BaseModel
from umap import UMAP

app = FastAPI()

# In-memory topic-job cache: key -> {"status": ..., "layers"?: ..., "error"?: ...}.
# Lives as long as the container instance (sleepAfter = 5m in umap.ts).
TOPIC_JOBS: dict = {}
_JOBS_LOCK = threading.Lock()


class ReduceRequest(BaseModel):
    vectors: list[list[float]]
    # Optional chunk texts, aligned with the FIRST len(texts) vectors.
    # Presence triggers a concurrent topic-labeling job.
    texts: list[str] | None = None
    n_neighbors: int = 15
    min_dist: float = 0.1


def topics_key(texts: list) -> str:
    digest = hashlib.sha256(json.dumps(list(texts), ensure_ascii=False).encode("utf-8"))
    return digest.hexdigest()[:16]


def run_topic_job(key: str, texts: list, vectors, coords) -> None:
    # Imports are lazy so /reduce cold-start stays unchanged.
    from topics import compute_topics
    from workers_ai import WorkersAIClient, WorkersAIEmbedder, WorkersAINamer

    try:
        client = WorkersAIClient()
        namer = WorkersAINamer(
            client,
            llm_specific_instructions="The topic name must be written in Simplified Chinese.",
        )
        layers = compute_topics(texts, vectors, coords, namer, WorkersAIEmbedder(client))
        with _JOBS_LOCK:
            TOPIC_JOBS[key] = {"status": "ready", "layers": layers}
    except Exception as exc:  # job must never crash the server
        with _JOBS_LOCK:
            TOPIC_JOBS[key] = {"status": "error", "error": str(exc)}


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/reduce")
async def reduce(req: ReduceRequest, background_tasks: BackgroundTasks):
    arr = np.array(req.vectors, dtype=np.float32)
    actual_neighbors = min(req.n_neighbors, len(req.vectors) - 1)
    reducer = UMAP(
        n_components=2,
        n_neighbors=actual_neighbors,
        min_dist=req.min_dist,
        random_state=42,
        metric="cosine",
    )
    embedding = reducer.fit_transform(arr)

    key = None
    if req.texts and len(req.texts) <= len(req.vectors):
        n = len(req.texts)
        key = topics_key(req.texts)
        with _JOBS_LOCK:
            fresh = key not in TOPIC_JOBS
            if fresh:
                TOPIC_JOBS[key] = {"status": "pending"}
        if fresh:
            background_tasks.add_task(
                run_topic_job, key, req.texts, arr[:n], np.asarray(embedding)[:n]
            )

    return {"coords": embedding.tolist(), "topicsKey": key}


@app.get("/topics/{key}")
async def topics(key: str):
    with _JOBS_LOCK:
        job = TOPIC_JOBS.get(key)
    if job is None:
        return {"status": "error", "error": "unknown key"}
    return job
```

In `container/Dockerfile`, change `COPY app.py .` to:

```dockerfile
COPY *.py .
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd container && .venv/bin/python -m pytest test_app.py -v`
Expected: PASS (5 tests). Note: each `/reduce` call runs real UMAP; first call JIT-compiles numba (~30 s locally), later calls are fast.

- [ ] **Step 5: Run the whole container test suite**

Run: `cd container && .venv/bin/python -m pytest -v`
Expected: all Task 2-4 tests pass.

- [ ] **Step 6: Commit**

```bash
git add container/app.py container/test_app.py container/Dockerfile
git commit -m "feat(topics): concurrent topic-label job with in-memory cache in UMAP container (#4)"
```

---

### Task 5: Worker — send texts, pass through topicsKey, proxy /topics

**Files:**
- Modify: `server/routes/library-visualization.ts`
- Test: `server/routes/library-visualization.test.ts`

**Interfaces:**
- Consumes: container `/reduce` + `/topics/{key}` (Task 4 shapes).
- Produces: `GET /api/library/visualization` response gains `topicsKey: string | null`; new `GET /api/library/visualization/topics?key=<16-hex>` proxying the container. Exports for tests/frontend: `isValidTopicsKey(key: string): boolean`, `computeDocMaxVectors(chunks, vectorMap): Map<number, number[]>`. Task 6 consumes both endpoints.

- [ ] **Step 1: Write the failing test**

```ts
// server/routes/library-visualization.test.ts
import { describe, it, expect } from 'vitest'
import { computeDocMaxVectors, isValidTopicsKey } from './library-visualization'

describe('isValidTopicsKey', () => {
  it('accepts 16 lowercase hex chars', () => {
    expect(isValidTopicsKey('deadbeef01234567')).toBe(true)
  })
  it('rejects wrong length, uppercase, and path-traversal input', () => {
    expect(isValidTopicsKey('deadbeef')).toBe(false)
    expect(isValidTopicsKey('DEADBEEF01234567')).toBe(false)
    expect(isValidTopicsKey('../secrets/xxxxx')).toBe(false)
    expect(isValidTopicsKey('')).toBe(false)
  })
})

describe('computeDocMaxVectors', () => {
  it('takes the elementwise max across a document’s chunks', () => {
    const chunks = [
      { id: 1, source_document_id: 10 },
      { id: 2, source_document_id: 10 },
      { id: 3, source_document_id: 20 },
    ]
    const vectorMap = new Map<string, number[]>([
      ['1', [1, 5]],
      ['2', [3, 2]],
      ['3', [0, 0]],
    ])
    const result = computeDocMaxVectors(chunks, vectorMap)
    expect(result.get(10)).toEqual([3, 5])
    expect(result.get(20)).toEqual([0, 0])
  })

  it('skips chunks without vectors', () => {
    const result = computeDocMaxVectors([{ id: 1, source_document_id: 10 }], new Map())
    expect(result.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run server/routes/library-visualization.test.ts`
Expected: FAIL — `isValidTopicsKey`/`computeDocMaxVectors` not exported.

- [ ] **Step 3: Write the implementation**

Replace `server/routes/library-visualization.ts` with:

```ts
import { Hono } from 'hono'

// VectorizeVector is a global type from worker-configuration.d.ts
type VectorizeVector = { id: string; values: Float32Array | number[]; namespace?: string; metadata?: Record<string, unknown> }

interface ReduceResponse {
  coords: [number, number][]
  topicsKey?: string | null
}

export interface ChunkRow {
  id: number
  source_document_id: number
}

export function isValidTopicsKey(key: string): boolean {
  return /^[0-9a-f]{16}$/.test(key)
}

export function computeDocMaxVectors(
  chunks: ChunkRow[],
  vectorMap: Map<string, number[]>
): Map<number, number[]> {
  const docVectorMap = new Map<number, number[]>()
  for (const chunk of chunks) {
    const vec = vectorMap.get(String(chunk.id))
    if (!vec) continue
    const existing = docVectorMap.get(chunk.source_document_id)
    if (!existing) {
      docVectorMap.set(chunk.source_document_id, vec.slice())
    } else {
      for (let d = 0; d < vec.length; d++) {
        if (vec[d] > existing[d]) existing[d] = vec[d]
      }
    }
  }
  return docVectorMap
}

function getUmapContainer(env: Env) {
  return env.UMAP_CONTAINER.get(env.UMAP_CONTAINER.idFromName('singleton'))
}

const libraryVisualizationRoutes = new Hono<{ Bindings: Env }>()

libraryVisualizationRoutes.get('/', async (c) => {
  // 1. Query all documents
  const docsResult = await c.env.DB.prepare(
    'SELECT id, title, original_doc_filename FROM document ORDER BY id'
  ).all<{ id: number; title: string | null; original_doc_filename: string }>()

  // 2. Query all chunks (content feeds the topic-labeling job)
  const chunksResult = await c.env.DB.prepare(
    'SELECT id, source_document_id, content FROM text_chunk ORDER BY id'
  ).all<{ id: number; source_document_id: number; content: string }>()

  const allChunkIds = chunksResult.results.map((c) => String(c.id))

  // 3. Batch-fetch vectors from Vectorize in batches of 20
  const vectorMap = new Map<string, number[]>()
  for (let i = 0; i < allChunkIds.length; i += 20) {
    const batch = allChunkIds.slice(i, i + 20)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const result = await (c.env.CHUNK_VECTORS as any).getByIds(batch, { namespace: 'document' }) as VectorizeVector[]
    for (const match of result) {
      if (match.values) {
        vectorMap.set(match.id, Array.from(match.values))
      }
    }
  }

  // 4. Build ordered list of chunks that have vectors
  const chunksWithVectors = chunksResult.results.filter((chunk) => vectorMap.has(String(chunk.id)))
  const chunkVectors = chunksWithVectors.map((chunk) => vectorMap.get(String(chunk.id))!)

  // 5. Compute per-document elementwise max embeddings
  const docVectorMap = computeDocMaxVectors(chunksWithVectors, vectorMap)

  // Only include documents that have at least one chunk with a vector
  const docsWithVectors = docsResult.results.filter((doc) => docVectorMap.has(doc.id))
  const docMaxVectors = docsWithVectors.map((doc) => docVectorMap.get(doc.id)!)

  // Need at least 2 points to run UMAP
  const totalPoints = chunkVectors.length + docMaxVectors.length
  if (totalPoints < 2) {
    return c.json({ chunks: [], documents: [], topicsKey: null })
  }

  // 6. Call UMAP container; chunk vectors first so texts align with them
  const reduceResponse = await getUmapContainer(c.env).fetch('http://localhost/reduce', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      vectors: [...chunkVectors, ...docMaxVectors],
      texts: chunksWithVectors.map((chunk) => chunk.content),
    }),
  })

  if (!reduceResponse.ok) {
    return c.json({ error: 'UMAP reduction failed' }, 500)
  }

  const { coords, topicsKey } = (await reduceResponse.json()) as ReduceResponse

  // 7. Split coords at chunksWithVectors.length offset
  const chunkCoords = coords.slice(0, chunksWithVectors.length)
  const docCoords = coords.slice(chunksWithVectors.length)

  return c.json({
    chunks: chunksWithVectors.map((chunk, i) => ({
      id: chunk.id,
      documentId: chunk.source_document_id,
      x: chunkCoords[i][0],
      y: chunkCoords[i][1],
    })),
    documents: docsWithVectors.map((doc, i) => ({
      id: doc.id,
      title: doc.title,
      filename: doc.original_doc_filename,
      x: docCoords[i][0],
      y: docCoords[i][1],
    })),
    topicsKey: topicsKey ?? null,
  })
})

libraryVisualizationRoutes.get('/topics', async (c) => {
  const key = c.req.query('key')
  if (!key || !isValidTopicsKey(key)) {
    return c.json({ status: 'error', error: 'invalid key' }, 400)
  }
  const response = await getUmapContainer(c.env).fetch(`http://localhost/topics/${key}`)
  const body = (await response.json()) as Record<string, unknown>
  return c.json(body, response.ok ? 200 : 502)
})

export default libraryVisualizationRoutes
```

- [ ] **Step 4: Run tests and type-check**

Run: `npx vitest run && npm run build`
Expected: all tests pass, build clean.

- [ ] **Step 5: Commit**

```bash
git add server/routes/library-visualization.ts server/routes/library-visualization.test.ts
git commit -m "feat(topics): send chunk texts to container and proxy topic status (#4)"
```

---

### Task 6: Frontend — poll topics and render zoom-layered labels

**Files:**
- Create: `src/composables/topicLayers.ts`
- Test: `src/composables/topicLayers.test.ts`
- Modify: `src/views/DocumentsView.vue`

**Interfaces:**
- Consumes: `GET /api/library/visualization` (`topicsKey`), `GET /api/library/visualization/topics?key=` (Task 5).
- Produces: `visibleLayerIndex(k: number, layerCount: number, kMin?: number, kMax?: number): number` and types `TopicLabel`/`TopicLayers` used by DocumentsView.

- [ ] **Step 1: Write the failing test**

```ts
// src/composables/topicLayers.test.ts
import { describe, it, expect } from 'vitest'
import { visibleLayerIndex } from './topicLayers'

describe('visibleLayerIndex', () => {
  it('returns -1 for zero layers', () => {
    expect(visibleLayerIndex(1, 0)).toBe(-1)
  })

  it('always returns 0 for a single layer', () => {
    expect(visibleLayerIndex(0.2, 1)).toBe(0)
    expect(visibleLayerIndex(20, 1)).toBe(0)
  })

  it('shows the coarsest layer fully zoomed out and the finest fully zoomed in', () => {
    expect(visibleLayerIndex(0.2, 3)).toBe(0)
    expect(visibleLayerIndex(20, 3)).toBe(2)
  })

  it('clamps k outside the zoom extent', () => {
    expect(visibleLayerIndex(0.01, 3)).toBe(0)
    expect(visibleLayerIndex(100, 3)).toBe(2)
  })

  it('is monotonic in k', () => {
    let prev = -1
    for (const k of [0.2, 0.5, 1, 2, 4, 8, 16, 20]) {
      const idx = visibleLayerIndex(k, 4)
      expect(idx).toBeGreaterThanOrEqual(prev)
      prev = idx
    }
  })
})
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/composables/topicLayers.test.ts`
Expected: FAIL — cannot resolve `./topicLayers`.

- [ ] **Step 3: Write the helper**

```ts
// src/composables/topicLayers.ts
export interface TopicLabel {
  label_zh: string
  label_en: string
  x: number
  y: number
  size: number
}

export type TopicLayers = TopicLabel[][]

/**
 * Maps a d3 zoom scale k to the topic-hierarchy layer to display.
 * Layers are ordered coarse (0) -> fine (layerCount - 1); the zoom extent
 * [kMin, kMax] is split evenly in log space.
 */
export function visibleLayerIndex(k: number, layerCount: number, kMin = 0.2, kMax = 20): number {
  if (layerCount <= 0) return -1
  const clamped = Math.min(Math.max(k, kMin), kMax)
  const t = Math.log(clamped / kMin) / Math.log(kMax / kMin)
  return Math.min(layerCount - 1, Math.floor(t * layerCount))
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/composables/topicLayers.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Wire polling and label rendering into DocumentsView.vue**

Apply these changes to `src/views/DocumentsView.vue`:

1. Update imports (line 2 and add the composable):

```ts
import { ref, onMounted, onUnmounted, nextTick } from 'vue'
import { visibleLayerIndex, type TopicLabel, type TopicLayers } from '@/composables/topicLayers'
```

2. After the `DOC_COLOR` constant, add poll state and cleanup:

```ts
const POLL_INTERVAL_MS = 3000
const MAX_POLL_ATTEMPTS = 100
let pollTimer: number | null = null

onUnmounted(() => {
  if (pollTimer !== null) window.clearTimeout(pollTimer)
})
```

3. The fetched payload type gains `topicsKey`: change the `data` cast to

```ts
const data = (await res.json()) as {
  chunks: ChunkPoint[]
  documents: DocPoint[]
  topicsKey: string | null
}
```

4. Inside `onMounted`, after the document-dots block (after the `.on('click', …)` chain ends at current line 128), add the topic-label machinery. `g`, `xScale`, `yScale`, and `zoom` are already in scope:

```ts
// --- Hierarchical topic labels (issue #4) ---
const labelRoot = g.append('g').attr('class', 'topic-labels').style('pointer-events', 'none')
let topicLayerGroups: d3.Selection<SVGGElement, unknown, null, undefined>[] = []
let currentZoomK = 1
let lastVisibleLayer = -2

function updateTopicVisibility(k: number) {
  if (!topicLayerGroups.length) return
  const idx = visibleLayerIndex(k, topicLayerGroups.length)
  if (idx !== lastVisibleLayer) {
    lastVisibleLayer = idx
    topicLayerGroups.forEach((group, layerIndex) => {
      group
        .transition()
        .duration(250)
        .attr('opacity', layerIndex === idx ? 1 : 0)
        .style('pointer-events', layerIndex === idx ? 'auto' : 'none')
    })
  }
  // Counter-scale so label text keeps a constant on-screen size.
  labelRoot
    .selectAll<SVGTextElement, TopicLabel>('text.topic-label')
    .attr('transform', (d) => `translate(${xScale(d.x)},${yScale(d.y)}) scale(${1 / k})`)
}

function renderTopicLayers(layers: TopicLayers) {
  labelRoot.selectAll('*').remove()
  topicLayerGroups = layers.map((layer, layerIndex) => {
    const group = labelRoot
      .append('g')
      .attr('opacity', 0)
      .style('pointer-events', 'none')
    group
      .selectAll('text.topic-label')
      .data(layer)
      .enter()
      .append('text')
      .attr('class', 'topic-label')
      .attr('text-anchor', 'middle')
      .attr('font-size', Math.max(12, 20 - layerIndex * 3))
      .attr('transform', (d) => `translate(${xScale(d.x)},${yScale(d.y)}) scale(${1 / currentZoomK})`)
      .text((d) => d.label_zh)
      .on('mouseenter', (event: MouseEvent, d: TopicLabel) => {
        tooltip.value = {
          visible: true,
          x: event.clientX + 12,
          y: event.clientY - 8,
          title: d.label_en || d.label_zh,
          filename: d.label_zh,
        }
      })
      .on('mousemove', (event: MouseEvent) => {
        tooltip.value.x = event.clientX + 12
        tooltip.value.y = event.clientY - 8
      })
      .on('mouseleave', () => {
        tooltip.value.visible = false
      })
    return group
  })
  lastVisibleLayer = -2
  updateTopicVisibility(currentZoomK)
}

async function pollTopics(key: string, attempt = 0) {
  if (attempt >= MAX_POLL_ATTEMPTS) return
  try {
    const res = await fetch(`/api/library/visualization/topics?key=${key}`)
    if (res.ok) {
      const body = (await res.json()) as { status: string; layers?: TopicLayers }
      if (body.status === 'ready') {
        if (body.layers?.length) renderTopicLayers(body.layers)
        return
      }
      if (body.status === 'error') return
    }
  } catch {
    // transient network failure: keep polling
  }
  pollTimer = window.setTimeout(() => pollTopics(key, attempt + 1), POLL_INTERVAL_MS)
}

if (data.topicsKey) pollTopics(data.topicsKey)
```

5. Extend the existing zoom handler (currently lines 68-73) to drive label visibility:

```ts
const zoom = d3
  .zoom<SVGSVGElement, unknown>()
  .scaleExtent([0.2, 20])
  .on('zoom', (event) => {
    g.attr('transform', event.transform)
    currentZoomK = event.transform.k
    updateTopicVisibility(currentZoomK)
  })
```

Ordering inside `onMounted` (the zoom handler references the label machinery, so declaration order matters): (a) scales, (b) `const g = svg.append('g')`, (c) the entire label-machinery block from point 4 — `labelRoot`, state, `updateTopicVisibility`, `renderTopicLayers`, `pollTopics` (but NOT the `if (data.topicsKey)` call yet), (d) the zoom handler from point 5, (e) the existing chunk/document dots, (f) finally `if (data.topicsKey) pollTopics(data.topicsKey)`. Because `labelRoot` is created before the dots, add `labelRoot.raise()` as the first line of `renderTopicLayers` so labels render above the dots.

6. Add label styling to the scoped `<style>` block (`:deep` because d3 creates the nodes at runtime):

```css
.viz-svg :deep(.topic-label) {
  font-weight: 600;
  fill: rgb(var(--v-theme-on-surface));
  paint-order: stroke;
  stroke: rgb(var(--v-theme-surface));
  stroke-width: 4px;
  stroke-linejoin: round;
  cursor: default;
}
```

- [ ] **Step 6: Type-check and full test suite**

Run: `npm run build && npx vitest run`
Expected: clean build (vue-tsc catches any scoping mistakes from step 5), all tests pass.

- [ ] **Step 7: Commit**

```bash
git add src/composables/topicLayers.ts src/composables/topicLayers.test.ts src/views/DocumentsView.vue
git commit -m "feat(topics): zoom-layered bilingual topic labels on the document map (#4)"
```

---

### Task 7: End-to-end verification

**Files:** none (verification only).

- [ ] **Step 1: Full automated suite**

```bash
npx vitest run && npm run build && cd container && .venv/bin/python -m pytest -v && cd ..
```

Expected: everything green.

- [ ] **Step 2: Container image builds**

```bash
docker build -t tong-umap-test container/
```

Expected: image builds; the pip layer now includes toponymy + jieba (build takes several minutes).

- [ ] **Step 3: Live preview (requires Docker + Cloudflare login for real Workers AI)**

```bash
npm run preview
```

Open the Documents page. Verify, in order:
1. Scatterplot appears at the usual speed (labels must not block it).
2. Within a few minutes, Chinese topic labels fade in.
3. Zooming in swaps coarser labels for finer ones; text size stays constant.
4. Hovering a label shows the English gloss in the tooltip.
5. Reloading the page while the container is warm shows labels quickly (cache hit).

If outbound interception fails in local dev (virtual hostname unresolvable from the container), capture the wrangler/container logs and investigate `@cloudflare/containers` + wrangler versions before changing any code — the fallback decision (e.g. bumping `@cloudflare/containers` to 0.3.x) is an explicit checkpoint to raise with the user, not something to slip in silently.

- [ ] **Step 4: Close out**

Use superpowers:finishing-a-development-branch (or report completion if working directly on main, matching how this repo's history commits directly to main).
