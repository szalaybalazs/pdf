import React, { useEffect, useState } from "react";
import { useStore, store, bump, activeThread, newThread, closeSettings, openSettings, createCollection, deleteCollection, renameCollection, setCollectionLanguage, openLibrarySettings, closeLibrarySettings, addRemoteLibrary, removeRemoteLibrary, renameRemoteLibrary, threadLibraryBadge, libraryLabel } from "./store";
import { api } from "./trpc";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Inspector } from "./components/Inspector";
import { Settings } from "./components/Settings";
import { Viewer } from "./components/Viewer";
import { APP_NAME } from "../../src/branding";
import { OCR_LANGUAGES, DEFAULT_OCR_LANGUAGE } from "../../src/languages";
import { IS_MAC, IS_REMOTE } from "./platform";

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

function SidebarToggleIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <rect x="3" y="4" width="18" height="16" rx="2"></rect>
      <line x1="9" y1="4" x2="9" y2="20"></line>
    </svg>
  );
}

function AppHeader({ sidebarOpen, sidebarDocked, onToggleSidebar, environmentOpen, onToggleEnvironment }: { sidebarOpen: boolean; sidebarDocked: boolean; onToggleSidebar: () => void; environmentOpen: boolean; onToggleEnvironment: () => void }) {
  const thread = activeThread();
  const working = !store.ready || !!store.ingest.text || !!thread?.busy;
  const title = thread?.title || "New chat";
  const status = store.statusErr ? store.status : store.ready ? store.status : "Connecting";
  // Library context for this chat: the thread's used libraries once it has
  // questions, else the active library the next question will use.
  const libBadge = thread && thread.messages.length
    ? threadLibraryBadge(thread)
    : libraryLabel(store.activeCollection);

  return (
    <header className="app-drag window-header flex h-[46px] shrink-0 items-center">
      <div className={`flex h-full items-center gap-2 px-3 ${IS_MAC ? "pl-[86px]" : ""} ${sidebarDocked ? "sidebar-chrome w-[300px] min-w-[300px]" : "main-chrome"}`}>
        <button
          className="app-no-drag relative z-10 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg text-faint transition hover:bg-surface-2 hover:text-ink"
          title={`${sidebarOpen ? "Hide" : "Show"} sidebar (${IS_MAC ? "⌘" : "Ctrl+"}B)`}
          aria-label={`${sidebarOpen ? "Hide" : "Show"} sidebar`}
          aria-pressed={sidebarOpen}
          onClick={onToggleSidebar}
        >
          <SidebarToggleIcon />
        </button>
        {sidebarDocked && <span className="relative z-10 text-[12.5px] font-semibold text-ink/90">{APP_NAME}</span>}
      </div>
      <div className="main-chrome flex h-full min-w-0 flex-1 items-center gap-2 px-7">
        <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium text-faint/80">
          {title}
        </div>
        {libBadge && (
          <span
            className="app-no-drag shrink-0 rounded-md border border-border bg-surface-3 px-1.5 py-0.5 text-[11px] font-medium text-faint"
            title="Library context for this chat"
          >{libBadge}</span>
        )}
      </div>
      <div className={`main-chrome flex h-full items-center justify-end gap-2 overflow-hidden pr-5 text-[11.5px] ${store.statusErr ? "text-danger" : "text-faint"}`}>
        {working && <HeaderSpinner />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{status}</span>
        <button
          className={`app-no-drag ml-2 flex h-[28px] w-[28px] shrink-0 items-center justify-center rounded-lg border text-faint transition hover:bg-surface-2 hover:text-ink ${environmentOpen ? "border-border-strong bg-surface-2 text-ink" : "border-border-strong bg-surface-2"}`}
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

function isMobileViewport(): boolean {
  return typeof window !== "undefined" && window.matchMedia("(max-width: 760px)").matches;
}

function useMobileViewport(): boolean {
  const [mobile, setMobile] = useState(isMobileViewport);

  useEffect(() => {
    const query = window.matchMedia("(max-width: 760px)");
    const update = () => setMobile(query.matches);
    update();
    query.addEventListener("change", update);
    return () => query.removeEventListener("change", update);
  }, []);

  return mobile;
}

function LibraryDialog({ onClose }: { onClose: () => void }) {
  const DEFAULT_REMOTE_URL = "http://localhost:8000";
  const [mode, setMode] = useState<"local" | "remote">("local");
  const [name, setName] = useState("");
  const [language, setLanguage] = useState(DEFAULT_OCR_LANGUAGE);
  const [url, setUrl] = useState(DEFAULT_REMOTE_URL);
  const [secret, setSecret] = useState("");
  const [remoteName, setRemoteName] = useState("");
  const [saving, setSaving] = useState(false);
  const [test, setTest] = useState<{ ok: boolean; msg: string } | null>(null);
  const trimmed = name.trim();
  const inputCls = "w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15";
  // A blank URL falls back to the local index server (main defaults it too).
  const effectiveUrl = url.trim() || DEFAULT_REMOTE_URL;
  const canSubmit = mode === "local" ? !!trimmed : !!trimmed;

  const testConnection = async () => {
    setTest(null);
    const res = await api.testRemote({ url: effectiveUrl, secret });
    if (!res.ok) { setTest({ ok: false, msg: res.error || "Could not connect." }); return; }
    const parts: string[] = [];
    if (typeof res.libraries === "number") parts.push(`${res.libraries} librar${res.libraries === 1 ? "y" : "ies"}`);
    if (typeof res.documents === "number") parts.push(`${res.documents} document${res.documents === 1 ? "" : "s"}`);
    setTest({ ok: true, msg: `Connected${parts.length ? ` · ${parts.join(" · ")} on server` : ""}` });
  };

  const create = async () => {
    if (!canSubmit || saving) return;
    setSaving(true);
    try {
      const ok = mode === "local"
        ? await createCollection(trimmed, language)
        : await addRemoteLibrary({ name: trimmed, url: effectiveUrl, secret, remoteName: remoteName.trim() || trimmed });
      if (ok) onClose();
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

        {/* Local vs remote toggle */}
        <div className="mt-4 flex gap-1 rounded-lg border border-border-strong bg-surface p-1">
          {(["local", "remote"] as const).map((m) => (
            <button
              key={m}
              type="button"
              onClick={() => { setMode(m); setTest(null); }}
              className={`flex-1 rounded-md px-3 py-1.5 text-[12.5px] font-medium capitalize transition ${mode === m ? "bg-bg text-ink shadow-[0_1px_2px_rgba(20,20,18,0.08)]" : "text-muted hover:text-ink"}`}
            >{m}</button>
          ))}
        </div>

        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Name</label>
        <input
          autoFocus
          className={inputCls}
          type="text"
          autoComplete="off"
          spellCheck={false}
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
        />

        {mode === "local" ? (
          <>
            <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Document language</label>
            <select
              className={`${inputCls} cursor-pointer`}
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
          </>
        ) : (
          <>
            <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Server URL</label>
            <input
              className={inputCls}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="http://localhost:8000"
              value={url}
              onChange={(e) => { setUrl(e.target.value); setTest(null); }}
              onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}
            />
            <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Secret <span className="text-faint">(optional)</span></label>
            <input
              className={inputCls}
              type="password"
              autoComplete="off"
              spellCheck={false}
              placeholder="Leave empty for an open server"
              value={secret}
              onChange={(e) => { setSecret(e.target.value); setTest(null); }}
            />
            <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Library on server <span className="text-faint">(optional)</span></label>
            <input
              className={inputCls}
              type="text"
              autoComplete="off"
              spellCheck={false}
              placeholder="Defaults to the name above"
              value={remoteName}
              onChange={(e) => setRemoteName(e.target.value)}
            />
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="rounded-lg border border-border-strong bg-bg px-3 py-1.5 text-[12px] font-medium text-ink transition hover:bg-surface-2 disabled:opacity-50"
                onClick={() => void testConnection()}
              >Test connection</button>
              {test && (
                <span className={`text-[11.5px] ${test.ok ? "text-tint" : "text-danger"}`}>{test.msg}</span>
              )}
            </div>
          </>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-border-strong bg-bg px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2"
            type="button"
            onClick={onClose}
          >Cancel</button>
          <button
            className="rounded-lg border border-tint bg-tint px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            type="submit"
            disabled={!canSubmit || saving}
          >{mode === "remote" ? "Connect" : "Create"}</button>
        </div>
      </form>
    </div>
  );
}

function LibrarySettingsDialog({ name, onClose }: { name: string; onClose: () => void }) {
  const isDefault = name === "default";
  const collection = store.collections.find((c) => c.name === name);
  const isRemote = !!collection?.remote;
  const [newName, setNewName] = useState(name);
  const [busy, setBusy] = useState(false);
  const trimmed = newName.trim();
  const language = collection?.language || DEFAULT_OCR_LANGUAGE;

  // Commit any pending rename, then close. Rename is applied on Done (there's no
  // separate Rename button). On failure the dialog stays open so the status line
  // reason is visible. Remote libraries rename their app-side label only; the
  // server library is untouched.
  const done = async () => {
    if (busy) return;
    if (!isDefault && trimmed && trimmed !== name) {
      setBusy(true);
      try {
        const res = isRemote
          ? await renameRemoteLibrary(name, trimmed)
          : await renameCollection(name, trimmed);
        if (!res) return;   // rename failed — keep the dialog open
      } finally { setBusy(false); }
    }
    onClose();
  };

  return (
    <div
      className="modal-scrim fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div className="w-[420px] max-w-[calc(100vw-48px)] rounded-2xl border border-border-strong bg-bg p-5 shadow-[0_8px_30px_rgba(20,20,18,0.18)]">
        <div className="text-[17px] font-semibold tracking-tight text-ink">Library settings</div>

        <label className="mb-1.5 mt-4 block text-[12px] font-medium text-muted">Name</label>
        <input
          className="w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15 disabled:opacity-60"
          type="text"
          autoComplete="off"
          spellCheck={false}
          disabled={isDefault}
          value={isDefault ? "Default library" : newName}
          onChange={(e) => setNewName(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Escape") onClose();
            if (e.key === "Enter") { e.preventDefault(); void done(); }
          }}
        />
        {isDefault && (
          <p className="mt-1.5 text-[11.5px] leading-snug text-faint">The Default library can’t be renamed.</p>
        )}

        {/* Remote libraries OCR at ingest on the connecting client, not the server,
            so there's no per-library language to set here. */}
        {!isRemote && (
          <>
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
          </>
        )}
        {isRemote && (
          <p className="mt-3 text-[11.5px] leading-snug text-faint">
            Remote library on <span className="text-muted">{collection?.url}</span>. Its index lives on the server.
          </p>
        )}

        <div className="mt-5 flex justify-end">
          <button
            className="rounded-lg border border-tint bg-tint px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            type="button"
            disabled={busy}
            onClick={() => void done()}
          >Done</button>
        </div>
      </div>
    </div>
  );
}

type ConfirmRequest = {
  title: string;
  message: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
};

function ConfirmDialog({ title, message, confirmLabel, danger, onConfirm, onClose }: ConfirmRequest & { onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirmCls = danger
    ? "rounded-lg border border-danger bg-bg px-4 py-2 text-[13px] font-medium text-danger transition hover:bg-danger/10"
    : "rounded-lg border border-tint bg-tint px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90";

  return (
    <div
      className="modal-scrim fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        className="w-[380px] max-w-[calc(100vw-48px)] rounded-2xl border border-border-strong bg-bg p-5 shadow-[0_8px_30px_rgba(20,20,18,0.18)]"
        role="alertdialog"
        aria-modal="true"
      >
        <div className="text-[17px] font-semibold tracking-tight text-ink">{title}</div>
        <p className="mt-2 text-[13px] leading-relaxed text-muted">{message}</p>
        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-border-strong bg-bg px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2"
            type="button"
            onClick={onClose}
          >Cancel</button>
          <button
            autoFocus
            className={confirmCls}
            type="button"
            onClick={() => { onConfirm(); onClose(); }}
          >{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

export function App() {
  useStore();   // re-render on any store change
  const [environmentOpen, setEnvironmentOpen] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(() => !IS_REMOTE || !isMobileViewport());
  const viewportMobile = useMobileViewport();
  const isMobile = IS_REMOTE && viewportMobile;
  const sidebarDocked = sidebarOpen && !isMobile;
  const [creatingLibrary, setCreatingLibrary] = useState(false);
  const [confirm, setConfirm] = useState<ConfirmRequest | null>(null);

  useEffect(() => {
    if (!IS_REMOTE) return;
    document.body.classList.add("web-view-body");
    return () => document.body.classList.remove("web-view-body");
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newThread(true);
      }
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "b") {
        e.preventDefault();
        setSidebarOpen((v) => !v);
      }
      if (e.key === "Escape" && sidebarOpen && isMobile) setSidebarOpen(false);
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
      const isRemote = store.collections.find((c) => c.name === name)?.remote;
      if (isRemote) {
        // A remote library is a saved connection, not on-disk data — "removing"
        // it just disconnects the app; the server keeps the index.
        setConfirm({
          title: "Disconnect library",
          message: `Disconnect the remote library "${name}"? The index stays on the server; switches back to Default.`,
          confirmLabel: "Disconnect",
          onConfirm: () => void removeRemoteLibrary(name),
        });
        return;
      }
      setConfirm({
        title: "Delete library",
        message: `Delete the "${name}" library and its index? Switches back to Default.`,
        confirmLabel: "Delete",
        danger: true,
        onConfirm: () => void deleteCollection(name),
      });
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
  }, [isMobile, sidebarOpen]);

  return (
    <div className={`app-shell flex h-screen flex-col overflow-hidden ${IS_REMOTE ? "web-view" : ""}`}>
      <AppHeader
        sidebarOpen={sidebarOpen}
        sidebarDocked={sidebarDocked}
        onToggleSidebar={() => setSidebarOpen((v) => !v)}
        environmentOpen={environmentOpen}
        onToggleEnvironment={() => setEnvironmentOpen((v) => !v)}
      />
      <div className="app-content flex min-h-0 flex-1 overflow-hidden">
        {sidebarDocked && <Sidebar />}
        {sidebarOpen && isMobile && (
          <div
            className="sidebar-sheet-layer modal-scrim fixed inset-0 z-40"
            onClick={(e) => { if (e.target === e.currentTarget) setSidebarOpen(false); }}
          >
            <Sidebar sheet onRequestClose={() => setSidebarOpen(false)} />
          </div>
        )}
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
      {confirm && (
        <ConfirmDialog
          {...confirm}
          onClose={() => setConfirm(null)}
        />
      )}
      <Viewer />
    </div>
  );
}
