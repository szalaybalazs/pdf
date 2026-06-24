"""Interactive multimodal chat over the indexed PDFs.

A Claude Code-style REPL: colored output, a live tool-call trace
(embed → search → collect pages → gpt-4o) with timings, slash commands,
follow-up memory, and an optional debug view.

Run:
    python -m pdf_qa.ask                      # interactive chat
    python -m pdf_qa.ask "your question"      # one-shot
    python -m pdf_qa.ask --debug              # start with debug trace on
"""
from __future__ import annotations

import argparse
import os
import sys

from . import config, ui
from .store import VectorStore

HELP = """\
Commands:
  /debug      toggle debug trace (scores, tokens, image details)
  /sources    show sources cited in the last answer
  /clear      forget conversation history (start fresh)
  /help       show this help
  /quit       exit  (also: /exit, Ctrl-D)
Anything else is treated as a question. Follow-ups remember the last few turns.
"""

MAX_HISTORY_TURNS = 4  # how many prior Q&A pairs to keep for follow-ups


class Chat:
    def __init__(self, store: VectorStore, debug: bool = False):
        self.store = store
        self.debug = debug
        self.history: list[dict] = []   # [{role, content}] text-only turns
        self.last_sources: list[str] = []

    # --- pipeline ----------------------------------------------------------
    def run_query(self, question: str) -> None:
        from .llm import answer, embed_query

        # 1) embed the question
        with ui.ToolCall("embed_query", f'model={config.EMBED_MODEL}') as tc:
            qvec = embed_query(question)
            tc.log(f"1 vector · dim {len(qvec)}")

        # 2) similarity search
        with ui.ToolCall("search", f"top_k={config.TOP_K}") as tc:
            hits = self.store.search(qvec, config.TOP_K)
            docs = {c.doc for c, _ in hits}
            tc.log(f"{len(hits)} chunks from {len(docs)} doc(s)")
            if self.debug:
                for c, s in hits:
                    snippet = " ".join(c.text.split())[:60]
                    tc.log(f"{s:0.3f}  {c.doc[:22]} p.{c.page}  “{snippet}…”")

        # 3) collect the distinct page images behind those chunks
        contexts = [{"doc": c.doc, "page": c.page, "text": c.text} for c, _ in hits]
        image_paths, seen = [], set()
        for c, _ in hits:
            if c.image_path not in seen:
                seen.add(c.image_path)
                image_paths.append(c.image_path)
            if len(image_paths) >= config.MAX_IMAGES:
                break
        self.last_sources = [f"{c.doc} p.{c.page}" for c, _ in hits[: len(image_paths)]]

        with ui.ToolCall("collect_pages", f"max={config.MAX_IMAGES}") as tc:
            tc.log(", ".join(self.last_sources))
            if self.debug:
                for p in image_paths:
                    tc.log(_image_info(p))

        # 4) multimodal answer
        with ui.ToolCall("gpt-4o", f"model={config.VISION_MODEL}") as tc:
            result = answer(question, contexts, image_paths, history=self.history)
            u = result.get("usage", {})
            tc.log(f"{result['n_images']} image(s) sent")
            if self.debug and u:
                tc.log(f"tokens: {u.get('prompt')} prompt + "
                       f"{u.get('completion')} completion = {u.get('total')}")

        # 5) print the answer
        print()
        print(ui.c("● ", "brightgreen") + _format_answer(result["text"]))
        print()

        # 6) remember this turn (text only — images are not re-sent)
        self.history.append({"role": "user", "content": question})
        self.history.append({"role": "assistant", "content": result["text"]})
        self.history = self.history[-2 * MAX_HISTORY_TURNS:]

    # --- commands ----------------------------------------------------------
    def command(self, line: str) -> bool:
        """Handle a /command. Returns False if the loop should exit."""
        cmd = line.strip().lower()
        if cmd in {"/quit", "/exit"}:
            return False
        if cmd == "/help":
            print(ui.dim(HELP))
        elif cmd == "/debug":
            self.debug = not self.debug
            print(ui.dim(f"debug trace {'ON' if self.debug else 'OFF'}"))
        elif cmd == "/sources":
            if self.last_sources:
                print(ui.dim("Last answer used: " + ", ".join(self.last_sources)))
            else:
                print(ui.dim("No question asked yet."))
        elif cmd == "/clear":
            self.history.clear()
            print(ui.dim("Conversation history cleared."))
        else:
            print(ui.err(f"Unknown command: {line}  (try /help)"))
        return True


def _image_info(path: str) -> str:
    try:
        from PIL import Image
        size_kb = os.path.getsize(path) / 1024
        with Image.open(path) as im:
            w, h = im.size
        name = os.path.basename(path)
        return f"{name}  {w}×{h}px  {size_kb:0.0f} KB"
    except Exception:
        return os.path.basename(path)


def _format_answer(text: str) -> str:
    """Light touch: highlight inline source citations like (file p.12)."""
    import re
    if not ui._ENABLED:
        return text
    return re.sub(r"\(([^()]*?p\.\s?\d+)\)",
                  lambda m: ui.c(m.group(0), "cyan"), text)


def main(argv=None):
    ap = argparse.ArgumentParser(description="Interactive multimodal chat over indexed PDFs.")
    ap.add_argument("question", nargs="*", help="Question (omit for interactive chat).")
    ap.add_argument("--debug", action="store_true", help="Start with the debug trace enabled.")
    args = ap.parse_args(argv)

    try:
        store = VectorStore.load(config.STORE_PATH)
    except FileNotFoundError:
        print(ui.err("No index found. Run `python -m pdf_qa.ingest` first."), file=sys.stderr)
        return 1

    chat = Chat(store, debug=args.debug)

    # one-shot mode
    if args.question:
        chat.run_query(" ".join(args.question))
        return 0

    try:
        import readline  # noqa: F401 — enables line editing + history for input()
    except Exception:
        pass

    docs = sorted({c.doc for c in store.chunks})
    ui.banner("pdf_qa · multimodal chat",
              f"{len(store)} chunks · {len(docs)} document(s) · {config.VISION_MODEL}")
    print(ui.dim("Ask a question. /help for commands, /quit to exit.\n"))

    while True:
        # Read a line. Ctrl-C cancels the current line (does NOT exit); only a real
        # EOF (Ctrl-D / closed stdin) or /quit ends the session.
        try:
            line = input(ui.user_prompt()).strip()
        except KeyboardInterrupt:
            print(ui.dim("  (^C — type /quit to exit)"))
            continue
        except EOFError:
            print()
            break

        if not line:
            continue
        if line.startswith("/"):
            if not chat.command(line):
                break
            continue

        # A failure or Ctrl-C *during* a query must never drop us out of the chat.
        try:
            chat.run_query(line)
        except KeyboardInterrupt:
            print(ui.dim("\n  (cancelled)"))
        except BaseException as e:  # noqa: BLE001 — keep the REPL alive no matter what
            print(ui.err(f"Error: {e}"))
            if chat.debug:
                import traceback
                traceback.print_exc()

    print(ui.dim("Bye."))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
