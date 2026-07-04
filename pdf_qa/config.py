"""Central configuration. Override anything via environment variables (.env supported)."""
from __future__ import annotations

import os
import json
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

# Collections = independent libraries you switch between, each with its own index.
# The "default" collection keeps the historical layout (index right under DATA_DIR);
# a named collection lives under DATA_DIR/collections/<name>/index. The active
# collection is selected per backend process via PDF_QA_COLLECTION (the desktop app
# respawns the backend to switch). INDEX_DIR, if set explicitly, still wins.
COLLECTIONS_DIR = Path(os.getenv("PDF_QA_COLLECTIONS_DIR", str(DATA_DIR / "collections")))
ACTIVE_COLLECTION = os.getenv("PDF_QA_COLLECTION", "").strip() or "default"


def _collection_base() -> Path:
    if ACTIVE_COLLECTION.lower() != "default":
        return COLLECTIONS_DIR / ACTIVE_COLLECTION
    return DATA_DIR

# Where the index (page images + embeddings + metadata) is written. Defaults under
# the active collection's base; still overridable directly with INDEX_DIR.
INDEX_DIR = Path(os.getenv("INDEX_DIR", str(_collection_base() / "index")))
PAGES_DIR = INDEX_DIR / "pages"          # rendered page PNGs
STORE_PATH = INDEX_DIR / "store"         # vector store prefix (.npy + .jsonl)
# Content-hash manifest: doc filename -> {hash, size, mtime, ...}. Lets ingest
# skip unchanged files, re-index changed ones, and prune deleted ones on --sync.
MANIFEST_PATH = INDEX_DIR / "manifest.json"
# Records which embedder built the index (provider + model). Checked at startup:
# querying an index with a different embedder than built it is a silent accuracy
# bug (or a hard dimension-mismatch crash), so we warn loudly on a mismatch.
EMBEDDER_PATH = INDEX_DIR / "embedder.json"

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
# Which embedder builds AND queries the index (the two must match). "openai" is
# the default cloud embedder; "local" runs a sentence-transformers model on your
# machine (fully offline, needs `pip install sentence-transformers`); "hash" is a
# dependency-free deterministic bag-of-words embedder that needs no model or
# network at all — lower quality, but makes the app work fully offline out of the
# box. Whatever built the index must also query it; the identity is recorded in
# index/embedder.json and checked at startup.
EMBED_PROVIDER = os.getenv("EMBED_PROVIDER", "openai").strip().lower()
LOCAL_EMBED_MODEL = os.getenv("LOCAL_EMBED_MODEL", "sentence-transformers/all-MiniLM-L6-v2")
HASH_EMBED_DIM = int(os.getenv("HASH_EMBED_DIM", "1024"))
# OpenRouter slug for the same embedder, used as a fallback when no OPENAI_API_KEY
# is set (OpenRouter now serves an OpenAI-compatible /embeddings endpoint). The
# index and queries MUST share an embedder, so this should resolve to the same
# underlying model as EMBED_MODEL.
EMBED_OPENROUTER_MODEL = os.getenv("EMBED_OPENROUTER_MODEL", f"openai/{EMBED_MODEL}")
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
# Cap OpenAI-compatible answer streams so a model that gets stuck reasoning does
# not run for minutes and consume an enormous completion.
ANSWER_MAX_TOKENS = int(os.getenv("ANSWER_MAX_TOKENS", "4096"))
# Reasoning-heavy models (o-series, gpt-5.x, GLM) spend a large, hidden share of
# the completion on reasoning tokens, which count against max_tokens. With the
# base 4096 cap, GLM routinely exhausts the budget mid-reasoning and never emits
# a visible answer, so these models get a larger ceiling that leaves room for the
# answer after the reasoning.
REASONING_MAX_TOKENS = int(os.getenv("REASONING_MAX_TOKENS", "8192"))

