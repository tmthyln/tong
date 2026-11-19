"""HTTP client for the Worker-side Workers AI bridge, plus toponymy wrappers.

The Worker intercepts outbound requests to http://workers-ai.tong (see
server/containers/umap.ts) and serves them with env.AI inside the Workers
runtime, so no credentials are needed here.
"""

import asyncio
import os
import random
import time
from typing import Optional

import httpx
import numpy as np
from toponymy.llm_wrappers import AsyncLLMWrapper

WORKERS_AI_BASE_URL = os.environ.get("WORKERS_AI_BASE_URL", "http://workers-ai.tong")
TIMEOUT = httpx.Timeout(120.0)

# Naming calls in flight at once, per layer. Each is one Workers AI request
# through the Worker bridge. Paid-plan models (glm-5.3-flash, kimi) allow 20
# requests/min per account on standard billing (50 with AI Gateway credits), so
# throughput is capped by that limit; concurrency only uses its burst.
NAMING_CONCURRENCY = 4

# On HTTP 429 (the bridge's rate-limit signal) wait out the per-minute window
# instead of failing: toponymy's own retries (3, 1-10s apart) would expire
# inside the window and drop the cluster's label.
RATE_LIMIT_WAITS = (8.0, 15.0, 25.0, 30.0, 30.0)


def rate_limit_wait(attempt: int) -> Optional[float]:
    """Seconds to wait before retry `attempt` after a 429, or None to give up."""
    if attempt >= len(RATE_LIMIT_WAITS):
        return None
    return RATE_LIMIT_WAITS[attempt] * random.uniform(0.8, 1.2)


class WorkersAIClient:
    """Sync client (embeddings, label glosses) plus achat for concurrent naming.

    transport is for tests (httpx.MockTransport serves both sync and async).
    """

    def __init__(self, base_url: str = WORKERS_AI_BASE_URL, transport: Optional[httpx.BaseTransport] = None):
        self.base_url = base_url.rstrip("/")
        self.transport = transport
        self.client = httpx.Client(timeout=TIMEOUT, transport=transport)

    @staticmethod
    def _chat_body(messages: list[dict], temperature: float, max_tokens: int) -> dict:
        return {"messages": messages, "temperature": temperature, "max_tokens": max_tokens}

    def chat(self, messages: list[dict], temperature: float = 0.4, max_tokens: int = 1024) -> str:
        body = self._chat_body(messages, temperature, max_tokens)
        attempt = 0
        while True:
            response = self.client.post(f"{self.base_url}/chat", json=body)
            wait = rate_limit_wait(attempt) if response.status_code == 429 else None
            if wait is None:
                response.raise_for_status()
                return response.json()["content"]
            time.sleep(wait)
            attempt += 1

    async def achat(self, messages: list[dict], temperature: float = 0.4, max_tokens: int = 1024) -> str:
        body = self._chat_body(messages, temperature, max_tokens)
        attempt = 0
        while True:
            # A client per call: toponymy runs each layer in its own asyncio.run
            # loop, and an AsyncClient's connection pool is bound to one loop.
            async with httpx.AsyncClient(timeout=TIMEOUT, transport=self.transport) as client:
                response = await client.post(f"{self.base_url}/chat", json=body)
            wait = rate_limit_wait(attempt) if response.status_code == 429 else None
            if wait is None:
                response.raise_for_status()
                return response.json()["content"]
            await asyncio.sleep(wait)
            attempt += 1

    def embed(self, texts: list[str]) -> list[list[float]]:
        response = self.client.post(f"{self.base_url}/embed", json={"texts": list(texts)})
        response.raise_for_status()
        return response.json()["vectors"]


class WorkersAINamer(AsyncLLMWrapper):
    """Toponymy LLM wrapper; the Workers AI bridge picks the model (TOPIC_NAMING_MODEL).

    Async, so toponymy names every cluster of a layer concurrently (it gathers
    one call per prompt, with its own retries) instead of one at a time.
    Layers stay sequential: coarser prompts include the finer layer's names.
    Token budgets are toponymy's (128 for a topic name, 2048 for a
    disambiguation batch) — the budgets the label-quality eval scored.
    """

    supports_system_prompts = True

    def __init__(
        self,
        client: WorkersAIClient,
        llm_specific_instructions: Optional[str] = None,
        max_concurrency: int = NAMING_CONCURRENCY,
    ):
        self.client = client
        self.callback = None  # DebugCallbackMixin expects this attribute
        self.extra_prompting = (
            "\n\n" + llm_specific_instructions if llm_specific_instructions else ""
        )
        self.max_concurrency = max_concurrency
        self._loop = None
        self._semaphore = None

    def _limit(self) -> asyncio.Semaphore:
        # One semaphore per event loop (toponymy starts a fresh loop per layer).
        loop = asyncio.get_running_loop()
        if self._loop is not loop:
            self._loop, self._semaphore = loop, asyncio.Semaphore(self.max_concurrency)
        return self._semaphore

    async def _chat(self, messages: list[dict], temperature: float, max_tokens: int) -> str:
        async with self._limit():
            return await self.client.achat(messages, temperature=temperature, max_tokens=max_tokens)

    async def _call_single_llm(self, prompt: str, temperature: float, max_tokens: int) -> str:
        return await self._chat(
            [{"role": "user", "content": prompt + self.extra_prompting}], temperature, max_tokens
        )

    async def _call_single_llm_with_system(
        self, system_prompt: str, user_prompt: str, temperature: float, max_tokens: int
    ) -> str:
        return await self._chat(
            [
                {"role": "system", "content": system_prompt},
                {"role": "user", "content": user_prompt + self.extra_prompting},
            ],
            temperature,
            max_tokens,
        )


class WorkersAIEmbedder:
    """Satisfies toponymy's TextEmbedderProtocol via the Workers AI bridge.

    Sends all texts in one request; the bridge owns model batch limits.
    """

    def __init__(self, client: WorkersAIClient):
        self.client = client

    def encode(self, texts, show_progress_bar=None, **kwargs) -> np.ndarray:
        texts = list(texts)
        if not texts:
            return np.zeros((0, 1), dtype=np.float32)
        return np.asarray(self.client.embed(texts), dtype=np.float32)
