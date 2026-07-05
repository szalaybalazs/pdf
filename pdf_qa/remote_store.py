"""Client for a remote index server (see index_server/server.py).

`RemoteVectorStore` is a drop-in for `VectorStore`: the retrieval pipeline in
serve.py calls `.search()`, `.bm25_search()`, iterates `.chunks`, and takes
`len(store)` — all of which work here. The difference is where the data lives:

  * Embedding vectors stay on the server. We NEVER download the matrix, so many
    apps can share one index without each holding it in RAM. Dense `search()` is
    one small round-trip (send the query vector, get back chunk ids + scores).
  * Chunk METADATA (text, doc, page, labels — no vectors) is fetched once and
    cached locally, so BM25 lexical search, page-label maps and the pager all run
    locally with zero extra round-trips, exactly as they do for a local store.
  * Page images are fetched on demand and cached under a local directory; the
    rest of the app then treats them as ordinary local files.

Auth: a shared secret sent as `Authorization: Bearer <secret>`. An empty secret
means the server is open (it accepts the request regardless).
"""
from __future__ import annotations

import base64
import json
import threading
import urllib.error
import urllib.parse
import urllib.request
from pathlib import Path

import numpy as np

from .store import Chunk, VectorStore

# Set by connect(); config.resolve_image() uses it to materialize remote page
# images locally without threading the store through every call site.
_ACTIVE: "RemoteVectorStore | None" = None


class RemoteError(RuntimeError):
    pass


class _Client:
    """Minimal JSON/bytes HTTP client over stdlib urllib (no extra dependency in
    the frozen backend). One per remote library."""

    def __init__(self, base_url: str, secret: str, timeout: float = 30.0):
        self.base = base_url.rstrip("/")
        self.secret = (secret or "").strip()
        self.timeout = timeout

    def _headers(self, extra: dict | None = None) -> dict:
        h = {"Accept": "application/json"}
        if self.secret:
            h["Authorization"] = f"Bearer {self.secret}"
        if extra:
            h.update(extra)
        return h

    def request(self, method: str, path: str, *, json_body=None, raw_body: bytes | None = None,
                content_type: str | None = None, timeout: float | None = None) -> bytes:
        url = self.base + path
        data = raw_body
        headers = self._headers()
        if json_body is not None:
            data = json.dumps(json_body).encode("utf-8")
            content_type = "application/json"
        if content_type:
            headers["Content-Type"] = content_type
        req = urllib.request.Request(url, data=data, method=method, headers=headers)
        try:
            with urllib.request.urlopen(req, timeout=timeout or self.timeout) as resp:
                return resp.read()
        except urllib.error.HTTPError as e:
            detail = e.read().decode("utf-8", "replace")[:200]
            raise RemoteError(f"{method} {path} -> {e.code}: {detail}") from e
        except urllib.error.URLError as e:
            raise RemoteError(f"{method} {path} -> connection failed: {e.reason}") from e

    def get_json(self, path: str, **kw) -> dict:
        return json.loads(self.request("GET", path, **kw) or b"{}")

    def post_json(self, path: str, body: dict, **kw) -> dict:
        return json.loads(self.request("POST", path, json_body=body, **kw) or b"{}")


def _encode_vectors(mat: np.ndarray) -> tuple[str, int]:
    """base64 of raw little-endian float32 bytes, plus the vector dimension."""
    arr = np.ascontiguousarray(np.asarray(mat, dtype="<f4"))
    dim = int(arr.shape[-1]) if arr.ndim else 0
    return base64.b64encode(arr.tobytes()).decode("ascii"), dim


def health(base_url: str, secret: str, timeout: float = 8.0) -> dict:
    """Probe a server's /health (used by the app's 'test connection'). Raises
    RemoteError if unreachable or unauthorized."""
    return _Client(base_url, secret, timeout).get_json("/health")