# Anthropic answerer (Claude). Embeddings always go through OpenAI — Anthropic
# has no embedding API and the index is built with OpenAI vectors — so only the
# multimodal answering step switches provider.
ANTHROPIC_MODEL = os.getenv("ANTHROPIC_MODEL", "claude-opus-4-8")
# Claude Sonnet, offered as a second (faster/cheaper) Anthropic option in the UI.
ANTHROPIC_SONNET_MODEL = os.getenv("ANTHROPIC_SONNET_MODEL", "claude-sonnet-4-6")
ANTHROPIC_MAX_TOKENS = int(os.getenv("ANTHROPIC_MAX_TOKENS", "4096"))

# GLM (Zhipu AI), a text-only answerer served via OpenRouter. It has no vision
# input, so the index's page images are never sent — it answers from the
# retrieved passage text alone (the calculate / search / get_pages tools still
# work). Only offered when OpenRouter is enabled (no native GLM code path).
GLM_MODEL = os.getenv("GLM_MODEL", "z-ai/glm-5.2")


def _bool_env(name: str, default: bool) -> bool:
    v = os.getenv(name)
    return default if v is None else v.strip().lower() in ("1", "true", "yes", "on")


# --- OpenRouter --------------------------------------------------------------
# OpenRouter (https://openrouter.ai) is an OpenAI-compatible gateway that serves
# both GPT and Claude through one key/endpoint. When enabled, all chat/vision/
# title calls route through it. Embeddings (PDF index + thread search) prefer the
# direct OPENAI_API_KEY, but fall back to OpenRouter's OpenAI-compatible
# /embeddings endpoint (EMBED_OPENROUTER_MODEL) when no OpenAI key is set.
OPENROUTER_API_KEY = os.getenv("OPENROUTER_API_KEY")
OPENROUTER_BASE_URL = os.getenv("OPENROUTER_BASE_URL", "https://openrouter.ai/api/v1")
USE_OPENROUTER = _bool_env("USE_OPENROUTER", bool(OPENROUTER_API_KEY))

# --- AWS Bedrock -------------------------------------------------------------
# Bedrock is reached through its OpenAI-compatible "bedrock-mantle" gateway, NOT
# boto3/SigV4: one Bedrock API key (a bearer token) used as the OpenAI key, with
# a region-specific base URL. Most models (Claude, GLM, …) speak the Chat
# Completions API at .../v1; OpenAI's own models (GPT-5.5) speak ONLY the
# Responses API at .../openai/v1. Embeddings still use the direct OpenAI key.
#   key:    Settings field → BEDROCK_API_KEY, else the standard AWS_BEARER_TOKEN_BEDROCK env.
#   region: BEDROCK_REGION, else AWS_REGION, else us-east-1.
BEDROCK_API_KEY = os.getenv("BEDROCK_API_KEY") or os.getenv("AWS_BEARER_TOKEN_BEDROCK")
BEDROCK_REGION = os.getenv("BEDROCK_REGION") or os.getenv("AWS_REGION") or "us-east-1"
USE_BEDROCK = _bool_env("USE_BEDROCK", bool(BEDROCK_API_KEY))

# Bedrock model IDs are region- and catalog-dependent and change over time, so
# every one is overridable. Use the bare `anthropic.claude-*` id; if your account
# requires a cross-region inference profile, set the region prefix (us./eu./
# apac./jp.) via these env vars.
BEDROCK_OPUS_MODEL = os.getenv("BEDROCK_OPUS_MODEL", "anthropic.claude-opus-4-8")
BEDROCK_SONNET_MODEL = os.getenv("BEDROCK_SONNET_MODEL", "anthropic.claude-sonnet-4-6")
BEDROCK_GLM_MODEL = os.getenv("BEDROCK_GLM_MODEL", "zai.glm-5")
BEDROCK_DEEPSEEK_MODEL = os.getenv("BEDROCK_DEEPSEEK_MODEL", "deepseek.v3.2")
BEDROCK_KIMI_MODEL = os.getenv("BEDROCK_KIMI_MODEL", "moonshotai.kimi-k2.5")


def bedrock_base_url() -> str:
    """bedrock-mantle OpenAI-compatible Chat Completions endpoint URL."""
    return f"https://bedrock-mantle.{BEDROCK_REGION}.api.aws/v1"


