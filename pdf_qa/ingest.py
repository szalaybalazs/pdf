"""Ingestion: PDF library -> page images + text chunks + embeddings -> local store.

Run:
    python -m pdf_qa.ingest                # index every PDF in PDF_DIR
    python -m pdf_qa.ingest --no-embed     # parse + render only (no API key needed)
    python -m pdf_qa.ingest --files a.pdf  # limit to specific files
"""
from __future__ import annotations

import argparse
import re
import sys
import threading
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

import fitz  # PyMuPDF
from tqdm import tqdm

from . import config, ocr
from .errors import capture_exception, init_error_reporting
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


_SENT_SPLIT = re.compile(r'(?<=[.!?])\s+(?=[A-Z0-9"\'(])')


def _sentences(text: str) -> list[str]:
    """Lightweight sentence segmentation: split on sentence-final punctuation
    followed by whitespace and an opening/capital token. Good enough for prose
    and avoids an NLTK dependency; garbage with no punctuation stays one blob
    (and gets dropped downstream by looks_like_text)."""
    return [p.strip() for p in _SENT_SPLIT.split(text.strip()) if p.strip()]


def chunk_page_text(text: str, words: int, overlap: int) -> list[str]:
    """Pack whole sentences into ~`words`-sized chunks, carrying ~`overlap` words
    of trailing sentences into the next chunk so context isn't split mid-sentence.
    Garbage (non-text) chunks are dropped."""
    sents = _sentences(text)
    if not sents:
        return []
    chunks: list[str] = []
    cur: list[str] = []
    cur_words = 0
    for sent in sents:
        wc = len(sent.split())
        # Flush before overflowing the target — but a lone oversized sentence is
        # still emitted rather than dropped.
        if cur and cur_words + wc > words:
            chunk = " ".join(cur)
            if looks_like_text(chunk):
                chunks.append(chunk)
            # Seed the next chunk with a tail of sentences worth ~overlap words.
            tail: list[str] = []
            tail_words = 0
            for s in reversed(cur):
                sw = len(s.split())
                if tail and tail_words + sw > overlap:
                    break
                tail.insert(0, s)
                tail_words += sw
            cur, cur_words = tail, tail_words
        cur.append(sent)
        cur_words += wc
    if cur:
        chunk = " ".join(cur)
        if looks_like_text(chunk):
            chunks.append(chunk)
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


def extract_table_chunks(page: "fitz.Page", pdf_path: Path, pno: int,
                         rel_img: str, start_index: int) -> list[Chunk]:
    """Reconstruct tables on a page into markdown chunks. Each table becomes one
    chunk (text = a '[Table p.N]' marker + the markdown grid), so the numbers in
    a table are searchable as cells rather than lost in the prose reading order.
    Best-effort: any failure yields no table chunks and never aborts the page."""
    if not config.EXTRACT_TABLES:
        return []
    try:
        finder = page.find_tables()
        tables = list(getattr(finder, "tables", []) or [])
    except Exception:
        return []
    out: list[Chunk] = []
    for ti, tab in enumerate(tables):
        try:
            md = (tab.to_markdown() or "").strip()
        except Exception:
            continue
        # A degenerate "table" (one row, or no cell pipes) is usually a false
        # positive from ruled text — skip it rather than pollute the index.
        if not md or md.count("\n") < 1 or md.count("|") < 4:
            continue
        text = f"[Table on p.{pno + 1}]\n{md}"[:config.TABLE_CHARS_MAX]
        out.append(Chunk(id=f"{pdf_path.name}:p{pno + 1:04d}:t{ti}",
                         doc=pdf_path.name, page=pno + 1, chunk_index=start_index + ti,
                         text=text, image_path=rel_img, kind="table"))
    return out