class RemoteVectorStore(VectorStore):
    def __init__(self, base_url: str, secret: str, library: str, cache_dir: Path):
        # We keep no local vectors; VectorStore.__init__ sets up chunks/bm25 state.
        super().__init__(Path(cache_dir) / "store")
        self.client = _Client(base_url, secret)
        self.library = library
        self.cache_dir = Path(cache_dir)
        self._pages_dir = self.cache_dir / "pages"
        self._sources_dir = self.cache_dir / "sources"
        self._by_id: dict[str, Chunk] = {}
        self._page_lock = threading.Lock()

    # --- lifecycle ---------------------------------------------------------
    @classmethod
    def connect(cls, base_url: str, secret: str, library: str, cache_dir: Path) -> "RemoteVectorStore":
        """Create a library-scoped store and load its chunk metadata. Registers
        itself as the active remote store for page-image resolution."""
        global _ACTIVE
        store = cls(base_url, secret, library, cache_dir)
        # Ensure the library exists server-side (no-op if it already does), then
        # pull its chunk metadata into the local cache.
        store.client.request("POST", f"/v1/libraries/{urllib.parse.quote(library)}")
        store.reload()
        _ACTIVE = store
        return store

    def reload(self) -> None:
        data = self.client.get_json(f"/v1/libraries/{urllib.parse.quote(self.library)}/chunks")
        self.chunks = [Chunk(**c) for c in data.get("chunks", [])]
        self._reindex()
        self.embedder = data.get("embedder", "")

    def _reindex(self) -> None:
        self._by_id = {c.id: c for c in self.chunks}
        self._bm25 = None   # chunk set changed — lexical index rebuilds lazily

    # --- search ------------------------------------------------------------
    def search(self, query_vec, top_k: int, docs=None):
        """Dense cosine search on the server; map returned ids back to our cached
        chunks. bm25_search() is inherited and runs locally on self.chunks."""
        if not self.chunks:
            return []
        vec_b64, dim = _encode_vectors(np.asarray(query_vec, dtype=np.float32).reshape(1, -1))
        body = {"vector": vec_b64, "dim": dim, "top_k": int(top_k)}
        if docs is not None:
            body["docs"] = list(docs)
        resp = self.client.post_json(f"/v1/libraries/{urllib.parse.quote(self.library)}/search", body)
        out = []
        for h in resp.get("hits", []):
            c = self._by_id.get(h.get("id"))
            if c is not None:
                out.append((c, float(h.get("score", 0.0))))
        return out

    # --- write (used by remote ingest) -------------------------------------
    def add(self, chunks: list[Chunk], vectors: np.ndarray, embedder: str | None = None) -> None:
        from dataclasses import asdict
        vec_b64, dim = _encode_vectors(vectors)
        body = {"chunks": [asdict(c) for c in chunks], "vectors": vec_b64, "dim": dim}
        if embedder:
            body["embedder"] = embedder
        self.client.post_json(f"/v1/libraries/{urllib.parse.quote(self.library)}/add", body,
                              timeout=300.0)
        # Reflect the addition locally so a follow-on search sees it without a
        # full reload.
        self.chunks.extend(chunks)
        self._reindex()

    def remove_doc(self, doc_name: str) -> int:
        resp = self.client.post_json(
            f"/v1/libraries/{urllib.parse.quote(self.library)}/remove_doc", {"doc": doc_name})
        self.chunks = [c for c in self.chunks if c.doc != doc_name]
        self._reindex()
        return int(resp.get("removed", 0))

    def save(self) -> None:
        # The server persists on every write; nothing to do locally.
        pass

    # --- manifest (skip-unchanged across apps) -----------------------------
    def get_manifest(self) -> dict:
        return self.client.get_json(f"/v1/libraries/{urllib.parse.quote(self.library)}/manifest")

    def put_manifest(self, manifest: dict) -> None:
        self.client.request("PUT", f"/v1/libraries/{urllib.parse.quote(self.library)}/manifest",
                            json_body=manifest)

    # --- page images -------------------------------------------------------
    def cache_page(self, rel: str) -> str:
        """Return a local path to a page image, downloading + caching it on first
        use. On a miss (never rendered / 404) returns the would-be path, which
        simply won't exist — callers already guard with os.path.exists()."""
        local = self._pages_dir / rel
        if local.exists():
            return str(local)
        with self._page_lock:
            if local.exists():
                return str(local)
            try:
                data = self.client.request(
                    "GET", f"/v1/libraries/{urllib.parse.quote(self.library)}/pages/"
                    + urllib.parse.quote(rel))
            except RemoteError:
                return str(local)   # miss; path won't exist
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(data)
        return str(local)

    def upload_page(self, rel: str, data: bytes) -> None:
        self.client.request("POST", f"/v1/libraries/{urllib.parse.quote(self.library)}/pages/"
                            + urllib.parse.quote(rel), raw_body=data, content_type="image/png",
                            timeout=120.0)

    # --- original source PDFs (for the highlight overlay) ------------------
    def upload_source(self, name: str, data: bytes) -> None:
        self.client.request("POST", f"/v1/libraries/{urllib.parse.quote(self.library)}/source/"
                            + urllib.parse.quote(name), raw_body=data, content_type="application/pdf",
                            timeout=300.0)

    def cache_source(self, name: str) -> str | None:
        """Return a local path to the original PDF, downloading + caching it on
        first use. None when the server doesn't have it (e.g. ingested before this
        feature, or by a client that didn't upload it) — the caller then skips the
        highlight overlay and keeps the plain page."""
        local = self._sources_dir / name
        if local.exists():
            return str(local)
        with self._page_lock:
            if local.exists():
                return str(local)
            try:
                data = self.client.request(
                    "GET", f"/v1/libraries/{urllib.parse.quote(self.library)}/source/"
                    + urllib.parse.quote(name), timeout=120.0)
            except RemoteError:
                return None
            local.parent.mkdir(parents=True, exist_ok=True)
            local.write_bytes(data)
        return str(local)


def active() -> "RemoteVectorStore | None":
    return _ACTIVE


def cache_page(rel: str) -> str | None:
    """Module-level page resolver used by config.resolve_image() when a remote
    library is active. Returns a local path (possibly not-yet-existing) or None
    when there is no active remote store."""
    return _ACTIVE.cache_page(rel) if _ACTIVE is not None else None


def cache_source(name: str) -> str | None:
    """Module-level source-PDF resolver used by highlight._source_pdf() for a
    remote library. Returns a local path to the cached original PDF, or None."""
    return _ACTIVE.cache_source(name) if _ACTIVE is not None else None
