"""OCR fallback for pages whose embedded text layer is missing or garbage.

Many PDFs (e.g. the Morgan Jones book in this corpus) embed fonts with no
ToUnicode map, so PyMuPDF returns raw glyph codes instead of readable text.
For those pages we OCR the rendered page image instead, which is the only way
to get text that's usable for retrieval.

Requires the Tesseract binary:  macOS `brew install tesseract`,
Debian/Ubuntu `apt-get install tesseract-ocr`. If it's missing we degrade
gracefully: such pages keep their image (vision can still read them) but
contribute no retrievable text.
"""
from __future__ import annotations

import shutil

_AVAILABLE: bool | None = None


def available() -> bool:
    global _AVAILABLE
    if _AVAILABLE is None:
        try:
            import pytesseract  # noqa: F401
            _AVAILABLE = shutil.which("tesseract") is not None
        except Exception:
            _AVAILABLE = False
    return _AVAILABLE


def ocr_image(image_path: str, lang: str = "eng") -> str:
    """Return OCR'd text for a page image, or '' on any failure."""
    try:
        import pytesseract
        from PIL import Image
        return pytesseract.image_to_string(Image.open(image_path), lang=lang) or ""
    except Exception:
        return ""
