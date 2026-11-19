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

    def chat(self, messages: list[dict], temperature: float = 0.4, max_tokens: int = 1024) -> str:
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
    """Toponymy LLM wrapper; the Workers AI bridge picks the model (TOPIC_NAMING_MODEL)."""

    supports_system_prompts = True
    # Toponymy defaults topic-name calls to 128 tokens, which truncates JSON
    # answers from chat models; it reads this attribute when present.
    max_tokens_topic_name = 1024

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
