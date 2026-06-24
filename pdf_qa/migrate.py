"""One-time migration: move a legacy ./index into the configured INDEX_DIR and
convert stored page-image paths from absolute to PAGES_DIR-relative.

Run once after upgrading to the userData data dir:

    python -m pdf_qa.migrate

Idempotent: if the destination store already exists it does nothing. If no
legacy index is found there is nothing to do either. Re-running `ingest` instead
also rebuilds the index in the new location.
"""
from __future__ import annotations

import json
import os
import shutil
from pathlib import Path

from . import config


def _legacy_index_dir() -> Path:
    # the old default: <project>/index
    return Path(__file__).resolve().parent.parent / "index"


def migrate() -> int:
    dest = config.INDEX_DIR
    legacy = _legacy_index_dir()

    if config.STORE_PATH.with_suffix(".jsonl").exists():
        print(f"Index already present at {dest}; nothing to migrate.")
        return 0
    if not (legacy / "store.jsonl").exists():
        print(f"No legacy index found at {legacy}; nothing to migrate. "
              f"Run `python -m pdf_qa.ingest` to build one at {dest}.")
        return 0
    if legacy.resolve() == dest.resolve():
        print("Legacy and destination index are the same directory; nothing to do.")
        return 0

    print(f"Copying {legacy}  ->  {dest}")
    dest.mkdir(parents=True, exist_ok=True)
    # copy page images
    if (legacy / "pages").exists():
        shutil.copytree(legacy / "pages", dest / "pages", dirs_exist_ok=True)
    # copy the embedding matrix verbatim
    if (legacy / "store.npy").exists():
        shutil.copy2(legacy / "store.npy", dest / "store.npy")

    # rewrite jsonl image_path entries to be relative to PAGES_DIR
    rewritten = 0
    out_lines: list[str] = []
    pages_dir = str((legacy / "pages")) + os.sep
    with open(legacy / "store.jsonl", encoding="utf-8") as f:
        for line in f:
            rec = json.loads(line)
            p = rec.get("image_path", "")
            if os.path.isabs(p):
                # strip the legacy PAGES_DIR prefix if present, else just basename dir
                rel = p[len(pages_dir):] if p.startswith(pages_dir) else os.path.basename(p)
                rec["image_path"] = rel.replace(os.sep, "/")
                rewritten += 1
            out_lines.append(json.dumps(rec, ensure_ascii=False))
    with open(config.STORE_PATH.with_suffix(".jsonl"), "w", encoding="utf-8") as f:
        f.write("\n".join(out_lines) + "\n")

    print(f"Migrated index to {dest} ({rewritten} image paths converted to relative).")
    return 0


if __name__ == "__main__":
    raise SystemExit(migrate())