def _bedrock_geo_prefix(region: str) -> str:
    """Cross-region inference-profile prefix for a region. Many newer models
    (e.g. Claude) aren't available in-region and must be called via the geo
    profile (us./eu./jp./au.). Heuristic; override the model id env var if your
    region maps differently."""
    r = (region or "").lower()
    if r.startswith(("us-", "ca-")):
        return "us."
    if r.startswith("eu-"):
        return "eu."
    if r.startswith("ap-northeast-"):
        return "jp."
    if r in ("ap-southeast-2", "ap-southeast-4", "ap-southeast-6"):
        return "au."
    return ""   # unknown geo → use the id as-is (or set a global./… id explicitly)


def bedrock_model_id(model_id: str) -> str:
    """Resolve a Converse modelId for the configured region. A bare `anthropic.*`
    id gets the region's geo prefix applied; ids that already carry a prefix
    (us./eu./jp./au./apac./global.) or aren't `anthropic.*` pass through."""
    mid = (model_id or "").strip()
    if not mid.startswith("anthropic."):
        return mid
    prefix = _bedrock_geo_prefix(BEDROCK_REGION)
    return f"{prefix}{mid}" if prefix else mid

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
DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1"
LOCAL_BASE_URL = os.getenv("LOCAL_BASE_URL", "")       # blank local rows fall back to Ollama's default
LOCAL_API_KEY = os.getenv("LOCAL_API_KEY", "local")    # most local servers ignore it
LOCAL_MODEL = os.getenv("LOCAL_MODEL", "")             # e.g. "qwen2.5-vl" — server's model id
LOCAL_MODELS_RAW = os.getenv("LOCAL_MODELS", "")       # JSON: [{base_url, api_key, model}]


def _local_model_specs() -> dict[str, dict]:
    """Configured local OpenAI-compatible answerers.

    The desktop app writes LOCAL_MODELS as a JSON array. Keep the old single
    LOCAL_BASE_URL/LOCAL_MODEL env vars as a migration path for CLI users and
    older settings files.
    """
    entries: list[dict] = []
    if LOCAL_MODELS_RAW.strip():
        try:
            parsed = json.loads(LOCAL_MODELS_RAW)
            if isinstance(parsed, list):
                entries.extend(x for x in parsed if isinstance(x, dict))
        except Exception:
            entries = []
    if not entries and LOCAL_MODEL:
        entries.append({"base_url": LOCAL_BASE_URL or DEFAULT_LOCAL_BASE_URL,
                        "api_key": LOCAL_API_KEY, "model": LOCAL_MODEL})

    out: dict[str, dict] = {}
    seen: dict[str, int] = {}
    for item in entries:
        base_url = str(item.get("base_url") or item.get("baseUrl") or LOCAL_BASE_URL or DEFAULT_LOCAL_BASE_URL).strip()
        model = str(item.get("model") or "").strip()
        api_key = str(item.get("api_key") or item.get("apiKey") or "local").strip() or "local"
        if not model:
            continue
        # A text-only local model (no vision input) is flagged so the answerer
        # skips page images and uses the text-only system prompt.
        text_only = bool(item.get("text_only") or item.get("textOnly"))
        base_id = "local-" + "".join(ch if ch.isalnum() else "-" for ch in model.lower()).strip("-")
        base_id = base_id or "local"
        seen[base_id] = seen.get(base_id, 0) + 1
        mid = base_id if seen[base_id] == 1 else f"{base_id}-{seen[base_id]}"
        label = f"Local · {model}" + (" (text only)" if text_only else "")
        out[mid] = {"label": label, "provider": "local", "model": model,
                    "openrouter": "", "base_url": base_url, "api_key": api_key,
                    "vision": not text_only}
    return out

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
# Local OpenAI-compatible answerers — only offered when base URL + model are
# configured, so the picker never shows dead options. `provider` "local" selects
# the local-client code path; OpenRouter routing never applies to these.
MODELS.update(_local_model_specs())
# Direct-to-OpenAI GPT-5.5 — bypasses OpenRouter (uses OPENAI_API_KEY) even when
# OpenRouter is globally enabled. The "direct" flag forces the native OpenAI path.
# Only offered when OpenRouter is on; with it off, the "gpt55" entry above already
# goes direct, so a second identical option would just be noise.
if USE_OPENROUTER:
    MODELS["gpt55-direct"] = {"label": f"OpenAI · {OPENAI_FRONTIER_MODEL} (direct)",
                              "provider": "openai", "model": OPENAI_FRONTIER_MODEL,
                              "openrouter": "", "direct": True}
    # GLM (Z.ai) is text-only and reachable only through OpenRouter, so it's offered
    # only when OpenRouter is on. Its own "zai" provider keeps it distinct from the
    # OpenAI options; the dispatcher still routes it through the OpenAI-compatible
    # OpenRouter path (any non-cli/local/anthropic provider falls through there).
    # `vision: False` makes the answerer drop page images.
    MODELS["glm"] = {"label": f"Z.ai · {GLM_MODEL} (text only){_via}", "provider": "zai",
                     "model": GLM_MODEL, "openrouter": GLM_MODEL, "vision": False}
