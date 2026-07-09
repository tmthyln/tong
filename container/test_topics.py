import json
import re

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
        if "new_topic_name_mapping" in prompt:
            # Batch rename path: respond per toponymy's GET_TOPIC_CLUSTER_NAMES_REGEX.
            items = re.findall(r"^\s*(\d+)\.", prompt, re.MULTILINE)
            n = max((int(i) for i in items), default=1)
            mapping = {f"{i}.": f"主题组{i}" for i in range(1, n + 1)}
            content = json.dumps(
                {"new_topic_name_mapping": mapping, "topic_specificities": [0.8] * n},
                ensure_ascii=False,
            )
            return httpx.Response(200, json={"content": content})
        counter["n"] += 1
        content = json.dumps(
            {"topic_name": f"主题{counter['n']}", "topic_specificity": 0.9}, ensure_ascii=False
        )
        return httpx.Response(200, json={"content": content})

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
