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
