# -*- mode: python ; coding: utf-8 -*-
"""PyInstaller spec for the frozen pdf_qa backend.

Build with:

    pip install pyinstaller
    pyinstaller --noconfirm --clean pdf_qa_backend.spec

Produces dist/pdf-qa-backend/ — a one-folder bundle (faster startup than
one-file, and friendlier to code-signing each dylib individually for macOS
notarization). The whole folder is shipped into the Electron app under
Resources/backend via electron-builder's extraResources.
"""
from PyInstaller.utils.hooks import collect_all, collect_data_files

datas = []
binaries = []
hiddenimports = []

# Packages that ship data files / dynamic submodules PyInstaller's static
# analysis can miss. collect_all grabs submodules, data and binaries together.
for pkg in ("fitz", "pymupdf", "openai", "anthropic", "sympy", "pint", "PIL", "tqdm", "sentry_sdk"):
    try:
        d, b, h = collect_all(pkg)
        datas += d
        binaries += b
        hiddenimports += h
    except Exception:
        # Not every name resolves on every install (e.g. fitz vs pymupdf); skip.
        pass

# pint ships its unit definitions as package data — required at runtime.
datas += collect_data_files("pint")

hiddenimports += [
    "pdf_qa",
    "pdf_qa.serve",
    "pdf_qa.ingest",
    "pdf_qa.ask",
    "pdf_qa.llm",
    "pdf_qa.store",
    "pdf_qa.threads",
    "pdf_qa.config",
    "pdf_qa.calc",
    "pdf_qa.ocr",
    "pdf_qa.migrate",
    "pytesseract",
    "dotenv",
    "numpy",
]

block_cipher = None

a = Analysis(
    ["backend_entry.py"],
    pathex=["."],
    binaries=binaries,
    datas=datas,
    hiddenimports=hiddenimports,
    hookspath=[],
    hooksconfig={},
    runtime_hooks=[],
    excludes=["tkinter", "matplotlib", "pytest"],
    win_no_prefer_redirects=False,
    win_private_assemblies=False,
    cipher=block_cipher,
    noarchive=False,
)

pyz = PYZ(a.pure, a.zipped_data, cipher=block_cipher)

exe = EXE(
    pyz,
    a.scripts,
    [],
    exclude_binaries=True,
    name="pdf-qa-backend",
    debug=False,
    bootloader_ignore_signals=False,
    strip=False,
    upx=False,
    console=True,           # the app reads its stdout/stderr; keep a console stream
    disable_windowed_traceback=False,
    argv_emulation=False,
    target_arch=None,       # set by build script (e.g. universal2 on mac)
    codesign_identity=None, # signing is done later by electron-builder
    entitlements_file=None,
)

coll = COLLECT(
    exe,
    a.binaries,
    a.datas,
    strip=False,
    upx=False,
    upx_exclude=[],
    name="pdf-qa-backend",
)
