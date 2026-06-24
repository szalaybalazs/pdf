import React, { useEffect } from "react";
import { useStore, store, activeThread, newThread, closeSettings, openSettings } from "./store";
import { Sidebar } from "./components/Sidebar";
import { Chat } from "./components/Chat";
import { Inspector } from "./components/Inspector";
import { Settings } from "./components/Settings";

function HeaderSpinner() {
  return (
    <span
      className="h-[12px] w-[12px] shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-tint"
      aria-label="Working"
      title="Working"
    />
  );
}

function AppHeader() {
  const thread = activeThread();
  const working = !store.ready || !!store.ingest.text || !!thread?.busy;
  const title = thread?.title || "New chat";
  const status = store.statusErr ? store.status : store.ready ? store.status : "Connecting";

  return (
    <header className="app-drag flex h-[38px] shrink-0 items-center border-b border-border bg-surface px-3">
      <div className="flex w-[256px] min-w-[256px] items-center gap-2 pl-[66px]">
        <span className="text-[12.5px] font-semibold text-ink">pdf<span className="text-tint">_qa</span></span>
      </div>
      <div className="flex min-w-0 flex-1 items-center justify-center px-6">
        <div className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-[12.5px] font-medium text-muted">
          {title}
        </div>
      </div>
      <div className={`flex w-[280px] min-w-[280px] items-center justify-end gap-2 overflow-hidden text-[11.5px] ${store.statusErr ? "text-danger" : "text-faint"}`}>
        {working && <HeaderSpinner />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{status}</span>
      </div>
    </header>
  );
}

export function App() {
  useStore();   // re-render on any store change

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
        e.preventDefault();
        newThread();
      }
      if (e.key === "Escape" && store.settingsOpen) closeSettings();
    };
    const onNewThread = () => newThread();
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
      <AppHeader />
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <Sidebar />
        <Chat />
        <Inspector />
      </div>
      {store.settingsOpen && <Settings />}
    </div>
  );
}
