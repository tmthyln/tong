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