# AWS Bedrock answerers. Only offered when a Bedrock API key is configured. `api`
# picks the wire protocol: "chat" → OpenAI-compatible Chat Completions on the
# bedrock-mantle gateway (GLM, DeepSeek); "converse" → boto3 bedrock-runtime
# Converse (Claude, which isn't on mantle). OpenRouter routing never applies.
if USE_BEDROCK:
    # Claude is NOT on the OpenAI-compatible mantle gateway — only bedrock-runtime
    # (Converse/Invoke) — so it takes the boto3 Converse path.
    MODELS["bedrock-opus"] = {"label": "Bedrock · Claude Opus", "provider": "bedrock",
                              "model": BEDROCK_OPUS_MODEL, "openrouter": "", "api": "converse", "vision": True}
    MODELS["bedrock-sonnet"] = {"label": "Bedrock · Claude Sonnet", "provider": "bedrock",
                                "model": BEDROCK_SONNET_MODEL, "openrouter": "", "api": "converse", "vision": True}
    MODELS["bedrock-glm"] = {"label": "Bedrock · GLM 5 (text only)", "provider": "bedrock",
                             "model": BEDROCK_GLM_MODEL, "openrouter": "", "api": "chat", "vision": False}
    # DeepSeek V3.2 — Chat Completions on mantle, text-only (no image input).
    MODELS["bedrock-deepseek"] = {"label": "Bedrock · DeepSeek V3.2 (text only)", "provider": "bedrock",
                                  "model": BEDROCK_DEEPSEEK_MODEL, "openrouter": "", "api": "chat", "vision": False}
    # Kimi K2.5 — Chat Completions on mantle, multimodal (accepts page images).
    MODELS["bedrock-kimi"] = {"label": "Bedrock · Kimi K2.5", "provider": "bedrock",
                              "model": BEDROCK_KIMI_MODEL, "openrouter": "", "api": "chat", "vision": True}

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

# Extract tables as their own markdown chunks (PyMuPDF find_tables). A table's
# numbers live in a grid the prose flow mangles, so embedding the reconstructed
# markdown lets numeric/tabular queries hit the actual cells instead of relying on
# the vision model to read the rendered page. Set EXTRACT_TABLES=false to skip.
EXTRACT_TABLES = _bool_env("EXTRACT_TABLES", True)
TABLE_CHARS_MAX = int(os.getenv("TABLE_CHARS_MAX", "4000"))  # cap per table chunk

# Worker threads for ingestion. Page rendering (PyMuPDF releases the GIL), OCR
# (a tesseract subprocess) and embedding (network) all run concurrently across
# these, so a multi-hundred-page book ingests several times faster. Each worker
# owns its own fitz document handle — handles are never shared across threads.
# Set INGEST_WORKERS=1 to force the old fully-sequential behaviour.
def _default_workers() -> int:
    return max(1, min(8, (os.cpu_count() or 4)))


