"""A tiny, dependency-light vector store.

Embeddings live in a single .npy matrix; chunk metadata lives in a parallel
.jsonl file. Search is brute-force cosine similarity, which is plenty fast for
tens of thousands of chunks (our 3 books are ~1,100 pages total). Swap in FAISS
or Chroma later if the corpus grows large — the interface is intentionally small.
"""
from __future__ import annotations

import json
import math
import re
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

import numpy as np

_TOKEN_RE = re.compile(r"[a-z0-9]+")


def _tokenize(text: str) -> list[str]:
    """Lowercase word/number tokens for BM25. Keeps alphanumerics (so part
    numbers like '6n1p' and 'el34' survive as single tokens) and drops
    punctuation — good enough for lexical matching without a stemmer dependency."""
    return _TOKEN_RE.findall(text.lower())


def _l2_normalize(mat: np.ndarray) -> np.ndarray:
    """L2-normalize each row in place. Zero rows (e.g. dry-run placeholders) are
    left untouched. Vectors are stored unit-length so search() is a bare matmul
    with no per-query copy of the whole matrix."""
    norms = np.linalg.norm(mat, axis=1, keepdims=True)
    norms[norms == 0] = 1.0
    mat /= norms
    return mat


@dataclass
class Chunk:
    id: str            # e.g. "Book.pdf:p012:c0"
    doc: str           # source filename
    page: int          # 1-based page number
    chunk_index: int   # chunk within the page
    text: str          # the chunk text (what gets embedded)
    image_path: str    # path to the rendered page PNG


