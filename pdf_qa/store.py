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
        vectors = np.asarray(vectors, dtype=np.float32)
        if self.vectors is None:
            self.vectors = vectors
        else:
            self.vectors = np.vstack([self.vectors, vectors])
        self.chunks.extend(chunks)

    def save(self) -> None:
        self.prefix.parent.mkdir(parents=True, exist_ok=True)
        np.save(self.prefix.with_suffix(".npy"), self.vectors)
        with open(self.prefix.with_suffix(".jsonl"), "w", encoding="utf-8") as f:
            for c in self.chunks:
                f.write(json.dumps(asdict(c), ensure_ascii=False) + "\n")

    # --- load / search -----------------------------------------------------
    @classmethod
    def load(cls, prefix: Path) -> "VectorStore":
        store = cls(prefix)
        store.vectors = np.load(prefix.with_suffix(".npy"))
        store.chunks = []
        with open(prefix.with_suffix(".jsonl"), encoding="utf-8") as f:
            for line in f:
                store.chunks.append(Chunk(**json.loads(line)))
        return store

    def search(self, query_vec: np.ndarray, top_k: int) -> list[tuple[Chunk, float]]:
        q = np.asarray(query_vec, dtype=np.float32)
        q /= (np.linalg.norm(q) + 1e-9)
        mat = self.vectors
        mat_norm = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
        scores = mat_norm @ q
        idx = np.argsort(-scores)[:top_k]
        return [(self.chunks[i], float(scores[i])) for i in idx]

    def __len__(self) -> int:
        return len(self.chunks)
