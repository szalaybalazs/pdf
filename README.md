# pdf_qa — Multimodal Q&A over a PDF library

Ask natural-language questions across a folder of PDFs and get answers where the
model **reads the actual charts, schematics, tables and equations** on the page —
not just a text summary of them.

This is a multimodal design: only **text** is embedded at ingest time (cheap),
and the relevant page **images** are sent to a vision model at query time so it
can trace a curve, read an axis, or apply a formula directly from the page.

## How it works

```
ingest:  PDF ─┬─ render each page to PNG ───────────────┐
              ├─ extract text layer (PyMuPDF) ───────────┤
              │     └─ if garbage/missing → OCR the PNG  │ (Tesseract)
              └─ chunk text → OpenAI embeddings ─────────┴─→ local vector store

ask:     question → embed → retrieve top text chunks
                 → gather the page images those chunks came from
                 → vision model reads passages + page images → cited answer
```

At query time the answerer runs as a small tool-using loop. Beyond the initial
retrieved passages it can:

- **`search_documents`** — run another similarity search if it needs more context.
- **`get_pages`** — pull a specific page image by number when a passage points to one.
- **`calculate`** — evaluate arithmetic exactly. The model picks the formula and
  substitutes values, but every number is computed deterministically in
  [`pdf_qa/calc.py`](pdf_qa/calc.py) with SymPy (math) and pint (units), never by
  the model itself.

### Why OCR is built in
PDF text layers are not always trustworthy — some embedded fonts carry no Unicode
map, so naive extraction returns glyph-code garbage. The pipeline auto-detects
this per page and falls back to OCR of the rendered image, recovering real text
for retrieval. Pages with a clean text layer use it directly, so you get a usable
index either way.

## Answerer models
The same retrieval pipeline feeds whichever model you pick. Embeddings always go
through OpenAI (the index is built with OpenAI vectors and must be queried by the
same embedder); only the multimodal **answering** step changes provider:

- **OpenAI** — any model that accepts image input (`VISION_MODEL`, default `gpt-4o`).
- **Anthropic (Claude)** — Opus / Sonnet, via `ANTHROPIC_API_KEY`.
- **OpenRouter** — one key/endpoint that serves both GPT and Claude. When enabled
  (`OPENROUTER_API_KEY`), all chat/vision/title calls route through it. OpenRouter
  has no embeddings endpoint, so `OPENAI_API_KEY` is still required for indexing
  and chat search.
- **Local** — any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM) via
  `LOCAL_BASE_URL` + `LOCAL_MODEL`; page images and tools work if the local model
  supports vision + tool calling. Also a text-only `claude -p` CLI option that uses
  your logged-in session (no API key, no page images).

## Setup

```bash
pip install -r requirements.txt
# OCR fallback also needs the Tesseract binary:
#   macOS:  brew install tesseract
#   Ubuntu: sudo apt-get install tesseract-ocr

cp .env.example .env       # then fill in your keys and PDF_DIR
```

Minimum `.env`:
```
OPENAI_API_KEY=sk-...
PDF_DIR=/path/to/your/pdfs     # folder of source PDFs
```
See `.env.example` for the optional keys (Anthropic, OpenRouter, local) and tunables.

## Usage

```bash
# 1) Build the index (renders pages, extracts/OCRs text, embeds, stores)
python -m pdf_qa.ingest

#    Useful variants:
python -m pdf_qa.ingest --no-embed            # parse + render only, no API key / no cost
python -m pdf_qa.ingest --files "book.pdf"    # index specific files
python -m pdf_qa.ingest --no-ocr              # skip OCR fallback
python -m pdf_qa.ingest --workers 8           # page-processing threads per doc (1 = sequential)

# 2) Ask questions — interactive chat
python -m pdf_qa.ask                          # chat REPL
python -m pdf_qa.ask "your question here"     # one-shot
python -m pdf_qa.ask --debug                  # start with the debug trace on
```

A desktop app (Electron) wraps the same backend — see [`app/README.md`](app/README.md).

### The chat interface
A colored, persistent REPL that shows a live **tool-call trace** for every
question — the same steps the system runs under the hood:

```
› your question here

⏺ embed_query model=text-embedding-3-small  0.31s
  ⎿ 1 vector · dim 1536
⏺ search top_k=8                            0.01s
  ⎿ 8 chunks from 2 doc(s)
⏺ collect_pages max=4                       0.00s
  ⎿ doc-a p.106, doc-b p.214
⏺ answer model=gpt-4o                       3.04s
  ⎿ 4 image(s) sent

● Based on the plate characteristics on the page, … (doc-a p.106)
```

