import React, { useEffect, useState } from "react";
import { useStore, store, activeThread, newThread, closeSettings, openSettings } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Inspector } from "./components/Inspector";
import { Settings } from "./components/Settings";
import { APP_NAME } from "../../src/branding";

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
      <div className="flex h-full w-[300px] min-w-[300px] items-center border-r border-border bg-surface px-3 pl-[106px]">
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

export function App() {
  useStore();   // re-render on any store change
  const [environmentOpen, setEnvironmentOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newThread(true);
      }
      if (e.key === "Escape" && store.settingsOpen) closeSettings();
    };
    const onNewThread = () => newThread(true);
    const onOpenSettings = () => openSettings();
    window.addEventListener("keydown", onKey);
    window.addEventListener("pdf-qa-new-thread", onNewThread);
    window.addEventListener("pdf-qa-open-settings", onOpenSettings);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("pdf-qa-new-thread", onNewThread);
      window.removeEventListener("pdf-qa-open-settings", onOpenSettings);
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
    </div>
  );
}
