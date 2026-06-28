#!/usr/bin/env bash
#
# Freeze the pdf_qa Python backend into a standalone binary with PyInstaller and
# stage it where electron-builder picks it up (app/backend-dist/).
#
# Run from the project root (or anywhere — it cd's to its own repo root):
#     ./scripts/build-backend.sh
#
# Prerequisites: a Python env with the project deps + pyinstaller installed.
#     python -m venv venv && source venv/bin/activate
#     pip install -r requirements.txt pyinstaller
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

PYTHON="${PDF_QA_BUILD_PYTHON:-python3}"

echo "==> Freezing backend with PyInstaller ($PYTHON)"
"$PYTHON" -m PyInstaller --noconfirm --clean pdf_qa_backend.spec

# PyInstaller writes a one-folder bundle to dist/pdf-qa-backend/. Stage a clean
# copy under app/ so electron-builder's extraResources (a relative glob) finds it.
STAGE="$ROOT/app/backend-dist"
echo "==> Staging frozen backend -> $STAGE"
rm -rf "$STAGE"
mkdir -p "$STAGE"
cp -R "$ROOT/dist/pdf-qa-backend/." "$STAGE/"

# Bundle a self-contained Tesseract engine next to the frozen backend so OCR
# works with no system install (see scripts/vendor-tesseract.sh). Skippable via
# PDF_QA_SKIP_TESSERACT=1.
bash "$ROOT/scripts/vendor-tesseract.sh" "$STAGE/tesseract"

echo "==> Done. Frozen backend staged at app/backend-dist/"
ls -1 "$STAGE" | sed 's/^/    /'