INGEST_WORKERS = max(1, int(os.getenv("INGEST_WORKERS", str(_default_workers()))))
# How many documents to ingest concurrently when several are added at once. The
# INGEST_WORKERS page-thread budget is split across the docs in flight, so total
# threads stay bounded (e.g. 4 docs × 2 page-threads on an 8-worker machine).
# This is what makes the UI show several documents progressing at the same time.
INGEST_DOC_WORKERS = max(1, int(os.getenv("INGEST_DOC_WORKERS", str(min(4, INGEST_WORKERS)))))
# Concurrent embedding requests during ingest. Kept modest by default so a large
# book doesn't trip provider rate limits; capped by INGEST_WORKERS too.
EMBED_WORKERS = max(1, int(os.getenv("EMBED_WORKERS", str(min(4, INGEST_WORKERS)))))

# --- Retrieval / answer knobs ------------------------------------------------
TOP_K = int(os.getenv("TOP_K", "8"))                 # text chunks retrieved
MAX_IMAGES = int(os.getenv("MAX_IMAGES", "4"))       # distinct page images sent to vision
VISION_MAX_DIM = int(os.getenv("VISION_MAX_DIM", "1536"))  # downscale cap before upload

# --- Reranking ---------------------------------------------------------------
# Second-stage reranking. The first-stage search pulls a wider candidate pool
# (RERANK_CANDIDATES) and a cheap listwise LLM reranker re-orders it by true
# relevance, keeping the best TOP_K. This is the single biggest retrieval-quality
# lever in RAG. Fail-safe: any error (no key, bad output) falls back to the
# first-stage order, so answering never breaks. Set RERANK_ENABLED=false to skip
# it (saves one cheap model call per query).
RERANK_ENABLED = _bool_env("RERANK_ENABLED", True)
RERANK_CANDIDATES = int(os.getenv("RERANK_CANDIDATES", "30"))  # pool size before rerank
RERANK_MODEL = os.getenv("RERANK_MODEL", SUMMARY_MODEL)        # cheap listwise reranker

# --- Query rewriting ---------------------------------------------------------
# On a follow-up ("what about its bias?"), the raw question embeds poorly because
# it depends on the earlier turns. A cheap model rewrites it into a standalone,
# keyword-rich search query (pronouns resolved) used for retrieval only — the
# answerer still gets the original question and full history. Set
# QUERY_REWRITE=false to embed the question verbatim.
QUERY_REWRITE = _bool_env("QUERY_REWRITE", True)
REWRITE_MODEL = os.getenv("REWRITE_MODEL", SUMMARY_MODEL)

# --- Hybrid search -----------------------------------------------------------
# Fuse dense (embedding cosine) and sparse (BM25 lexical) retrieval with
# Reciprocal Rank Fusion. Cosine alone misses exact terms — part numbers,
# equation names, acronyms — that a lexical match nails; BM25 alone misses
# paraphrase. RRF combines both rankings without tuning a score scale. Set
# HYBRID_SEARCH=false to use dense-only retrieval (the original behaviour).
HYBRID_SEARCH = _bool_env("HYBRID_SEARCH", True)
RRF_K = int(os.getenv("RRF_K", "60"))                # RRF damping constant

# --- Retrieval confidence ("I don't know" calibration) -----------------------
# When the best fused/cosine match is weak, the documents probably don't cover
# the question. We surface that: a `confidence` field on the answer (for a UI
# chip) and a low-confidence hint injected into the prompt so the model leans
# toward "not enough data" instead of stretching. Threshold is on top cosine
# similarity (0..1); tune per corpus.
CONFIDENCE_LOW = float(os.getenv("CONFIDENCE_LOW", "0.30"))
CONFIDENCE_HIGH = float(os.getenv("CONFIDENCE_HIGH", "0.45"))

OPENAI_API_KEY = os.getenv("OPENAI_API_KEY")
ANTHROPIC_API_KEY = os.getenv("ANTHROPIC_API_KEY")


def resolve_model(model_id: str | None) -> dict:
    """Return the {label, provider, model} spec for a UI model id, falling back
    to the configured default when the id is unknown or missing."""
    return MODELS.get(model_id) or MODELS[DEFAULT_MODEL]


def model_supports_vision(spec: dict) -> bool:
    """Whether a model spec accepts image input. Defaults to True so every
    existing model keeps sending page images; only specs that explicitly set
    `vision: False` (GLM, text-only local models) take the text-only path."""
    return bool(spec.get("vision", True))