class VectorStore:
    def __init__(self, prefix: Path):
        self.prefix = Path(prefix)
        self.vectors: np.ndarray | None = None
        self.chunks: list[Chunk] = []
        # BM25 index, built lazily on first bm25_search() and invalidated (set to
        # None) whenever chunks change. Only built when hybrid search is used.
        self._bm25: dict | None = None

    # --- build -------------------------------------------------------------
    def add(self, chunks: list[Chunk], vectors: np.ndarray) -> None:
        # np.array (not asarray) so we own the buffer and can normalize in place
        # without mutating the caller's array.
        vectors = _l2_normalize(np.array(vectors, dtype=np.float32))
        if self.vectors is None:
            self.vectors = vectors
        else:
            self.vectors = np.vstack([self.vectors, vectors])
        self.chunks.extend(chunks)
        self._bm25 = None   # chunk set changed — rebuild the lexical index lazily

    def remove_doc(self, doc_name: str) -> int:
        """Drop every chunk (and its vector) belonging to `doc_name`. Returns the
        number of chunks removed. Leaves the store internally consistent; call
        save() to persist the change to disk."""
        keep = [i for i, c in enumerate(self.chunks) if c.doc != doc_name]
        removed = len(self.chunks) - len(keep)
        if removed == 0:
            return 0
        self.chunks = [self.chunks[i] for i in keep]
        if self.vectors is not None:
            self.vectors = self.vectors[keep] if keep else self.vectors[:0]
        self._bm25 = None   # chunk set changed — rebuild the lexical index lazily
        return removed

    def save(self) -> None:
        self.prefix.parent.mkdir(parents=True, exist_ok=True)
        # Never hand np.save a None/object array — it would serialize a 0-d
        # object array that can only be reloaded with allow_pickle=True. Persist
        # an empty float32 matrix instead so load() always gets a real ndarray.
        mat = self.vectors
        if mat is None:
            mat = np.empty((0, 0), dtype=np.float32)
        np.save(self.prefix.with_suffix(".npy"), np.asarray(mat, dtype=np.float32))
        with open(self.prefix.with_suffix(".jsonl"), "w", encoding="utf-8") as f:
            for c in self.chunks:
                f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")

    # --- load / search -----------------------------------------------------
    @classmethod
    def load(cls, prefix: Path) -> "VectorStore":
        store = cls(prefix)
        # allow_pickle=True so we can still recover stores written by older
        # builds that saved a 0-d object array for an empty/None matrix.
        vectors = np.load(prefix.with_suffix(".npy"), allow_pickle=True)
        if vectors.dtype == object or vectors.ndim != 2 or vectors.size == 0:
            # Empty or legacy object-array store: treat as no vectors so add()
            # and search() take their None-handling paths.
            store.vectors = None
        else:
            # Normalize on load so legacy stores written before pre-normalization
            # still search correctly; re-normalizing unit vectors is a no-op.
            store.vectors = _l2_normalize(np.array(vectors, dtype=np.float32))
        store.chunks = []
        with open(prefix.with_suffix(".jsonl"), encoding="utf-8") as f:
            for line in f:
                store.chunks.append(Chunk(**json.loads(line)))
        return store

    def search(self, query_vec: np.ndarray, top_k: int,
               docs: Iterable[str] | None = None) -> list[tuple[Chunk, float]]:
        if self.vectors is None or not self.chunks:
            return []
        q = np.asarray(query_vec, dtype=np.float32)
        q /= (np.linalg.norm(q) + 1e-9)
        mat = self.vectors
        if docs is not None:
            allowed = set(docs)
            idxs = [i for i, c in enumerate(self.chunks) if c.doc in allowed]
            if not idxs:
                return []
            mat = mat[idxs]
            chunks = [self.chunks[i] for i in idxs]
        else:
            chunks = self.chunks
        # Stored vectors are already unit-length, so cosine similarity is a bare
        # matmul — no per-query normalized copy of the whole matrix.
        scores = mat @ q
        idx = np.argsort(-scores)[:top_k]
        return [(chunks[i], float(scores[i])) for i in idx]

    # --- lexical (BM25) search --------------------------------------------
    def _build_bm25(self) -> None:
        """Build an in-memory BM25 index over the chunk texts. Cheap enough to do
        lazily (tens of thousands of chunks tokenize in well under a second) and
        avoids an external dependency that would have to be bundled into the
        frozen backend."""
        tf: list[dict[str, int]] = []
        df: dict[str, int] = {}
        doc_len: list[int] = []
        for c in self.chunks:
            toks = _tokenize(c.text)
            doc_len.append(len(toks))
            counts: dict[str, int] = {}
            for t in toks:
                counts[t] = counts.get(t, 0) + 1
            tf.append(counts)
            for t in counts:
                df[t] = df.get(t, 0) + 1
        n = len(self.chunks) or 1
        # Robertson/Sparck-Jones idf with the +0.5 smoothing; clamp at 0 so a term
        # in more than half the corpus can't contribute a negative score.
        idf = {t: max(0.0, math.log(1.0 + (n - d + 0.5) / (d + 0.5))) for t, d in df.items()}
        avgdl = (sum(doc_len) / n) if n else 0.0
        self._bm25 = {"tf": tf, "idf": idf, "doc_len": doc_len, "avgdl": avgdl or 1.0}

    def bm25_search(self, query: str, top_k: int, docs: Iterable[str] | None = None,
                    k1: float = 1.5, b: float = 0.75) -> list[tuple[Chunk, float]]:
        """Okapi BM25 lexical search. Complements dense cosine search: it nails
        exact-term matches (part numbers, equation names, acronyms) that embedding
        similarity can blur. Returns [(chunk, score)] best-first; only chunks with a
        positive score are returned."""
        if not self.chunks:
            return []
        if self._bm25 is None:
            self._build_bm25()
        assert self._bm25 is not None
        tf, idf = self._bm25["tf"], self._bm25["idf"]
        doc_len, avgdl = self._bm25["doc_len"], self._bm25["avgdl"]
        qterms = set(_tokenize(query))
        allowed = set(docs) if docs is not None else None
        scored: list[tuple[Chunk, float]] = []
        for i, c in enumerate(self.chunks):
            if allowed is not None and c.doc not in allowed:
                continue
            counts = tf[i]
            dl = doc_len[i]
            s = 0.0
            for t in qterms:
                f = counts.get(t)
                if not f:
                    continue
                s += idf.get(t, 0.0) * (f * (k1 + 1.0)) / (f + k1 * (1.0 - b + b * dl / avgdl))
            if s > 0:
                scored.append((c, s))
        scored.sort(key=lambda x: x[1], reverse=True)
        return scored[:top_k]

    def __len__(self) -> int:
        return len(self.chunks)
