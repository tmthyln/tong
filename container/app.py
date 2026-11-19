import hashlib
import json
import threading

import numpy as np
from fastapi import BackgroundTasks, FastAPI, HTTPException, Request
from pydantic import BaseModel, ValidationError
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


# Binary request body from the Worker (server/lib/chunk-vectors.ts encodeVectorFrame):
# u32 LE header length, UTF-8 JSON header {count, dim, texts?, n_neighbors?,
# min_dist?}, zero padding to a 4-byte boundary, then count*dim float32 LE.
VECTOR_FRAME_CONTENT_TYPE = "application/vnd.tong.vectors"


def parse_vector_frame(body: bytes) -> tuple[dict, np.ndarray]:
    if len(body) < 4:
        raise ValueError("frame too short")
    header_len = int.from_bytes(body[:4], "little")
    header = json.loads(body[4 : 4 + header_len].decode("utf-8"))
    count, dim = int(header["count"]), int(header["dim"])
    offset = 4 + header_len + (-(4 + header_len) % 4)
    if len(body) != offset + count * dim * 4:
        raise ValueError(f"frame is {len(body)} bytes, expected {offset + count * dim * 4}")
    # Copy: frombuffer views are read-only, and UMAP/toponymy may write in place.
    vectors = np.frombuffer(body, dtype="<f4", count=count * dim, offset=offset).reshape(count, dim).copy()
    return header, vectors


async def read_reduce_request(request: Request) -> tuple[np.ndarray, list | None, int, float]:
    """The binary frame, or the original JSON body (kept so a Worker and container
    image deployed at different moments still talk)."""
    body = await request.body()
    try:
        if request.headers.get("content-type", "").startswith(VECTOR_FRAME_CONTENT_TYPE):
            header, vectors = parse_vector_frame(body)
            req = ReduceRequest.model_validate({**header, "vectors": []})
            return vectors, req.texts, req.n_neighbors, req.min_dist
        req = ReduceRequest.model_validate_json(body)
    except (ValueError, KeyError, ValidationError) as exc:
        raise HTTPException(status_code=422, detail=str(exc)[:300])
    return np.array(req.vectors, dtype=np.float32), req.texts, req.n_neighbors, req.min_dist


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
async def reduce(request: Request, background_tasks: BackgroundTasks):
    arr, texts, n_neighbors, min_dist = await read_reduce_request(request)
    if len(arr) < 2:
        raise HTTPException(status_code=422, detail="need at least 2 vectors")
    actual_neighbors = min(n_neighbors, len(arr) - 1)
    reducer = UMAP(
        n_components=2,
        n_neighbors=actual_neighbors,
        min_dist=min_dist,
        random_state=42,
        metric="cosine",
    )
    embedding = reducer.fit_transform(arr)

    key = None
    if texts and len(texts) <= len(arr):
        n = len(texts)
        key = topics_key(texts)
        with _JOBS_LOCK:
            fresh = key not in TOPIC_JOBS
            if fresh:
                TOPIC_JOBS[key] = {"status": "pending"}
        if fresh:
            background_tasks.add_task(
                run_topic_job, key, texts, arr[:n], np.asarray(embedding)[:n]
            )

    return {"coords": embedding.tolist(), "topicsKey": key}


@app.get("/topics/{key}")
async def topics(key: str):
    with _JOBS_LOCK:
        job = TOPIC_JOBS.get(key)
    if job is None:
        return {"status": "error", "error": "unknown key"}
    return job
