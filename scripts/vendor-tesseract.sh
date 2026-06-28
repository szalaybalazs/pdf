#!/usr/bin/env bash
#
# Stage a self-contained Tesseract OCR engine into the frozen backend bundle so
# OCR works in packaged installers with no system install. Called by
# build-backend.sh after the PyInstaller bundle is staged; the engine lands at
# app/backend-dist/tesseract/ (-> Resources/backend/tesseract/ once packaged),
# where pdf_qa/ocr.py looks for it.
#
# PyInstaller can only freeze on the target OS, so the build host == the target
# platform. This script therefore only ever vendors Tesseract for the CURRENT
# OS: Homebrew + dylibbundler on macOS, the UB-Mannheim installer on Windows.
#
#   macOS   : downloads via Homebrew, then relocates dylibs with dylibbundler
#             (@executable_path/libs) so the copy is independent of /opt/homebrew.
#   Windows : downloads the pinned UB-Mannheim installer and extracts it with 7z
#             (run under Git Bash / MSYS).
#
# Languages bundled: $PDF_QA_BUNDLE_LANGS (default "eng osd"). Set PDF_QA_SKIP_TESSERACT=1
# to skip vendoring entirely (OCR then relies on a system tesseract, if any).
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DEST="${1:-$ROOT/app/backend-dist/tesseract}"
LANGS="${PDF_QA_BUNDLE_LANGS:-eng osd}"

# Pinned Windows engine (UB-Mannheim). Override WIN_TESS_VERSION / WIN_TESS_URL
# to bump. The asset is the NSIS installer; we extract it rather than run it.
# NOTE: must be a version that exists as a GitHub *release* asset (the newest
# such is v5.4.0.20240606 — later builds live only on digi.bib.uni-mannheim.de;
# point WIN_TESS_URL there if you bump past it).
WIN_TESS_VERSION="${WIN_TESS_VERSION:-5.4.0.20240606}"
WIN_TESS_URL="${WIN_TESS_URL:-https://github.com/UB-Mannheim/tesseract/releases/download/v${WIN_TESS_VERSION}/tesseract-ocr-w64-setup-${WIN_TESS_VERSION}.exe}"

if [ "${PDF_QA_SKIP_TESSERACT:-0}" = "1" ]; then
  echo "==> Skipping Tesseract vendoring (PDF_QA_SKIP_TESSERACT=1)"
  exit 0
fi

rm -rf "$DEST"
mkdir -p "$DEST/tessdata"

# ----------------------------------------------------------------------------
vendor_macos() {
  echo "==> Vendoring Tesseract for macOS"
  command -v brew >/dev/null 2>&1 || { echo "ERROR: Homebrew required on macOS" >&2; exit 1; }
  brew list tesseract >/dev/null 2>&1 || brew install tesseract
  command -v dylibbundler >/dev/null 2>&1 || brew install dylibbundler

  local prefix bin share
  prefix="$(brew --prefix tesseract)"
  bin="$prefix/bin/tesseract"
  share="$prefix/share/tessdata"
  [ -x "$bin" ] || { echo "ERROR: tesseract binary not found at $bin" >&2; exit 1; }

  cp "$bin" "$DEST/tesseract"
  chmod +w "$DEST/tesseract"
  # Gather every non-system dylib next to the binary and rewrite load commands
  # to @executable_path/libs, so the folder is self-contained & relocatable.
  dylibbundler -cd -of -b -x "$DEST/tesseract" -d "$DEST/libs" -p @executable_path/libs

  copy_langs "$share"
  copy_tessdata_extras "$share"
}

# ----------------------------------------------------------------------------
vendor_windows() {
  echo "==> Vendoring Tesseract for Windows ($WIN_TESS_VERSION)"
  command -v 7z >/dev/null 2>&1 || command -v 7z.exe >/dev/null 2>&1 || {
    echo "ERROR: 7-Zip (7z) required to extract the installer. Install via 'choco install 7zip' or 'winget install 7zip.7zip'." >&2
    exit 1
  }
  local tmp installer extract
  tmp="$(mktemp -d)"
  installer="$tmp/tesseract-setup.exe"
  extract="$tmp/extract"

  echo "    downloading $WIN_TESS_URL"
  curl -fL --retry 3 -o "$installer" "$WIN_TESS_URL"
  7z x -y -o"$extract" "$installer" >/dev/null

  [ -f "$extract/tesseract.exe" ] || { echo "ERROR: tesseract.exe not found after extraction" >&2; exit 1; }
  cp "$extract/tesseract.exe" "$DEST/tesseract.exe"
  # All sibling DLLs the engine links against (leptonica, libpng, ...).
  cp "$extract"/*.dll "$DEST/" 2>/dev/null || true

  copy_langs "$extract/tessdata"
  copy_tessdata_extras "$extract/tessdata"
  rm -rf "$tmp"
}

# Copy only the requested traineddata files to keep the bundle small.
copy_langs() {
  local src="$1" lang
  for lang in $LANGS; do
    if [ -f "$src/$lang.traineddata" ]; then
      cp "$src/$lang.traineddata" "$DEST/tessdata/"
      echo "    + $lang.traineddata"
    else
      echo "    ! WARNING: $lang.traineddata not found in $src" >&2
    fi
  done
}

# Tesseract needs its config presets for some operations; copy if present.
copy_tessdata_extras() {
  local src="$1"
  [ -d "$src/configs" ] && cp -R "$src/configs" "$DEST/tessdata/" || true
  [ -d "$src/tessconfigs" ] && cp -R "$src/tessconfigs" "$DEST/tessdata/" || true
}

# ----------------------------------------------------------------------------
case "$(uname -s)" in
  Darwin) vendor_macos ;;
  MINGW*|MSYS*|CYGWIN*) vendor_windows ;;
  *) echo "==> $(uname -s): no Tesseract bundling configured; skipping (OCR will use a system tesseract if present)"; exit 0 ;;
esac

echo "==> Tesseract vendored at $DEST"
du -sh "$DEST" 2>/dev/null | sed 's/^/    /' || true
