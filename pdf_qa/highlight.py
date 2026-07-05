"""Render a page image with the cited text highlighted.

A citation currently opens the plain rendered page; this turns "here is the
page" into "here is the exact line", which is the whole point of grounding — the
reader can see where on the page an answer came from. We reopen the SOURCE PDF
(so text coordinates are exact), search for the cited passage's phrases (falling
back to the query's distinctive terms), add real highlight annotations, and
render an annotated PNG. Best-effort: any failure returns None and the caller
falls back to the plain page image.
"""
from __future__ import annotations

import hashlib
import re
from pathlib import Path

import fitz  # PyMuPDF

from . import config

# Very small stop list — highlighting "the"/"and" everywhere is just noise.
_STOP = {
    "the", "and", "for", "are", "was", "were", "this", "that", "with", "from",
    "into", "your", "you", "which", "when", "what", "where", "how", "why", "who",
    "then", "than", "them", "they", "have", "has", "had", "not", "but", "its",
    "can", "may", "will", "would", "could", "should", "about", "there", "their",
    "these", "those", "such", "also", "each", "some", "any", "all", "one", "two",
}

_WORD_RE = re.compile(r"[A-Za-z0-9][A-Za-z0-9.\-/]*")
_SENT_RE = re.compile(r"(?<=[.!?])\s+")


def _terms(text: str, min_len: int = 4, max_terms: int = 16) -> list[str]:
    """Distinctive-looking tokens from a query/snippet: reasonably long, not stop
    words, de-duplicated, order-preserving. Keeps part-number-ish tokens (with
    digits) even if short, since those are exactly what a reader wants located."""
    out: list[str] = []
    seen: set[str] = set()
    for w in _WORD_RE.findall(text):
        lw = w.lower()
        interesting = len(w) >= min_len or any(ch.isdigit() for ch in w)
        if not interesting or lw in _STOP or lw in seen:
            continue
        seen.add(lw)
        out.append(w)
        if len(out) >= max_terms:
            break
    return out


def _phrases(snippet: str, words: int = 6, max_phrases: int = 8) -> list[str]:
    """Short contiguous phrases from the cited passage, tried first because a
    multi-word hit is far more precise than isolated terms. Kept short (a handful
    of words) so PyMuPDF's exact search_for still matches despite whitespace and
    line-wrap differences between the extracted text and the page."""
    phrases: list[str] = []
    for sent in _SENT_RE.split(snippet.strip()):
        toks = sent.split()
        if len(toks) >= 3:
            phrases.append(" ".join(toks[:words]))
        if len(phrases) >= max_phrases:
            break
    return phrases


def _source_pdf(doc_name: str) -> Path | None:
    p = config.PDF_DIR / doc_name
    if p.exists():
        return p
    # Remote library: the original PDF was uploaded to the server at ingest, so
    # fetch it (cached locally) to render the highlight overlay. None when the
    # server doesn't have it — the caller then keeps the plain page.
    if config.IS_REMOTE:
        from .remote_store import cache_source
        local = cache_source(doc_name)
        if local and Path(local).exists():
            return Path(local)
    return None


def annotate_page(doc_name: str, page_no: int, query: str = "", snippet: str = "") -> str | None:
    """Produce a highlighted PNG of `doc_name` page `page_no` (1-based) with the
    cited passage / query terms boxed. Returns the image path, or None if the
    source PDF is unavailable, the page is out of range, or nothing was found to
    highlight (so the caller keeps showing the plain page)."""
    src = _source_pdf(doc_name)
    if src is None:
        return None
    try:
        with fitz.open(src) as d:
            if not (1 <= page_no <= len(d)):
                return None
            page = d[page_no - 1]
            rects: list = []
            for phrase in _phrases(snippet):
                try:
                    rects += list(page.search_for(phrase) or [])
                except Exception:
                    pass
            if not rects:   # no phrase matched — fall back to distinctive terms
                for term in _terms(f"{snippet} {query}"):
                    try:
                        rects += list(page.search_for(term) or [])
                    except Exception:
                        pass
            if not rects:
                return None
            for r in rects[:300]:
                try:
                    page.add_highlight_annot(r)
                except Exception:
                    pass
            out_dir = config.INDEX_DIR / "highlights"
            out_dir.mkdir(parents=True, exist_ok=True)
            key = hashlib.md5(f"{doc_name}|{page_no}|{query}|{snippet}".encode()).hexdigest()[:10]
            out = out_dir / f"{Path(doc_name).stem.replace(' ', '_')}_p{page_no:04d}_{key}.png"
            scale = config.RENDER_DPI / 72.0
            pix = page.get_pixmap(matrix=fitz.Matrix(scale, scale))
            pix.save(out)
            return str(out)
    except Exception:
        return None
