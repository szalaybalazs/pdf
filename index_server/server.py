"""Remote index server: a shared, network-accessible home for one or more
libraries (collections), so several desktop apps can query and grow the SAME
index instead of each keeping a private copy on local disk.

It wraps the exact same `pdf_qa.store.VectorStore` the app uses locally, keeps
each library loaded in memory (loaded once, then served from RAM), and exposes a
small HTTP API mirroring the store's interface:

    GET    /health                          -> liveness, no auth
    GET    /v1/libraries                     -> list {name, docs, chunks}
    POST   /v1/libraries/{lib}               -> create an empty library
    DELETE /v1/libraries/{lib}               -> delete a library
    GET    /v1/libraries/{lib}/info          -> {docs, chunks, embedder}
    GET    /v1/libraries/{lib}/chunks        -> all chunk metadata (client cache)
    POST   /v1/libraries/{lib}/search        -> dense cosine, body {vector,top_k,docs?}
    POST   /v1/libraries/{lib}/add           -> append {chunks, vectors, embedder?}
    POST   /v1/libraries/{lib}/remove_doc    -> {doc} -> {removed}
    GET    /v1/libraries/{lib}/manifest      -> content-hash manifest (skip-unchanged)
    PUT    /v1/libraries/{lib}/manifest      -> replace the manifest
    GET    /v1/libraries/{lib}/pages/{path}  -> a rendered page PNG
    POST   /v1/libraries/{lib}/pages/{path}  -> upload a rendered page PNG

Performance notes:
  * Embedding vectors live ONLY here — clients download compact chunk metadata
    (text + ids), never the matrix — so N apps don't each hold the full .npy in
    RAM, and dense search is a single vector round-trip resolved by an in-memory
    matmul on already-normalized vectors.
  * Each library is cached in memory and guarded by its own RW-ish lock: reads
    (search/info/chunks) run concurrently; writes (add/remove) are serialized so
    two apps ingesting at once can't clobber the store.

Auth: a single shared secret via `INDEX_SERVER_SECRET`. Clients send it as
`Authorization: Bearer <secret>`. If the secret is EMPTY (unset), the server is
open — any request is allowed. `/health` never requires auth.
"""
from __future__ import annotations

import base64
import json
import os
import threading
from pathlib import Path

import numpy as np
from fastapi import FastAPI, HTTPException, Request, Response
from fastapi.responses import JSONResponse

from pdf_qa.store import Chunk, VectorStore

# --- configuration -----------------------------------------------------------
# Root under which every library's index lives: DATA_DIR/<lib>/index/store.*
DATA_DIR = Path(os.getenv("INDEX_SERVER_DATA_DIR", "/data")).resolve()
# Shared secret. Empty => open server (any access allowed), per the app's
# "leaving it empty should allow any access" contract.
SECRET = os.getenv("INDEX_SERVER_SECRET", "").strip()
# Every server always has at least this library; it can't be deleted, and an app
# that connects without naming a library lands here.
DEFAULT_LIBRARY = "default"

_NAME_OK = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789 _-")

app = FastAPI(title="pdf-qa index server", version="1")


@app.on_event("startup")
def _startup() -> None:
    _ensure_default_library()


# --- library cache -----------------------------------------------------------
class _Library:
    """A VectorStore plus the lock that serializes writes to it. Loaded lazily
    and then kept in memory for the process lifetime."""

    def __init__(self, name: str):
        self.name = name
        self.lock = threading.Lock()
        prefix = _index_dir(name) / "store"
        prefix.parent.mkdir(parents=True, exist_ok=True)
        if prefix.with_suffix(".npy").exists():
            self.store = VectorStore.load(prefix)
        else:
            self.store = VectorStore(prefix)


_libs: dict[str, _Library] = {}
_libs_lock = threading.Lock()


def _index_dir(name: str) -> Path:
    return DATA_DIR / name / "index"


def _sanitize(name: str) -> str:
    name = (name or "").strip()
    if not name or any(c not in _NAME_OK for c in name) or ".." in name:
        raise HTTPException(status_code=400, detail="invalid library name")
    return name[:64]


def _get_library(name: str, create: bool = False) -> _Library:
    name = _sanitize(name)
    with _libs_lock:
        lib = _libs.get(name)
        if lib is not None:
            return lib
        if not create and not _index_dir(name).exists():
            raise HTTPException(status_code=404, detail=f"no such library: {name}")
        lib = _libs[name] = _Library(name)
        return lib


