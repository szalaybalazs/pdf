"""Collections: independent PDF libraries you switch between.

Each collection is a directory with its own index (pages + vectors + manifest).
The "default" collection is the historical top-level index under DATA_DIR; named
collections live under DATA_DIR/collections/<name>/. This module only manages the
directories and reports what's in them — the ACTIVE collection is chosen per
backend process via the PDF_QA_COLLECTION env (the desktop app respawns the
backend to switch), so a running process always serves exactly one collection.
"""
from __future__ import annotations

import json
import re
import shutil
from pathlib import Path

from . import config

_NAME_RE = re.compile(r"[^A-Za-z0-9 _-]")


def sanitize_name(name: str) -> str:
    """A safe collection directory name (no path traversal, trimmed)."""
    return _NAME_RE.sub("", (name or "").strip()).strip()[:64]


def _index_dir_for(name: str) -> Path:
    if name.lower() == "default":
        return config.DATA_DIR / "index"
    return config.COLLECTIONS_DIR / name / "index"


def _doc_count(index_dir: Path) -> int:
    """Distinct document count for an index, read cheaply from its manifest (falls
    back to the store metadata). 0 when the collection has never been indexed."""
    manifest = index_dir / "manifest.json"
    try:
        data = json.loads(manifest.read_text(encoding="utf-8"))
        return len([k for k in data if not k.startswith("_")])
    except Exception:
        pass
    jsonl = index_dir / "store.jsonl"
    try:
        docs = set()
        with open(jsonl, encoding="utf-8") as f:
            for line in f:
                try:
                    docs.add(json.loads(line).get("doc"))
                except Exception:
                    continue
        docs.discard(None)
        return len(docs)
    except Exception:
        return 0


def list_collections() -> list[dict]:
    """All known collections: always "default", plus any directory under
    COLLECTIONS_DIR. Each entry carries its doc count and whether it's active."""
    names = ["default"]
    if config.COLLECTIONS_DIR.exists():
        for child in sorted(config.COLLECTIONS_DIR.iterdir()):
            if child.is_dir() and child.name != "default":
                names.append(child.name)
    active = config.ACTIVE_COLLECTION
    return [{"name": n, "docs": _doc_count(_index_dir_for(n)), "active": n == active}
            for n in names]


def create_collection(name: str) -> dict:
    """Create an (empty) named collection directory. Returns {ok, name?, error?}."""
    clean = sanitize_name(name)
    if not clean or clean.lower() == "default":
        return {"ok": False, "error": "invalid collection name"}
    target = config.COLLECTIONS_DIR / clean
    if target.exists():
        return {"ok": False, "error": "collection already exists"}
    (target / "index").mkdir(parents=True, exist_ok=True)
    return {"ok": True, "name": clean}


def delete_collection(name: str) -> dict:
    """Delete a named collection and its index. "default" and the active
    collection are protected."""
    clean = sanitize_name(name)
    if clean.lower() == "default":
        return {"ok": False, "error": "cannot delete the default collection"}
    if clean == config.ACTIVE_COLLECTION:
        return {"ok": False, "error": "cannot delete the active collection"}
    target = config.COLLECTIONS_DIR / clean
    if not target.exists():
        return {"ok": False, "error": "no such collection"}
    shutil.rmtree(target, ignore_errors=True)
    return {"ok": True, "name": clean}
