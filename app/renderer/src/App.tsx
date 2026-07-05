import React, { useEffect, useState } from "react";
import { useStore, store, bump, activeThread, newThread, closeSettings, openSettings, createCollection, deleteCollection, renameCollection, setCollectionLanguage, openLibrarySettings, closeLibrarySettings } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Inspector } from "./components/Inspector";
import { Settings } from "./components/Settings";
import { Viewer } from "./components/Viewer";
import { APP_NAME } from "../../src/branding";
import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from "../../src/languages";
import { IS_MAC } from "./platform";

function HeaderSpinner() {
  return (
    <span
      className="h-[12px] w-[12px] shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-tint"
      aria-label="Working"
      title="Working"
    />
  );
}

function InfoIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="9"></circle>
      <path d="M12 11v5"></path>
      <path d="M12 8h.01"></path>
    </svg>
  );
}

function AppHeader({ environmentOpen, onToggleEnvironment }: { environmentOpen: boolean; onToggleEnvironment: () => void }) {
  const thread = activeThread();
  const working = !store.ready || !!store.ingest.text || !!thread?.busy;
  const title = thread?.title || "New chat";
  const status = store.statusErr ? store.status : store.ready ? store.status : "Connecting";

  return (
    <header className="app-drag window-header flex h-[46px] shrink-0 items-center border-b border-border">
      <div className={`flex h-full w-[300px] min-w-[300px] items-center border-r border-border bg-surface px-3 ${IS_MAC ? "pl-[106px]" : ""}`}>
        <span className="text-[12.5px] font-semibold text-ink">{APP_NAME}</span>
      </div>
      <div className="flex min-w-0 flex-1 items-center px-5">
        <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[14px] font-semibold text-ink">
          {title}
        </div>
      </div>
      <div className={`flex items-center justify-end gap-2 overflow-hidden pr-4 text-[11.5px] ${store.statusErr ? "text-danger" : "text-faint"}`}>
        {working && <HeaderSpinner />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{status}</span>
        <button
          className={`app-no-drag ml-2 flex h-[30px] w-[30px] shrink-0 items-center justify-center rounded-lg border text-muted shadow-[0_1px_2px_rgba(20,20,18,0.04)] transition hover:bg-surface-2 hover:text-ink ${environmentOpen ? "border-border-strong bg-surface-2 text-ink" : "border-border bg-bg"}`}
          title="Environment"
          aria-label="Toggle environment side sheet"
          aria-pressed={environmentOpen}
          onClick={onToggleEnvironment}
        >
          <InfoIcon />
        </button>
      </div>
    </header>
  );
}

function LibraryDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState("");
  const [language, setLanguage] = useState(DEFAULT_OCR_LANGUAGE);
  const [saving, setSaving] = useState(false);
  const trimmed = name.trim();

  const create = async () => {
    if (!trimmed || saving) return;
    setSaving(true);
    try {
      if (await createCollection(trimmed, language)) onClose();
    } finally {
      setSaving(false);
    }
  };

  return (
    <div
      className="modal-scrim fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <form
        className="w-[380px] max-w-[calc(100vw-48px)] rounded-2xl border border-border-strong bg-bg p-5 shadow-[0_8px_30px_rgba(20,20,18,0.18)]"
        onSubmit={(e) => { e.preventDefault(); void create(); }}
      >
        <div className="text-[17px] font-semibold tracking-tight text-ink">New Library</div>
        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Name</label>
        <input
          autoFocus
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15"
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        />
        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Document language</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15"
          value={language}
          onChange={(e) => setLanguage(e.target.value)}
        >
          {OCR_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
        <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
          Used to read scanned or image-only pages (OCR) in this library.
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-border-strong bg-bg px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2"
            type="button"
            onClick={onClose}
          >Cancel</button>
          <button
            className="rounded-lg border border-tint bg-tint px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            type="submit"
            disabled={!trimmed || saving}
          >Create</button>
        </div>
      </form>
    </div>
  );
}

function LibrarySettingsDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const isDefault = name === "default";
  const collection = store.collections.find((c) => c.name === name);
  const [newName, setNewName] = useState(name);
  const [busy, setBusy] = useState(false);
  const trimmed = newName.trim();
  const language = collection?.language || DEFAULT_OCR_LANGUAGE;
  const canRename = !isDefault && !!trimmed && trimmed !== name && !busy;

  const doRename = async () => {
    if (!canRename) return;
    setBusy(true);
    try { await renameCollection(name, trimmed); } finally { setBusy(false); }
  };

  return (
    <div
      className="modal-scrim fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[420px] max-w-[calc(100vw-48px)] rounded-2xl border border-border-strong bg-bg p-5 shadow-[0_8px_30px_rgba(20,20,18,0.18)]">
        <div className="text-[17px] font-semibold tracking-tight text-ink">Library settings</div>

        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Name</label>
        <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); void doRename(); }}>
          <input
            className="min-w-0 flex-1 rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15 disabled:opacity-60"
            type="text"
            autoComplete="off"
            spellCheck={false}
            disabled={isDefault}
            value={isDefault ? "Default library" : newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
          />
          <button
            className="shrink-0 rounded-lg border border-border-strong bg-bg px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2 disabled:opacity-50"
            type="submit"
            disabled={!canRename}
          >Rename</button>
        </form>
        {isDefault && (
          <p className="mt-1.5 text-[11.5px] leading-snug text-faint">The Default library can’t be renamed.</p>
        )}

        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Document language</label>
        <select
          className="w-full cursor-pointer rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15"
          value={language}
          onChange={(e) => void setCollectionLanguage(name, e.target.value)}
        >
          {OCR_LANGUAGES.map((l) => (
            <option key={l.code} value={l.code}>{l.label}</option>
          ))}
        </select>
        <p className="mt-1.5 text-[11.5px] leading-snug text-faint">
          Used to read scanned or image-only pages (OCR) in this library. Applies to PDFs added from now on.
        </p>

        <div className="mt-5 flex justify-end">
          <button
            className="rounded-lg border border-tint bg-tint px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90"
            type="button"
            onClick={onClose}
          >Done</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  useStore();   // re-render on any store change
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [creatingLibrary, setCreatingLibrary] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newThread(true);
      }
      if (e.key === "Escape" && store.settingsOpen) closeSettings();
      if (e.key === "Escape" && store.librarySettings !== null) closeLibrarySettings();
    };
    const onNewThread = () => newThread(true);
    const onOpenSettings = () => openSettings();
    const onNewLibrary = () => setCreatingLibrary(true);
    const onLibrarySettings = () => openLibrarySettings();
    const onDeleteLibrary = () => {
      const name = store.activeCollection;
      if (name === "default") {
        store.status = "The Default library can't be deleted.";
        store.statusErr = true;
        bump();
        return;
      }
      if (window.confirm(`Delete the "${name}" library and its index? Switches back to Default.`)) {
        void deleteCollection(name);
      }
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("pdf-qa-new-thread", onNewThread);
    window.addEventListener("pdf-qa-open-settings", onOpenSettings);
    window.addEventListener("pdf-qa-new-library", onNewLibrary);
    window.addEventListener("pdf-qa-library-settings", onLibrarySettings);
    window.addEventListener("pdf-qa-delete-library", onDeleteLibrary);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pdf-qa-new-thread", onNewThread);
      window.removeEventListener("pdf-qa-open-settings", onOpenSettings);
      window.removeEventListener("pdf-qa-new-library", onNewLibrary);
      window.removeEventListener("pdf-qa-library-settings", onLibrarySettings);
      window.removeEventListener("pdf-qa-delete-library", onDeleteLibrary);
    };
  }, []);

  return (
    <div className="flex h-screen flex-col overflow-hidden bg-bg">
      <AppHeader
        environmentOpen={environmentOpen}
        onToggleEnvironment={() => setEnvironmentOpen((v) => !v)}
      />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <Chat />
          {environmentOpen && <Inspector onClose={() => setEnvironmentOpen(false)} />}
        </div>
      </div>
      {store.settingsOpen && <Settings />}
      {creatingLibrary && <LibraryDialog onClose={() => setCreatingLibrary(false)} />}
      {store.librarySettings !== null && (
        <LibrarySettingsDialog
          key={store.librarySettings}
          name={store.librarySettings}
          onClose={closeLibrarySettings}
        />
      )}
      <Viewer />
    </div>
  );
}
