from fastapi import FastAPI
from pydantic import BaseModel
import numpy as np
from umap import UMAP

app = FastAPI()


class ReduceRequest(BaseModel):
    vectors: list[list[float]]
    n_neighbors: int = 15
    min_dist: float = 0.1


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/reduce")
async def reduce(req: ReduceRequest):
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
    return {"coords": embedding.tolist()}