def _process_page(pdf_path: Path, safe: str, pno: int, use_ocr: bool,
                  doc_for) -> tuple[int, list[Chunk], int, int, int]:
    """Render + extract one page. Returns (pno, chunks, scanned, ocr_used, failed).

    Runs on a worker thread; `doc_for()` hands back this thread's own fitz handle
    (PyMuPDF handles must never be shared across threads, but a per-thread handle
    renders concurrently — MuPDF releases the GIL during rasterisation)."""
    doc = doc_for()
    page = doc[pno]
    rel_img = f"{safe}/p{pno+1:04d}.png"          # stored path, relative to PAGES_DIR
    img_path = config.PAGES_DIR / rel_img          # absolute path for rendering
    failed = 0
    try:
        render_page(page, img_path, config.RENDER_DPI)
    except Exception as e:  # never let one bad page abort the whole book
        failed = 1
        tqdm.write(f"  [warn] {pdf_path.name} page {pno+1}: render failed ({e}); skipping image")

    scanned = 1 if is_scanned(page.get_text("text") or "", page) else 0
    text, source = page_text(page, img_path, use_ocr)
    ocr_used = 1 if source == "ocr" else 0

    chunks = [
        Chunk(id=f"{pdf_path.name}:p{pno+1:04d}:c{ci}",
              doc=pdf_path.name, page=pno + 1, chunk_index=ci,
              text=ctext, image_path=rel_img)
        for ci, ctext in enumerate(chunk_page_text(text, config.CHUNK_WORDS, config.CHUNK_OVERLAP))
    ]
    # Tables are extracted separately and appended as their own chunks, numbered
    # after the prose chunks so chunk_index stays unique within the page.
    chunks += extract_table_chunks(page, pdf_path, pno, rel_img, len(chunks))
    return pno, chunks, scanned, ocr_used, failed


def ingest_pdf(pdf_path: Path, store: VectorStore, embed: bool, use_ocr: bool = True,
               progress=None, workers: int | None = None, store_lock=None) -> dict:
    """`progress`, if given, is called as progress(phase, done, total) where phase
    is "pages" (per rendered/extracted page) or "embed" (vectors being computed).

    Pages are rendered/extracted/OCR'd across `workers` threads (default
    config.INGEST_WORKERS); embedding and store writes happen once, afterwards, on
    the calling thread. `store_lock`, if given, serializes the store.add() call so
    several documents can be ingested into the same store concurrently."""
    workers = config.INGEST_WORKERS if workers is None else max(1, workers)
    safe = pdf_path.stem.replace(" ", "_")
    with fitz.open(pdf_path) as probe:
        n_pages = len(probe)

    # Prime OCR availability once, single-threaded: ocr.available() memoises into
    # module globals with a non-atomic check, so let it settle before fan-out.
    if use_ocr:
        ocr.available()

    # One fitz handle per worker thread, opened lazily and closed at the end.
    tl = threading.local()
    opened: list = []
    opened_lock = threading.Lock()

    def _doc_for():
        d = getattr(tl, "doc", None)
        if d is None:
            d = tl.doc = fitz.open(pdf_path)
            with opened_lock:
                opened.append(d)
        return d

    results: dict[int, list[Chunk]] = {}
    scanned_pages = failed_pages = ocr_pages = 0
    bar = tqdm(total=n_pages, desc=pdf_path.name[:30], unit="pg", leave=False)
    try:
        with ThreadPoolExecutor(max_workers=workers) as ex:
            futures = [ex.submit(_process_page, pdf_path, safe, pno, use_ocr, _doc_for)
                       for pno in range(n_pages)]
            done = 0
            for fut in as_completed(futures):
                pno, chunks, scanned, ocr_used, failed = fut.result()
                results[pno] = chunks
                scanned_pages += scanned
                ocr_pages += ocr_used
                failed_pages += failed
                done += 1
                bar.update(1)
                if progress:
                    progress("pages", done, n_pages)
    finally:
        bar.close()
        with opened_lock:
            for d in opened:
                try:
                    d.close()
                except Exception:
                    pass

    # Flatten in page order so the index reads naturally (search is order-agnostic,
    # but a deterministic layout keeps diffs/debugging sane).
    pending_chunks: list[Chunk] = [c for pno in range(n_pages) for c in results.get(pno, [])]
    pending_texts: list[str] = [c.text for c in pending_chunks]

    def _add(chunks, vecs):
        if store_lock is not None:
            with store_lock:
                store.add(chunks, vecs)
        else:
            store.add(chunks, vecs)

    if embed and pending_texts:
        from .llm import embed_texts
        if progress:
            progress("embed", 0, 1)
        vecs = embed_texts(pending_texts)
        _add(pending_chunks, vecs)
    elif pending_texts:
        # no-embed dry run: keep chunks, store zero vectors as placeholders
        import numpy as np
        _add(pending_chunks, np.zeros((len(pending_texts), 1), dtype="float32"))

    return {"pages": n_pages, "chunks": len(pending_chunks),
            "table_chunks": sum(1 for c in pending_chunks if c.kind == "table"),
            "scanned_pages": scanned_pages, "failed_pages": failed_pages,
            "ocr_pages": ocr_pages}


