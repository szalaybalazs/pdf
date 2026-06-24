# PDF QA — desktop app (Electron + TypeScript)

A desktop shell around the Python `pdf_qa` backend. It shows the **same
information as the CLI** — a live tool-call trace (embed → search →
collect_pages → gpt-4o) with timings and an optional debug view — and renders
answers whose **figures are underlined; clicking one opens the page image in
your OS default viewer**. Supports **multiple chat threads**.

## Architecture

```
┌──────────────── Electron (TypeScript) ───────────────┐
│  renderer (renderer.ts)   ⇄  main (main.ts)           │
│   · threads, trace UI         · spawns python backend │      ┌─ Python ─────────┐
│   · clickable figures         · IPC bridge        ───────────►  pdf_qa.serve     │
│                               · shell.openPath()      │      │  (JSON over stdio)│
└───────────────────────────────────────────────────────┘      │  reuses pipeline  │
                                                                └───────────────────┘
```

The renderer never touches Node directly — `preload.ts` exposes a tiny, safe
`window.api`. The main process spawns `python -m pdf_qa.serve` and streams its
line-delimited JSON events (`ready` / `tool` / `answer` / `error` / `threads` /
`thread_title` / `thread_results`) to the UI. Each query sends that thread's
history, so answering stays stateless; the threads themselves are now **persisted
in SQLite by the backend** (see below).

## Data directory

All app data lives under Electron's per-user directory
(`app.getPath('userData')` — e.g. `~/Library/Application Support/pdf_qa/` on
macOS). The main process passes it to Python as `PDF_QA_DATA_DIR`. Inside:

- `index/` — page renders (`pages/<doc>/p####.png`) + the PDF vector store
  (`store.npy` / `store.jsonl`).
- `threads.db` — SQLite store of chat threads, messages, and per-thread search
  embeddings (powers the sidebar **Search chats** box).
- `settings.json` — API keys set via the in-app **Settings** (gear icon), encrypted
  with Electron `safeStorage`. These override any `.env` values.

**Migrating an existing `./index`:** earlier versions wrote the index into the
project's `./index/`. Move it into the new location once with:
```bash
PDF_QA_DATA_DIR="$HOME/Library/Application Support/pdf_qa" python -m pdf_qa.migrate
```
(or just re-run `python -m pdf_qa.ingest` with that same `PDF_QA_DATA_DIR` to
rebuild). Running the bare CLI without `PDF_QA_DATA_DIR` still uses `./index` as
before.

## Prerequisites
1. The Python backend set up and an index built (see the project root README):
   ```bash
   pip install -r ../requirements.txt
   brew install tesseract
   cp ../.env.example ../.env     # add OPENAI_API_KEY
   python -m pdf_qa.ingest        # run from the project root
   ```
2. Node.js 18+.

## Run
```bash
cd app
npm install
npm start            # builds TS then launches Electron
```

If your Python isn't on `python3`, point the app at it:
```bash
PDF_QA_PYTHON=/path/to/python npm start
```

## Scripts
| Script | What it does |
|--------|--------------|
| `npm run build` | compile main + preload + renderer TypeScript to `dist/` |
| `npm run typecheck` | type-check both TS projects without emitting |
| `npm start` | build, then launch Electron |

## Using it
- **New thread** — the ＋ button in the sidebar; switch threads by clicking them, delete with ✕.
- **Thread titles** — after the first answer the chat is auto-summarised into a short label by a small model (`SUMMARY_MODEL`, default `gpt-4o-mini`).
- **Search chats** — the search box above the thread list does *semantic* search across past threads (not just substring), powered by the per-thread embeddings in SQLite.
- **Model picker** — top-right select switches the answerer between OpenAI and Anthropic Opus.
- **Settings** — the gear icon opens a dialog to set the OpenAI and Anthropic API keys (stored encrypted); saving restarts the backend so the new keys take effect.
- **Ask** — type and press Enter (Shift+Enter for a newline).
- **Tool trace** — every answer shows the pipeline steps with timings, exactly like the CLI.
- **debug** — the toggle (top-right) reveals similarity scores, page image dimensions, and token counts; it also asks the backend for that extra detail on subsequent queries.
- **Figures** — citations like *(book p.106)* are underlined, and each answer lists its source pages as chips. Click either to open that page image in your default viewer.

## Files
- `src/main.ts` — Electron main: spawns the backend, bridges JSON↔IPC, injects data dir + keys, opens figures via `shell.openPath`
- `src/settings.ts` — encrypted API-key storage (`safeStorage`) under userData
- `src/preload.ts` — safe `window.api` bridge (contextIsolation on, nodeIntegration off)
- `renderer/index.html` · `renderer/styles.css` — shell + theme (incl. settings modal, search box)
- `renderer/renderer.ts` — threads, live trace, answer rendering, clickable figures, search, settings
- `../pdf_qa/serve.py` — the Python side of the protocol
- `../pdf_qa/threads.py` — SQLite thread store + cross-thread vector search
- `../pdf_qa/migrate.py` — one-time `./index` → data-dir migration

## Validation
Type-checks clean (both TS projects). The renderer was driven through a
simulated DOM (jsdom): status updates, query dispatch, the 4-step trace,
inline-citation linkification, source chips, figure-click → open, and
thread isolation all verified. Launching the Electron window and the live
OpenAI calls happen on your machine.
