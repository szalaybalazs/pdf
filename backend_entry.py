"""PyInstaller entry point for the frozen backend binary.

The Electron app spawns the Python side two ways during normal use:

    python -m pdf_qa.serve              # the long-lived JSON-over-stdio backend
    python -m pdf_qa.ingest --add ...   # one-shot PDF ingestion

A packaged installer has no Python interpreter, so PyInstaller freezes *this*
script into a single executable (``pdf-qa-backend``) that dispatches to the same
two entry points based on its first argument:

    pdf-qa-backend serve
    pdf-qa-backend ingest --add file.pdf --json

All configuration (data dir, index dir, API keys) still comes from the
environment, exactly as it does for the unfrozen `python -m` invocations, so the
Electron main process sets the same env vars regardless of dev vs. packaged.
"""
import sys


def main() -> int:
    if len(sys.argv) < 2:
        print("usage: pdf-qa-backend <serve|ingest> [args...]", file=sys.stderr)
        return 2

    command = sys.argv[1]
    # Re-shape argv so the delegated module sees its own program name + flags,
    # i.e. drop the "serve"/"ingest" selector we just consumed.
    rest = sys.argv[2:]

    if command == "serve":
        from pdf_qa.serve import main as serve_main
        return serve_main(rest)
    if command == "ingest":
        from pdf_qa.ingest import main as ingest_main
        return ingest_main(rest)

    print(f"pdf-qa-backend: unknown command {command!r}", file=sys.stderr)
    return 2


if __name__ == "__main__":
    raise SystemExit(main())