def _list_library_names() -> list[str]:
    names = set()
    if DATA_DIR.exists():
        names = {d.name for d in DATA_DIR.iterdir() if d.is_dir()}
    names.add(DEFAULT_LIBRARY)   # always present, even before anything is indexed
    return sorted(names)


def _ensure_default_library() -> None:
    """Guarantee the 'default' library exists on disk + in the in-memory cache.
    Called at startup so a fresh server is immediately usable."""
    try:
        _get_library(DEFAULT_LIBRARY, create=True)
    except Exception:
        pass   # best-effort; list/create paths also materialize it on demand


# --- auth --------------------------------------------------------------------
@app.middleware("http")
async def _auth(request: Request, call_next):
    # Liveness is always open so a load balancer / the app's "test connection"
    # button can probe without a secret.
    if SECRET and request.url.path != "/health":
        header = request.headers.get("authorization", "")
        token = header[7:].strip() if header.lower().startswith("bearer ") else ""
        if not token:
            token = request.headers.get("x-index-secret", "").strip()
        if token != SECRET:
            return JSONResponse({"detail": "unauthorized"}, status_code=401)
    return await call_next(request)


# --- binary vector codec -----------------------------------------------------
# Vectors travel as base64 of raw little-endian float32 bytes + an explicit
# shape, which is ~4x smaller than JSON numbers and lossless.
def _decode_matrix(b64: str, dim: int, rows: int) -> np.ndarray:
    raw = base64.b64decode(b64)
    mat = np.frombuffer(raw, dtype="<f4").astype(np.float32)
    if rows * dim and mat.size != rows * dim:
        raise HTTPException(status_code=400, detail="vector byte length mismatch")
    return mat.reshape(rows, dim) if rows else mat.reshape(1, -1)


# --- routes ------------------------------------------------------------------
@app.get("/health")
def health() -> dict:
    return {"ok": True, "libraries": len(_list_library_names()), "auth": bool(SECRET)}


@app.get("/v1/libraries")
def list_libraries() -> dict:
    out = []
    for name in _list_library_names():
        try:
            store = _get_library(name).store
            out.append({"name": name, "docs": len(sorted({c.doc for c in store.chunks})),
                        "chunks": len(store)})
        except Exception:
            out.append({"name": name, "docs": 0, "chunks": 0})
    return {"libraries": out}


@app.post("/v1/libraries/{lib}")
def create_library(lib: str) -> dict:
    name = _sanitize(lib)
    _get_library(name, create=True)
    return {"ok": True, "name": name}


@app.delete("/v1/libraries/{lib}")
def delete_library(lib: str) -> dict:
    import shutil
    name = _sanitize(lib)
    if name == DEFAULT_LIBRARY:
        raise HTTPException(status_code=400, detail="the default library cannot be deleted")
    with _libs_lock:
        _libs.pop(name, None)
    shutil.rmtree(DATA_DIR / name, ignore_errors=True)
    return {"ok": True, "name": name}


@app.get("/v1/libraries/{lib}/info")
def library_info(lib: str) -> dict:
    store = _get_library(lib).store
    return {"docs": sorted({c.doc for c in store.chunks}), "chunks": len(store),
            "embedder": _read_embedder(lib)}


@app.get("/v1/libraries/{lib}/chunks")
def library_chunks(lib: str) -> dict:
    """All chunk metadata (no vectors). The client caches this so BM25, page-label
    maps and the pager run locally; only dense search round-trips."""
    from dataclasses import asdict
    store = _get_library(lib).store
    return {"chunks": [asdict(c) for c in store.chunks], "embedder": _read_embedder(lib)}


@app.post("/v1/libraries/{lib}/search")
async def search(lib: str, request: Request) -> dict:
    body = await request.json()
    dim = int(body.get("dim") or 0)
    qvec = _decode_matrix(body["vector"], dim, 1)[0]
    top_k = int(body.get("top_k") or 8)
    docs = body.get("docs")
    store = _get_library(lib).store
    hits = store.search(qvec, top_k, docs=docs if isinstance(docs, list) else None)
    return {"hits": [{"id": c.id, "score": s} for c, s in hits]}


