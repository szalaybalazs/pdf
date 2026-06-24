"""Ingestion: PDF library -> page images + text chunks + embeddings -> local store.

Run:
    python -m pdf_qa.ingest                # index every PDF in PDF_DIR
    python -m pdf_qa.ingest --no-embed     # parse + render only (no API key needed)
    python -m pdf_qa.ingest --files a.pdf  # limit to specific files
"""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

import fitz  # PyMuPDF
from tqdm import tqdm

from . import config, ocr
from .store import Chunk, VectorStore


def looks_like_text(s: str) -> bool:
    """Reject chunks that are mostly control/glyph garbage.

    Some pages (decorative title pages, custom-encoded fonts) extract as raw
    glyph codes rather than Unicode. Embedding that junk only pollutes the index;
    the page image is still kept so the vision model can read such pages.
    """
    if not s.strip():
        return False
    printable = sum(1 for c in s if c.isprintable() or c in " \t\n")
    if printable / len(s) < 0.80:
        return False
    letters = sum(1 for c in s if c.isalnum())
    return letters / len(s) > 0.30


def chunk_page_text(text: str, words: int, overlap: int) -> list[str]:
    """Split a page's text into overlapping ~`words`-sized chunks (garbage dropped)."""
    toks = text.split()
    if not toks:
        return []
    chunks, start = [], 0
    step = max(1, words - overlap)
    while start < len(toks):
        chunk = " ".join(toks[start : start + words])
        if looks_like_text(chunk):
            chunks.append(chunk)
        start += step
    return chunks


def render_page(page: "fitz.Page", out_path: Path, dpi: int, max_pixels: int = 8_000_000) -> None:
    """Render a page to PNG. Caps total pixels so a single huge page can't blow up
    memory (large scanned/photo pages otherwise risk OOM)."""
    rect = page.rect
    pt_w, pt_h = rect.width or 1, rect.height or 1
    scale = dpi / 72.0
    if (pt_w * scale) * (pt_h * scale) > max_pixels:
        scale = (max_pixels / (pt_w * pt_h)) ** 0.5  # shrink to fit the pixel budget
    pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
    out_path.parent.mkdir(parents=True, exist_ok=True)
    pix.save(out_path)
    pix = None  # release the pixmap buffer promptly to keep memory flat


def is_scanned(text: str, page: "fitz.Page") -> bool:
    """Heuristic: little/no extractable text but the page has image XObjects."""
    return len(text.strip()) < 40 and bool(page.get_images())


def page_text(page: "fitz.Page", img_path: Path, use_ocr: bool) -> tuple[str, str]:
    """Return (text, source). Use the embedded text layer when it's real;
    otherwise fall back to OCR of the rendered page image."""
    raw = page.get_text("text") or ""
    if looks_like_text(raw):
        return raw, "pdf"
    if use_ocr and ocr.available():
        ocr_txt = ocr.ocr_image(str(img_path), config.OCR_LANG)
        if looks_like_text(ocr_txt):
            return ocr_txt, "ocr"
    return "", "none"


def ingest_pdf(pdf_path: Path, store: VectorStore, embed: bool, use_ocr: bool = True) -> dict:
    doc = fitz.open(pdf_path)
    safe = pdf_path.stem.replace(" ", "_")
    pending_chunks: list[Chunk] = []
    pending_texts: list[str] = []
    scanned_pages = failed_pages = ocr_pages = 0

    for pno in tqdm(range(len(doc)), desc=pdf_path.name[:30], unit="pg", leave=False):
        page = doc[pno]
        img_path = config.PAGES_DIR / safe / f"p{pno+1:04d}.png"
        try:
            render_page(page, img_path, config.RENDER_DPI)
        except Exception as e:  # never let one bad page abort the whole book
            failed_pages += 1
            tqdm.write(f"  [warn] {pdf_path.name} page {pno+1}: render failed ({e}); skipping image")

        if is_scanned(page.get_text("text") or "", page):
            scanned_pages += 1
        text, source = page_text(page, img_path, use_ocr)
        if source == "ocr":
            ocr_pages += 1

        for ci, ctext in enumerate(chunk_page_text(text, config.CHUNK_WORDS, config.CHUNK_OVERLAP)):
            pending_chunks.append(Chunk(
                id=f"{pdf_path.name}:p{pno+1:04d}:c{ci}",
                doc=pdf_path.name, page=pno + 1, chunk_index=ci,
                text=ctext, image_path=str(img_path),
            ))
            pending_texts.append(ctext)

    if embed and pending_texts:
        from .llm import embed_texts
        vecs = embed_texts(pending_texts)
        store.add(pending_chunks, vecs)
    elif pending_texts:
        # no-embed dry run: keep chunks, store zero vectors as placeholders
        import numpy as np
        store.add(pending_chunks, np.zeros((len(pending_texts), 1), dtype="float32"))

    return {"pages": len(doc), "chunks": len(pending_chunks),
            "scanned_pages": scanned_pages, "failed_pages": failed_pages,
            "ocr_pages": ocr_pages}


