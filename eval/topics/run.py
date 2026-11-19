"""Run the production topic-labelling pipeline (container/topics.py) for one naming model.

    container/.venv/bin/python eval/topics/run.py <model> [--bridge http://127.0.0.1:8790]

Needs `npm run eval:topics -- build` (corpus + vectors) and a running bridge
(`npm run eval:topics -- bridge`). UMAP is computed once with the container's
parameters (chunks + per-document max vectors, as the route sends them) and
cached, so every model names the same clusters.
"""

import argparse
import json
import re
import sys
import time
from pathlib import Path
from urllib.parse import quote

import numpy as np

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "container"))

from topics import compute_topics  # noqa: E402
from workers_ai import WorkersAIClient, WorkersAIEmbedder, WorkersAINamer  # noqa: E402

DATA = ROOT / "eval/topics/data"
RESULTS = ROOT / "eval/topics/results/runs"


def slug(model: str) -> str:
    return re.sub(r"[^a-z0-9.-]+", "_", model.removeprefix("@cf/"), flags=re.I)


def umap_coords(vectors: np.ndarray, doc_of: list) -> np.ndarray:
    path = DATA / "coords.npy"
    if path.exists():
        return np.load(path)
    from umap import UMAP

    # Same as the route: chunk vectors first, then per-document elementwise max.
    docs = sorted(set(doc_of))
    doc_max = np.stack([vectors[[i for i, d in enumerate(doc_of) if d == doc]].max(axis=0) for doc in docs])
    allv = np.vstack([vectors, doc_max]).astype(np.float32)
    t = time.time()
    emb = UMAP(n_components=2, n_neighbors=min(15, len(allv) - 1), min_dist=0.1, random_state=42, metric="cosine").fit_transform(allv)
    print(f"umap: {len(allv)} points in {time.time() - t:.1f}s")
    coords = np.asarray(emb[: len(vectors)], dtype=np.float32)
    np.save(path, coords)
    return coords


class CountingClient(WorkersAIClient):
    calls = 0

    def chat(self, *a, **kw):
        self.calls += 1
        return super().chat(*a, **kw)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("model")
    ap.add_argument("--bridge", default="http://127.0.0.1:8790")
    ap.add_argument("--max-features", type=int, help="cap the keyphrase vocabulary (default: toponymy's 50,000)")
    args = ap.parse_args()

    chunks = json.loads((DATA / "corpus.json").read_text())
    vectors = np.asarray(json.loads((DATA / "vectors.json").read_text()), dtype=np.float32)
    coords = umap_coords(vectors, [c["doc"] for c in chunks])

    client = CountingClient(base_url=f"{args.bridge}/m/{quote(args.model, safe='')}")
    # Same instruction as container/app.py.
    namer = WorkersAINamer(client, llm_specific_instructions="The topic name must be written in Simplified Chinese.")
    t = time.time()
    started = int(t * 1000)
    kp = {"max_features": args.max_features} if args.max_features else None
    layers = compute_topics([c["text"] for c in chunks], vectors, coords, namer, WorkersAIEmbedder(client), include_members=True, keyphrase_options=kp)
    secs = time.time() - t
    RESULTS.mkdir(parents=True, exist_ok=True)
    name = args.model + (f"#kp{args.max_features}" if args.max_features else "")
    out = {"model": name, "seconds": secs, "calls": client.calls, "started": started, "ended": int(time.time() * 1000), "layers": layers}
    (RESULTS / f"{slug(name)}.json").write_text(json.dumps(out, ensure_ascii=False))
    print(f"{args.model}: {sum(len(l) for l in layers)} labels in {len(layers)} layers, {client.calls} calls, {secs:.0f}s")


if __name__ == "__main__":
    main()
