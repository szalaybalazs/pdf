"""Open the active library's store — local on-disk or remote — behind one call.

serve.py and ingest.py use this instead of `VectorStore.load(config.STORE_PATH)`
so the local vs remote choice lives in exactly one place. The returned object is
a `VectorStore` (or `RemoteVectorStore`, which duck-types it), so every caller
downstream is unchanged.
"""
from __future__ import annotations

from . import config
from .store import VectorStore


def open_store() -> VectorStore | None:
    """The active library's store, or None when there's no local index yet.

    Remote libraries always return a (possibly empty) store — the server owns the
    data, so "not built yet" just means zero chunks, not a missing file."""
    if config.IS_REMOTE:
        from .remote_store import RemoteVectorStore
        return RemoteVectorStore.connect(
            config.REMOTE_URL, config.REMOTE_SECRET, config.REMOTE_LIBRARY,
            config.REMOTE_CACHE_DIR)
    try:
        return VectorStore.load(config.STORE_PATH)
    except FileNotFoundError:
        return None
