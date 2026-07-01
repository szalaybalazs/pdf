"""A tiny, dependency-light vector store.

Embeddings live in a single .npy matrix; chunk metadata lives in a parallel
.jsonl file. Search is brute-force cosine similarity, which is plenty fast for
tens of thousands of chunks (our 3 books are ~1,100 pages total). Swap in FAISS
or Chroma later if the corpus grows large — the interface is intentionally small.
"""
from __future__ import annotations

import json
from dataclasses import dataclass, asdict
from pathlib import Path
from typing import Iterable

import numpy as np


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

    def __len__(self) -> int:
        return len(self.chunks)