Slash commands:

| Command | Effect |
|---------|--------|
| `/debug` | toggle the verbose trace (similarity scores, token counts, image dimensions) |
| `/sources` | show the sources cited in the last answer |
| `/clear` | forget conversation history (start a fresh thread) |
| `/help` | list commands |
| `/quit` | exit (also `/exit`, Ctrl-D) |

Follow-up questions remember the last few turns, so you can ask *"and for the
other one?"* and it keeps context. Answers cite sources inline, e.g.
*(doc-a p.106)*. Colors auto-disable when output is piped or `NO_COLOR` is set.

With `--debug` (or after `/debug`) each step expands:

```
⏺ search top_k=8                            0.01s
  ⎿ 8 chunks from 2 doc(s)
    0.842  doc-a p.106  "…retrieved passage text…"
    0.811  doc-b p.214  "…retrieved passage text…"
⏺ answer model=gpt-4o                       3.04s
  ⎿ 4 image(s) sent
    tokens: 5120 prompt + 240 completion = 5360
```

## Cost model
- **Ingest:** only text embeddings (`text-embedding-3-small`) — cheap, runs once.
- **Ask:** one vision call per question, including a handful of page images
  (capped by `MAX_IMAGES`, default 4, downscaled to `VISION_MAX_DIM`). Page images
  are never embedded, so the expensive vision tokens are spent only on the few
  pages actually retrieved.

## Configuration (env vars, see [`pdf_qa/config.py`](pdf_qa/config.py))
| Var | Default | Meaning |
|-----|---------|---------|
| `PDF_DIR` | `~/Downloads/Proba` | folder of source PDFs |
| `INDEX_DIR` | `<data dir>/index` | where page images + vectors are written |
| `EMBED_MODEL` | `text-embedding-3-small` | embedding model |
| `VISION_MODEL` | `gpt-4o` | OpenAI multimodal answering model |
| `ANTHROPIC_MODEL` | `claude-opus-4-8` | Anthropic answering model |
| `OPENROUTER_API_KEY` | — | route all chat/vision through OpenRouter if set |
| `LOCAL_BASE_URL` / `LOCAL_MODEL` | — | OpenAI-compatible local answerer |
| `ANSWER_MODEL` | `openai` | which model is selected by default |
| `RENDER_DPI` | `150` | page render resolution |
| `INGEST_WORKERS` | `min(8, CPUs)` | page-processing threads per document (`1` = sequential) |
| `INGEST_DOC_WORKERS` | `min(4, INGEST_WORKERS)` | documents ingested concurrently (page budget split across them) |
| `EMBED_WORKERS` | `min(4, INGEST_WORKERS)` | concurrent embedding requests during ingest |
| `CHUNK_WORDS` / `CHUNK_OVERLAP` | `320` / `60` | text chunk sizing |
| `TOP_K` | `8` | text chunks retrieved per question |
| `MAX_IMAGES` | `4` | distinct page images sent to the vision model |
| `OCR_LANG` | `eng` | Tesseract language(s), e.g. `eng+deu` |

## Files
- `pdf_qa/ingest.py` — PDF → page images + text/OCR → chunks → embeddings → store
- `pdf_qa/ask.py` — interactive chat REPL: retrieve → gather page images → vision answer
- `pdf_qa/llm.py` — embeddings + multimodal chat wrappers, tool loop (calculate / search / get_pages)
- `pdf_qa/calc.py` — deterministic math engine (SymPy + pint) behind the `calculate` tool
- `pdf_qa/ui.py` — ANSI colors + Claude Code-style tool-call trace (no dependencies)
- `pdf_qa/ocr.py` — Tesseract fallback for pages with broken/missing text layers
- `pdf_qa/store.py` — tiny brute-force cosine vector store (.npy + .jsonl)
- `pdf_qa/threads.py` — SQLite thread store + cross-thread semantic search (used by the app)
- `pdf_qa/serve.py` — JSON-over-stdio backend the desktop app talks to
- `pdf_qa/config.py` — all settings, env-overridable

## Scaling notes
The store is brute-force cosine over a NumPy matrix — fine for a few thousand
pages. For a much larger corpus, swap `store.py` for FAISS or Chroma; the
interface is intentionally small. The design keeps everything local except the
model API calls.
