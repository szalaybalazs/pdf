"""SQLite-backed store for chat threads, with cross-thread vector search.

Each thread is persisted as a single JSON blob (the renderer's `Thread` object,
verbatim) so the rich UI state — messages, tool-call traces, sources, usage,
calculations — rehydrates exactly on reload. A few columns are denormalised out
of the blob for cheap listing (title, timestamps) and an optional per-thread
embedding powers semantic "search among threads".

Search reuses the same brute-force cosine approach as the PDF chunk store
(`pdf_qa/store.py`); with at most a few hundred threads it is instant.
"""
from __future__ import annotations

import json
import sqlite3
import time
from pathlib import Path

import numpy as np

from .textutil import strip_surrogates


class ThreadStore:
    def __init__(self, db_path: Path):
        self.path = Path(db_path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.db = sqlite3.connect(str(self.path))
        self.db.row_factory = sqlite3.Row
        self._init()

    def _init(self) -> None:
        self.db.execute(
            """CREATE TABLE IF NOT EXISTS threads (
                   id        TEXT PRIMARY KEY,
                   title     TEXT,
                   created   REAL,
                   updated   REAL,
                   data      TEXT,        -- full Thread JSON
                   embedding BLOB         -- float32 search vector (nullable)
               )"""
        )
        self.db.commit()

    # --- write -------------------------------------------------------------
    def upsert(self, thread: dict) -> None:
        """Insert or replace one thread from its full JSON object."""
        tid = thread.get("id")
        if not tid:
            return
        now = time.time()
        row = self.db.execute("SELECT created, embedding FROM threads WHERE id=?", (tid,)).fetchone()
        created = row["created"] if row else now
        embedding = row["embedding"] if row else None  # preserve any existing vector
        self.db.execute(
            "INSERT OR REPLACE INTO threads (id, title, created, updated, data, embedding) "
            "VALUES (?,?,?,?,?,?)",
            (tid, thread.get("title", ""), created, now,
             strip_surrogates(json.dumps(thread, ensure_ascii=False)), embedding),
        )
        self.db.commit()

    def delete(self, tid: str) -> None:
        self.db.execute("DELETE FROM threads WHERE id=?", (tid,))
        self.db.commit()

    def set_title(self, tid: str, title: str) -> None:
        # update both the column and the title inside the stored JSON blob
        row = self.db.execute("SELECT data FROM threads WHERE id=?", (tid,)).fetchone()
        if not row:
            return
        data = json.loads(row["data"])
        data["title"] = title
        self.db.execute("UPDATE threads SET title=?, data=? WHERE id=?",
                        (strip_surrogates(title),
                         strip_surrogates(json.dumps(data, ensure_ascii=False)), tid))
        self.db.commit()

    def set_embedding(self, tid: str, vec: np.ndarray) -> None:
        blob = np.asarray(vec, dtype=np.float32).tobytes()
        self.db.execute("UPDATE threads SET embedding=? WHERE id=?", (blob, tid))
        self.db.commit()

    # --- read --------------------------------------------------------------
    def dump(self) -> list[dict]:
        """All threads as full JSON objects, most-recently-updated first."""
        rows = self.db.execute(
            "SELECT data, created, updated FROM threads ORDER BY updated DESC"
        ).fetchall()
        threads = []
        for r in rows:
            data = json.loads(r["data"])
            data.setdefault("createdAt", r["created"] * 1000)
            data.setdefault("updatedAt", r["updated"] * 1000)
            threads.append(data)
        return threads

    def search(self, qvec: np.ndarray, top_k: int) -> list[dict]:
        """Cosine search over thread embeddings; returns [{id, title, score}]."""
        rows = self.db.execute(
            "SELECT id, title, embedding FROM threads WHERE embedding IS NOT NULL"
        ).fetchall()
        if not rows:
            return []
        mat = np.stack([np.frombuffer(r["embedding"], dtype=np.float32) for r in rows])
        q = np.asarray(qvec, dtype=np.float32)
        q = q / (np.linalg.norm(q) + 1e-9)
        mat_norm = mat / (np.linalg.norm(mat, axis=1, keepdims=True) + 1e-9)
        scores = mat_norm @ q
        order = np.argsort(-scores)[:top_k]
        return [{"id": rows[i]["id"], "title": rows[i]["title"], "score": float(scores[i])}
                for i in order]

    def close(self) -> None:
        self.db.close()