@app.post("/v1/libraries/{lib}/add")
async def add(lib: str, request: Request) -> dict:
    body = await request.json()
    raw_chunks = body.get("chunks") or []
    dim = int(body.get("dim") or 0)
    rows = len(raw_chunks)
    vectors = _decode_matrix(body["vectors"], dim, rows) if rows else np.empty((0, dim))
    chunks = [Chunk(**c) for c in raw_chunks]
    lib_obj = _get_library(lib, create=True)
    with lib_obj.lock:
        lib_obj.store.add(chunks, vectors)
        lib_obj.store.save()
    if body.get("embedder"):
        _write_embedder(lib, str(body["embedder"]))
    return {"ok": True, "added": len(chunks), "chunks": len(lib_obj.store)}


@app.post("/v1/libraries/{lib}/remove_doc")
async def remove_doc(lib: str, request: Request) -> dict:
    body = await request.json()
    doc = str(body.get("doc") or "")
    lib_obj = _get_library(lib)
    with lib_obj.lock:
        removed = lib_obj.store.remove_doc(doc)
        lib_obj.store.save()
    # Drop the document's rendered page images and stored source PDF too.
    import shutil
    safe = os.path.splitext(doc)[0].replace(" ", "_")
    shutil.rmtree(_index_dir(lib_obj.name) / "pages" / safe, ignore_errors=True)
    try:
        (_index_dir(lib_obj.name) / "sources" / doc).unlink(missing_ok=True)
    except Exception:
        pass
    return {"ok": True, "removed": removed}


@app.get("/v1/libraries/{lib}/manifest")
def get_manifest(lib: str) -> dict:
    name = _sanitize(lib)
    try:
        return json.loads((_index_dir(name) / "manifest.json").read_text("utf-8"))
    except Exception:
        return {}


@app.put("/v1/libraries/{lib}/manifest")
async def put_manifest(lib: str, request: Request) -> dict:
    name = _sanitize(lib)
    body = await request.json()
    path = _index_dir(name) / "manifest.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps(body, ensure_ascii=False), "utf-8")
    return {"ok": True}


@app.get("/v1/libraries/{lib}/pages/{path:path}")
def get_page(lib: str, path: str) -> Response:
    name = _sanitize(lib)
    img = (_index_dir(name) / "pages" / path).resolve()
    base = (_index_dir(name) / "pages").resolve()
    if not str(img).startswith(str(base)) or not img.exists():
        raise HTTPException(status_code=404, detail="no such page")
    return Response(content=img.read_bytes(), media_type="image/png")


@app.post("/v1/libraries/{lib}/pages/{path:path}")
async def put_page(lib: str, path: str, request: Request) -> dict:
    name = _sanitize(lib)
    img = (_index_dir(name) / "pages" / path).resolve()
    base = (_index_dir(name) / "pages").resolve()
    if not str(img).startswith(str(base)) or ".." in path:
        raise HTTPException(status_code=400, detail="invalid page path")
    img.parent.mkdir(parents=True, exist_ok=True)
    img.write_bytes(await request.body())
    return {"ok": True}


# --- original source PDFs ----------------------------------------------------
# The original PDF is stored so any connected app can render the cited-passage
# HIGHLIGHT overlay (which re-opens the source file), not just the plain page.
def _source_path(lib: str, name: str) -> Path:
    base = (_index_dir(_sanitize(lib)) / "sources").resolve()
    p = (base / name).resolve()
    if not str(p).startswith(str(base)) or "/" in name or ".." in name:
        raise HTTPException(status_code=400, detail="invalid source name")
    return p


@app.get("/v1/libraries/{lib}/source/{name}")
def get_source(lib: str, name: str) -> Response:
    p = _source_path(lib, name)
    if not p.exists():
        raise HTTPException(status_code=404, detail="no such source")
    return Response(content=p.read_bytes(), media_type="application/pdf")


@app.post("/v1/libraries/{lib}/source/{name}")
async def put_source(lib: str, name: str, request: Request) -> dict:
    p = _source_path(lib, name)
    p.parent.mkdir(parents=True, exist_ok=True)
    p.write_bytes(await request.body())
    return {"ok": True}


# --- embedder identity -------------------------------------------------------
def _read_embedder(lib: str) -> str:
    try:
        return json.loads((_index_dir(_sanitize(lib)) / "embedder.json").read_text("utf-8")).get("embedder", "")
    except Exception:
        return ""


def _write_embedder(lib: str, embedder: str) -> None:
    path = _index_dir(_sanitize(lib)) / "embedder.json"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(json.dumps({"embedder": embedder}), "utf-8")


if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=int(os.getenv("PORT", "8000")))
