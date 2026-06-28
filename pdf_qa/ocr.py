"""OCR fallback for pages whose embedded text layer is missing or garbage.

Many PDFs (e.g. the Morgan Jones book in this corpus) embed fonts with no
ToUnicode map, so PyMuPDF returns raw glyph codes instead of readable text.
For those pages we OCR the rendered page image instead, which is the only way
to get text that's usable for retrieval.

Tesseract is resolved in this order (first hit wins):

  1. ``$PDF_QA_TESSERACT`` — explicit path to the tesseract binary (dev/override).
  2. a copy bundled next to the frozen backend, staged at ``<backend>/tesseract/``
     by scripts/vendor-tesseract.sh (this is what ships in packaged installers,
     so OCR works with no system install on macOS *and* Windows).
  3. ``tesseract`` on PATH — a system install (macOS ``brew install tesseract``,
     Debian/Ubuntu ``apt-get install tesseract-ocr``, Windows UB-Mannheim build).

When the bundled copy is used we also point Tesseract at its own data dir via
``TESSDATA_PREFIX`` so it doesn't depend on a system tessdata. If none of the
above resolve, we degrade gracefully: such pages keep their image (vision can
still read them) but contribute no retrievable text.
"""
from __future__ import annotations

import os
import shutil
import sys
from pathlib import Path

_AVAILABLE: bool | None = None
_CMD: str | None = None  # resolved path to the tesseract binary, once known


def _bundle_dir() -> Path | None:
    """Directory holding the frozen backend (and its sibling ``tesseract/``).

    PyInstaller's one-folder build sets ``sys.frozen`` and places the executable
    at the bundle root; vendor-tesseract.sh stages the bundled engine alongside
    it. Returns None when running from source (dev), where we rely on PATH.
    """
    if getattr(sys, "frozen", False):
        return Path(sys.executable).resolve().parent
    return None


def _exe_name() -> str:
    return "tesseract.exe" if os.name == "nt" else "tesseract"


def _resolve() -> str | None:
    """Locate a usable tesseract binary, wiring up TESSDATA_PREFIX for a bundle."""
    override = os.getenv("PDF_QA_TESSERACT")
    if override and Path(override).is_file():
        return override

    bundle = _bundle_dir()
    if bundle:
        cand = bundle / "tesseract" / _exe_name()
        if cand.is_file():
            tessdata = bundle / "tesseract" / "tessdata"
            # Tesseract 4/5: TESSDATA_PREFIX points at the dir holding the
            # .traineddata files. Don't clobber an explicit caller override.
            if tessdata.is_dir() and not os.getenv("TESSDATA_PREFIX"):
                os.environ["TESSDATA_PREFIX"] = str(tessdata)
            return str(cand)

    return shutil.which("tesseract")


def available() -> bool:
    global _AVAILABLE, _CMD
    if _AVAILABLE is None:
        try:
            import pytesseract
            _CMD = _resolve()
            if _CMD:
                pytesseract.pytesseract.tesseract_cmd = _CMD
            _AVAILABLE = _CMD is not None
        except Exception:
            _AVAILABLE = False
    return _AVAILABLE


def binary_path() -> str | None:
    """The resolved tesseract binary path (call after ``available()``), or None."""
    return _CMD


def ocr_image(image_path: str, lang: str = "eng") -> str:
    """Return OCR'd text for a page image, or '' on any failure."""
    if not available():
        return ""
    try:
        import pytesseract
        from PIL import Image
        return pytesseract.image_to_string(Image.open(image_path), lang=lang) or ""
    except Exception:
        return ""
