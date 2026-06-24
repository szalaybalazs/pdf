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
CUSTOM_SYSTEM_PROMPT = os.getenv("PDF_QA_SYSTEM_PROMPT", "").strip()

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
# Extra OpenAI options offered in the picker.
OPENAI_GPT54_MODEL = os.getenv("OPENAI_GPT54_MODEL", "gpt-5.4")
OPENAI_GPT41_MODEL = os.getenv("OPENAI_GPT41_MODEL", "gpt-4.1")

# Sampling temperature. Reasoning models (o3, o4-mini, some gpt-5.x) reject a
# custom temperature — set VISION_TEMPERATURE= (empty) to omit it for those.
_temp = os.getenv("VISION_TEMPERATURE", "0.1")
VISION_TEMPERATURE = float(_temp) if _temp.strip() != "" else None

# Anthropic answerer (Claude). Embeddings always go through OpenAI — Anthropic
# has no embedding API and the index is built with OpenAI vectors — so only the
# multimodal answering step switches provider.
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-8")
# Claude Sonnet, offered as a second (faster/cheaper) Anthropic option in the UI.
ANTHROPIC_SONNET_MODEL = os.getenv("ANTHROPIC_SONNET_MODEL", "claude-sonnet-4-6")
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

# --- Local models ------------------------------------------------------------
# Run a locally-installed model CLI as an answerer (no API key — uses your own
# logged-in session). First supported: the Claude Code CLI in print mode
# (`claude -p`). Text-only: it answers from the retrieved passage text (it does
# not receive page images or use our calculate/search tools).
CLAUDE_CLI_BIN = os.getenv("CLAUDE_CLI_BIN", "claude")
CLAUDE_CLI_MODEL = os.getenv("CLAUDE_CLI_MODEL", "")   # "" = the CLI's default model

# Local OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, …). Any of
# these expose the OpenAI chat API, so we route the answerer at LOCAL_BASE_URL
# exactly like the remote OpenAI path — page images, the calculate tool, and the
# search/get_pages tools all work IF the local model supports vision + tool
# calling (e.g. qwen2.5-vl). Pick a vision model or page images are ignored.
# Embeddings still use OPENAI_API_KEY: the index is built with OpenAI vectors and
# can't be queried by a different embedder, so only answering goes local here.
# Common base URLs: Ollama http://localhost:11434/v1 · LM Studio http://localhost:1234/v1
LOCAL_BASE_URL = os.getenv("LOCAL_BASE_URL", "")       # "" disables the local option
LOCAL_API_KEY = os.getenv("LOCAL_API_KEY", "local")    # most local servers ignore it
LOCAL_MODEL = os.getenv("LOCAL_MODEL", "")             # e.g. "qwen2.5-vl" — server's model id

# Selectable answerer models offered in the UI. Each id maps to a provider, the
# native model id, and the OpenRouter slug. The renderer builds its picker from
# this list; `provider` selects the native code path when OpenRouter is off.
_via = " · OpenRouter" if USE_OPENROUTER else ""
MODELS = {
    "openai":    {"label": f"OpenAI · {VISION_MODEL}{_via}",          "provider": "openai",    "model": VISION_MODEL,          "openrouter": f"openai/{VISION_MODEL}"},
    "gpt55":     {"label": f"OpenAI · {OPENAI_FRONTIER_MODEL}{_via}", "provider": "openai",    "model": OPENAI_FRONTIER_MODEL, "openrouter": f"openai/{OPENAI_FRONTIER_MODEL}"},
    "gpt54":     {"label": f"OpenAI · {OPENAI_GPT54_MODEL}{_via}",    "provider": "openai",    "model": OPENAI_GPT54_MODEL,    "openrouter": f"openai/{OPENAI_GPT54_MODEL}"},
    "gpt41":     {"label": f"OpenAI · {OPENAI_GPT41_MODEL}{_via}",    "provider": "openai",    "model": OPENAI_GPT41_MODEL,    "openrouter": f"openai/{OPENAI_GPT41_MODEL}"},
    "anthropic": {"label": f"Anthropic · Opus{_via}",                 "provider": "anthropic", "model": ANTHROPIC_MODEL,        "openrouter": f"anthropic/{ANTHROPIC_MODEL}"},
    "sonnet":    {"label": f"Anthropic · Sonnet{_via}",               "provider": "anthropic", "model": ANTHROPIC_SONNET_MODEL, "openrouter": f"anthropic/{ANTHROPIC_SONNET_MODEL}"},
    "claude-cli": {"label": "Local · claude -p (text only)",          "provider": "cli",       "model": CLAUDE_CLI_MODEL,      "openrouter": ""},
}
# Local OpenAI-compatible answerer — only offered when LOCAL_BASE_URL + LOCAL_MODEL
# are configured, so the picker never shows a dead option. `provider` "local"
# selects the local-client code path; OpenRouter routing never applies to it.
if LOCAL_BASE_URL and LOCAL_MODEL:
    MODELS["local"] = {"label": f"Local · {LOCAL_MODEL}", "provider": "local",
                       "model": LOCAL_MODEL, "openrouter": ""}
# Direct-to-OpenAI GPT-5.5 — bypasses OpenRouter (uses OPENAI_API_KEY) even when
# OpenRouter is globally enabled. The "direct" flag forces the native OpenAI path.
# Only offered when OpenRouter is on; with it off, the "gpt55" entry above already
# goes direct, so a second identical option would just be noise.
if USE_OPENROUTER:
    MODELS["gpt55-direct"] = {"label": f"OpenAI · {OPENAI_FRONTIER_MODEL} (direct)",
                              "provider": "openai", "model": OPENAI_FRONTIER_MODEL,
                              "openrouter": "", "direct": True}
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
