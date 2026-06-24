"""Central configuration. Override anything via environment variables (.env supported)."""
from __future__ import annotations

import os
from pathlib import Path

try:
    from dotenv import load_dotenv
    load_dotenv()
except Exception:  # dotenv optional
    pass

# --- Paths -------------------------------------------------------------------
# Where your PDFs live. Defaults to the user's "Proba" folder; override with PDF_DIR.
PDF_DIR = Path(os.getenv("PDF_DIR", str(Path.home() / "Downloads" / "Proba")))

# Root for all app data. The Electron app sets PDF_QA_DATA_DIR to its per-user
# directory (app.getPath('userData')); for bare CLI use it defaults to the project
# folder so nothing changes when you run ingest/ask without the desktop shell.
DATA_DIR = Path(os.getenv("PDF_QA_DATA_DIR", str(Path(__file__).resolve().parent.parent)))

# Where the index (page images + embeddings + metadata) is written. Defaults under
# DATA_DIR; still overridable directly with INDEX_DIR.
INDEX_DIR = Path(os.getenv("INDEX_DIR", str(DATA_DIR / "index")))
PAGES_DIR = INDEX_DIR / "pages"          # rendered page PNGs
STORE_PATH = INDEX_DIR / "store"         # vector store prefix (.npy + .jsonl)

# SQLite database holding chat threads (+ their search embeddings).
DB_PATH = Path(os.getenv("PDF_QA_DB", str(DATA_DIR / "threads.db")))


def resolve_image(p: str) -> str:
    """Resolve a stored page-image path to an absolute path. New indexes store
    paths relative to PAGES_DIR; legacy indexes stored absolute paths — pass
    those through unchanged so old stores keep working."""
    if os.path.isabs(p):
        return p
    return str(PAGES_DIR / p)

# --- Models ------------------------------------------------------------------
EMBED_MODEL = os.getenv("EMBED_MODEL", "text-embedding-3-small")  # cheap, 1536-d
# Small/cheap model used only to summarise a chat into a short thread title.
# Always OpenAI (its key is required for embeddings regardless of the answerer).
SUMMARY_MODEL = os.getenv("SUMMARY_MODEL", "gpt-4o-mini")
# Multimodal answerer. Any OpenAI model that accepts image input works here.
# Stronger options (June 2026): "gpt-5.5" (flagship multimodal), "o3" (best at
# charts/diagrams reasoning), "o4-mini" (cheaper reasoning). Set via VISION_MODEL.
VISION_MODEL = os.getenv("VISION_MODEL", "gpt-4o")
# OpenAI's frontier multimodal model, offered as a second OpenAI option in the UI.
OPENAI_FRONTIER_MODEL = os.getenv("OPENAI_FRONTIER_MODEL", "gpt-5.5")

# Sampling temperature. Reasoning models (o3, o4-mini, some gpt-5.x) reject a
# custom temperature — set VISION_TEMPERATURE= (empty) to omit it for those.
_temp = os.getenv("VISION_TEMPERATURE", "0.1")
VISION_TEMPERATURE = float(_temp) if _temp.strip() != "" else None

# Anthropic answerer (Claude). Embeddings always go through OpenAI — Anthropic
# has no embedding API and the index is built with OpenAI vectors — so only the
# multimodal answering step switches provider.
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-8")
ANTHROPIC_MAX_TOKENS = int(os.getenv("ANTHROPIC_MAX_TOKENS", "4096"))


def _bool_env(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


# --- OpenRouter --------------------------------------------------------------
# OpenRouter (https://openrouter.ai) is an OpenAI-compatible gateway that serves
# both GPT and Claude through one key/endpoint. When enabled, all chat/vision/
# title calls route through it. NOTE: OpenRouter has no embeddings endpoint, so
# embeddings (PDF index + thread search) still use the direct OPENAI_API_KEY.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
USE_OPENROUTER = _bool_env("USE_OPENROUTER", bool(OPENROUTER_API_KEY))

# Selectable answerer models offered in the UI. Each id maps to a provider, the
# native model id, and the OpenRouter slug. The renderer builds its picker from
# this list; `provider` selects the native code path when OpenRouter is off.
_via = " · OpenRouter" if USE_OPENROUTER else ""
MODELS = {
    "openai":    {"label": f"OpenAI · {VISION_MODEL}{_via}",          "provider": "openai",    "model": VISION_MODEL,          "openrouter": f"openai/{VISION_MODEL}"},
    "gpt55":     {"label": f"OpenAI · {OPENAI_FRONTIER_MODEL}{_via}", "provider": "openai",    "model": OPENAI_FRONTIER_MODEL, "openrouter": f"openai/{OPENAI_FRONTIER_MODEL}"},
    "anthropic": {"label": f"Anthropic · Opus{_via}",                 "provider": "anthropic", "model": ANTHROPIC_MODEL,        "openrouter": f"anthropic/{ANTHROPIC_MODEL}"},
}
# Which model is selected by default (must be a key of MODELS).
DEFAULT_MODEL = os.getenv("ANSWER_MODEL", "openai")
if DEFAULT_MODEL not in MODELS:
    DEFAULT_MODEL = "openai"

# --- Ingestion knobs ---------------------------------------------------------
RENDER_DPI = int(os.getenv("RENDER_DPI", "150"))     # page-render resolution
CHUNK_WORDS = int(os.getenv("CHUNK_WORDS", "320"))   # ~ target words per text chunk
CHUNK_OVERLAP = int(os.getenv("CHUNK_OVERLAP", "60"))  # words of overlap between chunks
EMBED_BATCH = int(os.getenv("EMBED_BATCH", "128"))   # embeddings per API request
OCR_LANG = os.getenv("OCR_LANG", "eng")              # Tesseract language(s), e.g. "eng+deu"

# --- Retrieval / answer knobs ------------------------------------------------
TOP_K = int(os.getenv("TOP_K", "8"))                 # text chunks retrieved
MAX_IMAGES = int(os.getenv("MAX_IMAGES", "4"))       # distinct page images sent to vision
VISION_MAX_DIM = int(os.getenv("VISION_MAX_DIM", "1536"))  # downscale cap before upload

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")


def resolve_model(model_id: str | None) -> dict:
    """Return the {label, provider, model} spec for a UI model id, falling back
    to the configured default when the id is unknown or missing."""
    return MODELS.get(model_id) or MODELS[DEFAULT_MODEL]
