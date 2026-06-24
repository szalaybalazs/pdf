# pdf_qa — desktop app (Electron + TypeScript)

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
line-delimited JSON events (`ready` / `tool` / `answer` / `error`) to the UI.
Threads are UI state; each query sends that thread's history, so the backend
stays stateless and threads never bleed into each other.

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
- **Ask** — type and press Enter (Shift+Enter for a newline).
- **Tool trace** — every answer shows the pipeline steps with timings, exactly like the CLI.
- **debug** — the toggle (top-right) reveals similarity scores, page image dimensions, and token counts; it also asks the backend for that extra detail on subsequent queries.
- **Figures** — citations like *(book p.106)* are underlined, and each answer lists its source pages as chips. Click either to open that page image in your default viewer.

## Files
- `src/main.ts` — Electron main: spawns the backend, bridges JSON↔IPC, opens figures via `shell.openPath`
- `src/preload.ts` — safe `window.api` bridge (contextIsolation on, nodeIntegration off)
- `renderer/index.html` · `renderer/styles.css` — shell + dark theme
- `renderer/renderer.ts` — threads, live trace, answer rendering, clickable figures
- `../pdf_qa/serve.py` — the Python side of the protocol

## Validation
Type-checks clean (both TS projects). The renderer was driven through a
simulated DOM (jsdom): status updates, query dispatch, the 4-step trace,
inline-citation linkification, source chips, figure-click → open, and
thread isolation all verified. Launching the Electron window and the live
OpenAI calls happen on your machine.
