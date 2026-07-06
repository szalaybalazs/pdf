"""Small text-hygiene helpers shared across the backend.

Malformed PDFs (and OCR output) occasionally yield *lone surrogates* — code
points in U+D800..U+DFFF that are only legal as a high/low pair. Python keeps
them in `str`, but the moment that string is encoded to UTF-8 — writing a chat
thread to SQLite, sending JSON to the UI, POSTing to the remote store — the
encode raises `UnicodeEncodeError: surrogates not allowed` and the operation
fails. Scrub them at every boundary where text is persisted or emitted.
"""
from __future__ import annotations

import re

# Any code point in the surrogate range on its own is invalid in well-formed
# text; replace each with U+FFFD so the surrounding content still survives.
_LONE_SURROGATE = re.compile(r"[\ud800-\udfff]")


def strip_surrogates(text: str) -> str:
    """Replace lone surrogate code points with the Unicode replacement char."""
    if not isinstance(text, str) or not _LONE_SURROGATE.search(text):
        return text  # common case: nothing to scrub, return the string as-is
    return _LONE_SURROGATE.sub("�", text)