def _emit_json(obj: dict) -> None:
    import json
    sys.stdout.write(json.dumps(obj) + "\n")
    sys.stdout.flush()


def _store_exists() -> bool:
    return config.STORE_PATH.with_suffix(".npy").exists()


def ingest_paths(paths, embed: bool = True, use_ocr: bool = True,
                 json_out: bool = False, force: bool = False) -> int:
    """Incrementally add specific PDF paths to the existing index (append, don't rebuild)."""
    store = VectorStore.load(config.STORE_PATH) if _store_exists() else VectorStore(config.STORE_PATH)
    existing = {c.doc for c in store.chunks}
    pdfs = [Path(p) for p in paths]
    if json_out:
        _emit_json({"type": "ingest_start", "total": len(pdfs)})
    added = 0
    for i, p in enumerate(pdfs):
        if not p.exists():
            if json_out:
                _emit_json({"type": "file_skip", "name": p.name, "reason": "not found"})
            continue
        if p.name in existing and not force:
            if json_out:
                _emit_json({"type": "file_skip", "name": p.name, "reason": "already indexed"})
            continue
        if json_out:
            _emit_json({"type": "file_start", "name": p.name, "index": i + 1, "total": len(pdfs)})
        try:
            stats = ingest_pdf(p, store, embed=embed, use_ocr=use_ocr)
            existing.add(p.name)
            added += 1
            if json_out:
                _emit_json({"type": "file_done", "name": p.name, **stats})
        except Exception as e:  # noqa: BLE001
            if json_out:
                _emit_json({"type": "file_error", "name": p.name, "message": str(e)})
    store.save()
    docs = sorted({c.doc for c in store.chunks})
    if json_out:
        _emit_json({"type": "ingest_done", "added": added, "docs": docs})
    else:
        print(f"Added {added} document(s). Index now has {len(docs)} doc(s).")
    return added


def main(argv=None):
    ap = argparse.ArgumentParser(description="Index PDFs for multimodal Q&A.")
    ap.add_argument("--add", nargs="+", metavar="PDF",
                    help="Incrementally add these PDF path(s) to the existing index.")
    ap.add_argument("--json", action="store_true",
                    help="Emit JSON progress lines (used by the desktop app).")
    ap.add_argument("--force", action="store_true",
                    help="Re-index a document even if it is already present.")
    ap.add_argument("--no-embed", action="store_true",
                    help="Parse + render only; skip OpenAI embeddings (no API key needed).")
    ap.add_argument("--files", nargs="*", help="Specific PDF filenames (in PDF_DIR) to index.")
    ap.add_argument("--no-ocr", action="store_true",
                    help="Disable OCR fallback for pages with no usable text layer.")
    args = ap.parse_args(argv)

    # Incremental mode (used by the desktop app's "Add PDF").
    if args.add:
        try:
            ingest_paths(args.add, embed=not args.no_embed, use_ocr=not args.no_ocr,
                         json_out=args.json, force=args.force)
            return 0
        except Exception as e:  # noqa: BLE001
            if args.json:
                _emit_json({"type": "ingest_error", "message": str(e)})
            else:
                print(f"Ingest failed: {e}", file=sys.stderr)
            return 1

    pdfs = sorted(config.PDF_DIR.glob("*.pdf"))
    if args.files:
        wanted = set(args.files)
        pdfs = [p for p in pdfs if p.name in wanted]
    if not pdfs:
        print(f"No PDFs found in {config.PDF_DIR}", file=sys.stderr)
        return 1

    use_ocr = not args.no_ocr
    store = VectorStore(config.STORE_PATH)
    print(f"Indexing {len(pdfs)} PDF(s) from {config.PDF_DIR}")
    print(f"Embeddings: {'OFF (dry run)' if args.no_embed else config.EMBED_MODEL}")
    if use_ocr and not ocr.available():
        print("OCR: requested but Tesseract not found — pages with no text layer "
              "will keep their image but contribute no retrievable text.")
    else:
        print(f"OCR fallback: {'ON' if use_ocr else 'OFF'}")
    print()

    totals = {"pages": 0, "chunks": 0, "scanned_pages": 0, "failed_pages": 0, "ocr_pages": 0}
    for p in pdfs:
        stats = ingest_pdf(p, store, embed=not args.no_embed, use_ocr=use_ocr)
        for k in totals:
            totals[k] += stats[k]
        print(f"  {p.name:50} {stats['pages']:4} pages  "
              f"{stats['chunks']:5} chunks  {stats['ocr_pages']:3} ocr"
              f"  {stats['scanned_pages']:3} scanned  {stats['failed_pages']:3} failed")

    store.save()
    print(f"\nDone. {totals['pages']} pages, {totals['chunks']} chunks, "
          f"{totals['ocr_pages']} OCR'd, {totals['scanned_pages']} scanned, "
          f"{totals['failed_pages']} failed renders.")
    print(f"Index written to {config.INDEX_DIR}")
    if args.no_embed:
        print("NOTE: dry run — vectors are placeholders. Re-run without --no-embed to enable search.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
