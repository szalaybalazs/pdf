# pdf_qa — Multimodal Q&A over a PDF library

Ask natural-language questions across a folder of PDFs and get answers where the
model **reads the actual charts, schematics, tables and equations** on the page —
not just a text summary of them.

This is the "Option B — multimodal" design: only **text** is embedded at ingest
time (cheap), and the relevant page **images** are sent to a vision model
(GPT-4o) at query time so it can trace a curve, read an axis, or apply a formula
directly from the page.

## How it works

```
ingest:  PDF ─┬─ render each page to PNG ───────────────┐
              ├─ extract text layer (PyMuPDF) ───────────┤
              │     └─ if garbage/missing → OCR the PNG  │ (Tesseract)
              └─ chunk text → OpenAI embeddings ─────────┴─→ local vector store

ask:     question → embed → retrieve top text chunks
                 → gather the page images those chunks came from
                 → GPT-4o reads passages + page images → cited answer
```

### Why OCR is built in
PDF text layers are not always trustworthy. In this very corpus, the Morgan
Jones book has **604 of 633 pages whose embedded fonts carry no Unicode map**, so
naive text extraction returns glyph-code garbage. The pipeline auto-detects this
per page and falls back to OCR of the rendered image, recovering real text for
retrieval. The Zoran book (469/477 clean) and the datasheet use their text layer
directly. You get a clean index either way.

## Setup

```bash
pip install -r requirements.txt
# OCR fallback also needs the Tesseract binary:
#   macOS:  brew install tesseract
#   Ubuntu: sudo apt-get install tesseract-ocr

cp .env.example .env       # then put your OpenAI key in .env
```

`.env`:
```
OPENAI_API_KEY=sk-...
PDF_DIR=/Users/balazs/Downloads/Proba     # where your PDFs live
```

## Usage

```bash
# 1) Build the index (renders pages, extracts/OCRs text, embeds, stores)
python -m pdf_qa.ingest

#    Useful variants:
python -m pdf_qa.ingest --no-embed            # parse + render only, no API key / no cost
python -m pdf_qa.ingest --files "book.pdf"    # index specific files
python -m pdf_qa.ingest --no-ocr              # skip OCR fallback

# 2) Ask questions — interactive chat
python -m pdf_qa.ask                          # Claude Code-style chat REPL
python -m pdf_qa.ask "What bias does the ECC83 datasheet recommend?"  # one-shot
python -m pdf_qa.ask --debug                  # start with the debug trace on
```

### The chat interface
A colored, persistent REPL that shows a live **tool-call trace** for every
question — the same steps the system runs under the hood:

```
› what is the anode load for the ECC83?

⏺ embed_query model=text-embedding-3-small  0.31s
  ⎿ 1 vector · dim 1536
⏺ search top_k=8                            0.01s
  ⎿ 8 chunks from 2 doc(s)
⏺ collect_pages max=4                       0.00s
  ⎿ Morgan_Jones... p.106, Zoran... p.214
⏺ gpt-4o model=gpt-4o                       3.04s
  ⎿ 4 image(s) sent

● Based on the plate characteristics on the page, a 100 kΩ anode load … (Morgan_Jones... p.106)
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
other tube?"* and it keeps context. Answers cite sources inline, e.g.
*(Morgan_Jones... p.106)*. Colors auto-disable when output is piped or
`NO_COLOR` is set.

With `--debug` (or after `/debug`) each step expands:

```
⏺ search top_k=8                            0.01s
  ⎿ 8 chunks from 2 doc(s)
    0.842  Morgan_Jones p.106  “the anode load line for…”
    0.811  Zoran p.214         “plate resistance rp is…”
⏺ gpt-4o model=gpt-4o                       3.04s
  ⎿ 4 image(s) sent
    tokens: 5120 prompt + 240 completion = 5360
```

## Cost model
- **Ingest:** only text embeddings (`text-embedding-3-small`) — cheap, runs once.
- **Ask:** one GPT-4o call per question, including a handful of page images
  (capped by `MAX_IMAGES`, default 4, downscaled to `VISION_MAX_DIM`). Page images
  are never embedded, so the expensive vision tokens are spent only on the few
  pages actually retrieved.

## Configuration (env vars, see `pdf_qa/config.py`)
| Var | Default | Meaning |
|-----|---------|---------|
| `PDF_DIR` | `~/Downloads/Proba` | folder of source PDFs |
| `INDEX_DIR` | `./index` | where page images + vectors are written |
| `EMBED_MODEL` | `text-embedding-3-small` | embedding model |
| `VISION_MODEL` | `gpt-4o` | multimodal answering model |
| `RENDER_DPI` | `150` | page render resolution |
| `CHUNK_WORDS` / `CHUNK_OVERLAP` | `320` / `60` | text chunk sizing |
| `TOP_K` | `8` | text chunks retrieved per question |
| `MAX_IMAGES` | `4` | distinct page images sent to the vision model |
| `OCR_LANG` | `eng` | Tesseract language(s), e.g. `eng+deu` |

## Files
- `pdf_qa/ingest.py` — PDF → page images + text/OCR → chunks → embeddings → store
- `pdf_qa/ask.py` — interactive chat REPL: retrieve → gather page images → vision answer
- `pdf_qa/ui.py` — ANSI colors + Claude Code-style tool-call trace (no dependencies)
- `pdf_qa/llm.py` — OpenAI embeddings + multimodal chat wrappers
- `pdf_qa/ocr.py` — Tesseract fallback for pages with broken/missing text layers
- `pdf_qa/store.py` — tiny brute-force cosine vector store (.npy + .jsonl)
- `pdf_qa/config.py` — all settings, env-overridable

## Scaling notes
The store is brute-force cosine over a NumPy matrix — fine for these books
(~1,100 pages). For a much larger corpus, swap `store.py` for FAISS or Chroma;
the interface is intentionally small. The current design keeps everything local
except the OpenAI API calls.

## Validation status
Ingestion (render + text-extraction + OCR fallback + chunking + store write) was
verified on all three sample PDFs. The embedding and GPT-4o answering steps
require your `OPENAI_API_KEY` and are run on your machine.
```
```
