import React, { useState } from "react";
import {
  store, activeThread, visibleThreads, newThread, selectThread, deleteThread,
  setSearchQuery, addPdfs, openDoc, showDocMenu,
} from "../store";

function SearchIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="11" cy="11" r="8"></circle>
      <path d="m21 21-4.35-4.35"></path>
    </svg>
  );
}

function PlusIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="12" y1="5" x2="12" y2="19"></line><line x1="5" y1="12" x2="19" y2="12"></line>
    </svg>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg className={`transition ${open ? "transform" : ""}`} style={{ transform: open ? "rotate(90deg)" : "rotate(0deg)" }} width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
      <polyline points="9 18 15 12 9 6"></polyline>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M14 2v6h6"></path>
    </svg>
  );
}

function XIcon() {
  return (
    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
      <path d="M18 6 6 18"></path>
      <path d="m6 6 12 12"></path>
    </svg>
  );
}

function SidebarSpinner() {
  return (
    <span
      className="h-[13px] w-[13px] shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-tint"
      aria-label="Working"
      title="Working"
    />
  );
}

const iconBtn = "flex h-[24px] w-[24px] items-center justify-center rounded-md text-faint transition-colors hover:bg-surface-2 hover:text-ink";

export function Sidebar() {
  const [docsOpen, setDocsOpen] = useState(true);
  const threads = visibleThreads();
  const searching = store.searchResults !== null;
  const working = !store.ready || !!store.ingest.text || !!activeThread()?.busy;

  return (
    <aside className="flex w-[256px] min-w-[256px] flex-col border-r border-border bg-surface px-2 py-2">
      <div className="relative mb-1.5">
        <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-faint"><SearchIcon /></span>
        <input
          className="h-[30px] w-full rounded-md border border-border bg-bg pl-8 pr-2.5 text-[12.5px] text-ink outline-none transition placeholder:text-faint focus:border-tint focus:ring-[3px] focus:ring-tint/15"
          type="search" placeholder="Search chats"
          value={store.searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </div>

      <button
        className="mb-2 flex h-[30px] w-full items-center justify-center gap-1.5 rounded-md border border-border bg-bg px-2.5 text-[12.5px] font-medium text-ink shadow-[0_1px_2px_rgba(20,20,18,0.04)] transition hover:bg-surface-2 active:scale-95"
        title="New chat (⌘N)"
        onClick={() => newThread()}
      >
        <PlusIcon />
        <span>New chat</span>
      </button>

      <div className="mb-0.5 px-2 text-[10.5px] font-semibold uppercase text-faint">Chats</div>
      <ul className="min-h-[40px] flex-1 list-none overflow-y-auto pr-1">
        {searching && threads.length === 0 && <li className="px-2.5 py-2 text-[12.5px] text-faint">No matching chats</li>}
        {threads.map((t) => {
          const active = t.id === store.activeId;
          return (
            <li
              key={t.id}
              className={`group mb-px flex h-[28px] cursor-pointer items-center gap-2 rounded-md pl-2.5 pr-1.5 text-[12.5px] transition-colors ${active ? "bg-bg font-medium text-ink shadow-[0_1px_2px_rgba(20,20,18,0.04)]" : "text-muted hover:bg-surface-2 hover:text-ink"}`}
              onClick={() => selectThread(t.id)}
            >
              <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t.title}</span>
              <button
                className="flex h-[20px] w-[20px] items-center justify-center rounded text-faint opacity-0 transition-opacity hover:!text-danger hover:bg-surface-2 group-hover:opacity-70"
                title="Delete chat"
                onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}
              ><XIcon /></button>
            </li>
          );
        })}
      </ul>

      <div className="mt-2 flex items-center gap-1 border-t border-border px-1 pb-1 pt-2">
        <button
          className="flex h-[24px] min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 text-left text-[10.5px] font-semibold uppercase text-faint transition hover:bg-surface-2 hover:text-muted"
          title={docsOpen ? "Collapse documents" : "Expand documents"}
          onClick={() => setDocsOpen((v) => !v)}
        >
          <ChevronIcon open={docsOpen} />
          <span className="overflow-hidden text-ellipsis whitespace-nowrap">Documents · {store.docs.length}</span>
        </button>
        <button
          className={iconBtn}
          title="Add PDFs to the index" onClick={() => void addPdfs()}
        ><PlusIcon /></button>
      </div>

      {docsOpen && (
        <ul className="max-h-[26vh] list-none overflow-y-auto pr-1">
          {store.docs.length === 0 && <li className="px-2.5 py-1.5 text-[12px] text-faint">No PDFs indexed</li>}
          {store.docs.map((d) => (
            <li
              key={d}
              className="flex h-[26px] cursor-default items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted transition-colors hover:bg-surface-2 hover:text-ink"
              title={`${d}\n(double-click to open · right-click for options)`}
              onDoubleClick={() => openDoc(d)}
              onContextMenu={(e) => { e.preventDefault(); showDocMenu(d); }}
            >
              <span className="shrink-0 text-faint"><FileIcon /></span>
              <span className="overflow-hidden text-ellipsis whitespace-nowrap">{d.replace(/\.pdf$/i, "")}</span>
            </li>
          ))}
        </ul>
      )}

      {store.ingest.text && (
        <div className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-[11.5px] text-tint">{store.ingest.text}</div>
      )}
      {store.ingest.percent !== null && (
        <div className="mx-2 mb-1.5 mt-0.5 h-[4px] overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-tint transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, store.ingest.percent))}%` }} />
        </div>
      )}

      <div className={`mt-1.5 flex items-center gap-2 border-t border-border px-2 pt-2 font-mono text-[10.5px] ${store.statusErr ? "text-danger" : "text-faint"}`}>
        {working && <SidebarSpinner />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{store.status}</span>
      </div>
    </aside>
  );
}