_emit_lock = threading.Lock()


def _emit_json(obj: dict) -> None:
    import json
    line = json.dumps(obj) + "\n"
    # Documents ingest concurrently, so serialize whole lines or their JSON
    # interleaves on stdout and the desktop app can't parse the stream.
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _store_exists() -> bool:
    return config.STORE_PATH.with_suffix(".npy").exists()


def ingest_paths(paths, embed: bool = True, use_ocr: bool = True,
                 json_out: bool = False, force: bool = False,
                 workers: int | None = None, doc_workers: int | None = None) -> int:
    """Incrementally add specific PDF paths to the existing index (append, don't rebuild).

    Several documents are ingested concurrently (up to `doc_workers`, default
    config.INGEST_DOC_WORKERS); the per-page worker budget is split across the
    documents in flight so total threads stay bounded. Each document streams its
    own file_start/file_progress/file_done events, so the desktop UI can show
    them progressing side by side."""
    store = VectorStore.load(config.STORE_PATH) if _store_exists() else VectorStore(config.STORE_PATH)
    existing = {c.doc for c in store.chunks}
    pdfs = [Path(p) for p in paths]
    if json_out:
        _emit_json({"type": "ingest_start", "total": len(pdfs)})

    # Filter to the documents we'll actually process, single-threaded, so skips
    # are reported deterministically and the same name can't slip through twice.
    todo: list[tuple[int, Path]] = []
    queued: set[str] = set()
    for i, p in enumerate(pdfs):
        if not p.exists():
            if json_out:
                _emit_json({"type": "file_skip", "name": p.name, "reason": "not found"})
            continue
        if (p.name in existing or p.name in queued) and not force:
            if json_out:
                _emit_json({"type": "file_skip", "name": p.name, "reason": "already indexed"})
            continue
        queued.add(p.name)
        todo.append((i, p))

    page_budget = config.INGEST_WORKERS if workers is None else max(1, workers)
    dw = config.INGEST_DOC_WORKERS if doc_workers is None else max(1, doc_workers)
    concurrency = max(1, min(dw, len(todo)))
    per_doc_workers = max(1, page_budget // concurrency)

    store_lock = threading.Lock()
    counters_lock = threading.Lock()
    added = 0

    def _do_one(i: int, p: Path) -> None:
        nonlocal added
        if json_out:
            _emit_json({"type": "file_start", "name": p.name, "index": i + 1, "total": len(pdfs)})
        # Per-page progress -> percentage, throttled so we don't flood stdout.
        # Pages cover 0–90% of the bar; the embedding pass takes it to 95%, file_done = 100%.
        last_pct = [-1]
        def _progress(phase, done, total):
            if not json_out:
                return
            pct = 95 if phase == "embed" else (int(done / total * 90) if total else 90)
            if pct == last_pct[0]:
                return
            last_pct[0] = pct
            _emit_json({"type": "file_progress", "name": p.name,
                        "index": i + 1, "total": len(pdfs),
                        "page": done, "pages": total, "phase": phase, "percent": pct})
        try:
            stats = ingest_pdf(p, store, embed=embed, use_ocr=use_ocr,
                               progress=_progress, workers=per_doc_workers,
                               store_lock=store_lock)
            with counters_lock:
                added += 1
            if json_out:
                _emit_json({"type": "file_done", "name": p.name, **stats})
        except Exception as e:  # noqa: BLE001
            capture_exception(e)
            if json_out:
                _emit_json({"type": "file_error", "name": p.name, "message": str(e)})

    if concurrency <= 1:
        for i, p in todo:
            _do_one(i, p)
    else:
        with ThreadPoolExecutor(max_workers=concurrency) as ex:
            # Drain results so any unexpected error inside a worker surfaces here.
            list(ex.map(lambda ip: _do_one(*ip), todo))

    store.save()
    docs = sorted({c.doc for c in store.chunks})
    if json_out:
        _emit_json({"type": "ingest_done", "added": added, "docs": docs})
    else:
        print(f"Added {added} document(s). Index now has {len(docs)} doc(s).")
    return added


def main(argv=None):
    # Idempotent; covers the dev path where the app runs `python -m pdf_qa.ingest`.
    init_error_reporting()

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
    ap.add_argument("--workers", type=int, default=None, metavar="N",
                    help=f"Page-processing worker threads (default {config.INGEST_WORKERS}; "
                         "set 1 for fully sequential ingest).")
    ap.add_argument("--doc-workers", type=int, default=None, metavar="N",
                    help=f"Documents to ingest concurrently (default {config.INGEST_DOC_WORKERS}); "
                         "the --workers page budget is split across them.")
    args = ap.parse_args(argv)

    # Incremental mode (used by the desktop app's "Add PDF").
    if args.add:
        try:
            ingest_paths(args.add, embed=not args.no_embed, use_ocr=not args.no_ocr,
                         json_out=args.json, force=args.force, workers=args.workers,
                         doc_workers=args.doc_workers)
            return 0
        except Exception as e:  # noqa: BLE001
            capture_exception(e)
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
    workers = config.INGEST_WORKERS if args.workers is None else max(1, args.workers)
    store = VectorStore(config.STORE_PATH)
    print(f"Indexing {len(pdfs)} PDF(s) from {config.PDF_DIR}")
    print(f"Embeddings: {'OFF (dry run)' if args.no_embed else config.EMBED_MODEL}")
    print(f"Workers: {workers} thread(s) per document")
    if use_ocr and not ocr.available():
        print("OCR: requested but Tesseract not found — pages with no text layer "
              "will keep their image but contribute no retrievable text.")
    else:
        print(f"OCR fallback: {'ON' if use_ocr else 'OFF'}")
    print()

    totals = {"pages": 0, "chunks": 0, "table_chunks": 0, "scanned_pages": 0,
              "failed_pages": 0, "ocr_pages": 0}
    for p in pdfs:
        stats = ingest_pdf(p, store, embed=not args.no_embed, use_ocr=use_ocr, workers=workers)
        for k in totals:
            totals[k] += stats[k]
        print(f"  {p.name:50} {stats['pages']:4} pages  "
              f"{stats['chunks']:5} chunks  {stats['table_chunks']:3} tables"
              f"  {stats['ocr_pages']:3} ocr"
              f"  {stats['scanned_pages']:3} scanned  {stats['failed_pages']:3} failed")

    store.save()
    print(f"\nDone. {totals['pages']} pages, {totals['chunks']} chunks "
          f"({totals['table_chunks']} tables), "
          f"{totals['ocr_pages']} OCR'd, {totals['scanned_pages']} scanned, "
          f"{totals['failed_pages']} failed renders.")
    print(f"Index written to {config.INDEX_DIR}")
    if args.no_embed:
        print("NOTE: dry run — vectors are placeholders. Re-run without --no-embed to enable search.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
