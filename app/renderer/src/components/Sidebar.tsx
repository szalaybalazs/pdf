import React, { useState } from "react";
import {
  store, activeThread, visibleThreads, newThread, selectThread, deleteThread,
  setSearchQuery, addPdfs, openDoc, showDocMenu, openSettings,
  docEnabled, enabledDocs, setDocEnabled, threadDocs,
  installUpdate, showThreadMenu, ingestFiles,
  switchCollection,
} from "../store";
import type { Thread } from "../types";
import { SEP } from "../platform";

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

function FolderIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M3 7.5A2.5 2.5 0 0 1 5.5 5H10l2 2h6.5A2.5 2.5 0 0 1 21 9.5v7A2.5 2.5 0 0 1 18.5 19h-13A2.5 2.5 0 0 1 3 16.5z"></path>
    </svg>
  );
}

function EditIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M12 20h9"></path>
      <path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L7 19l-4 1 1-4Z"></path>
    </svg>
  );
}

function SettingsIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <circle cx="12" cy="12" r="3"></circle>
      <path d="M19.4 15a1.7 1.7 0 0 0 .34 1.88l.04.04a2 2 0 1 1-2.83 2.83l-.04-.04a1.7 1.7 0 0 0-1.88-.34 1.7 1.7 0 0 0-1.03 1.56V21a2 2 0 0 1-4 0v-.07a1.7 1.7 0 0 0-1.03-1.56 1.7 1.7 0 0 0-1.88.34l-.04.04a2 2 0 1 1-2.83-2.83l.04-.04A1.7 1.7 0 0 0 4.6 15a1.7 1.7 0 0 0-1.56-1.03H3a2 2 0 0 1 0-4h.04A1.7 1.7 0 0 0 4.6 8.94a1.7 1.7 0 0 0-.34-1.88l-.04-.04a2 2 0 1 1 2.83-2.83l.04.04a1.7 1.7 0 0 0 1.88.34H9a1.7 1.7 0 0 0 1-1.56V3a2 2 0 0 1 4 0v.01a1.7 1.7 0 0 0 1.03 1.56 1.7 1.7 0 0 0 1.88-.34l.04-.04a2 2 0 1 1 2.83 2.83l-.04.04a1.7 1.7 0 0 0-.34 1.88V9a1.7 1.7 0 0 0 1.56 1.03H21a2 2 0 0 1 0 4h-.04A1.7 1.7 0 0 0 19.4 15Z"></path>
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

function DownloadIcon() {
  return (
    <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"></path>
      <polyline points="7 10 12 15 17 10"></polyline>
      <line x1="12" y1="15" x2="12" y2="3"></line>
    </svg>
  );
}

function BranchIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <path d="M6 3v6a6 6 0 0 0 6 6h6"></path>
      <path d="m15 12 3 3-3 3"></path>
    </svg>
  );
}

/** Shows download progress, then a "Restart to update" action once an update has
 *  finished downloading in the background. Hidden when no update is pending. */
function UpdateBanner() {
  const u = store.update;
  if (!u) return null;

  if (u.status === "downloaded") {
    return (
      <button
        className="mt-2 flex h-[34px] w-full items-center gap-2 rounded-lg border border-tint/40 bg-tint-soft px-2.5 text-[13px] font-medium text-tint-strong transition hover:bg-tint/15"
        title={`Version ${u.version ?? ""} downloaded — restart to apply`}
        onClick={() => installUpdate()}
      >
        <DownloadIcon />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">
          Restart to update{u.version ? ` to ${u.version}` : ""}
        </span>
      </button>
    );
  }

  if (u.status === "available" || u.status === "downloading") {
    const pct = u.status === "downloading" && typeof u.percent === "number" ? ` ${u.percent}%` : "";
    return (
      <div
        className="mt-2 flex h-[30px] w-full items-center gap-2 rounded-lg px-2.5 text-[12px] text-faint"
        title="An update is downloading in the background"
      >
        <span className="h-[13px] w-[13px] shrink-0 animate-spin rounded-full border-2 border-border-strong border-t-tint" />
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">Downloading update{pct}…</span>
      </div>
    );
  }

  return null;   // "error" — stay quiet in the sidebar (logged in main.log)
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

const iconBtn = "flex h-[24px] w-[24px] items-center justify-center rounded-md text-faint transition-colors hover:bg-bg hover:text-ink";
const navRow = "flex h-[34px] w-full items-center gap-2 rounded-lg px-2.5 text-left text-[13.5px] text-muted transition hover:bg-bg hover:text-ink";

interface ThreadGroup { label: string; threads: Thread[]; }

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function daysAgo(timestamp: number, now = new Date()): number {
  const then = new Date(timestamp);
  return Math.floor((startOfDay(now).getTime() - startOfDay(then).getTime()) / 86_400_000);
}

function threadTime(t: Thread): number {
  return t.updatedAt || t.createdAt || 0;
}

function threadGroupLabel(t: Thread): string {
  const age = daysAgo(threadTime(t));
  if (age <= 0) return "Today";
  if (age === 1) return "Yesterday";
  if (age <= 7) return "Last week";
  if (age <= 31) return "Last month";
  if (age <= 365) return "This year";
  return "Older";
}

function groupThreadsByDate(threads: Thread[]): ThreadGroup[] {
  const labels = ["Today", "Yesterday", "Last week", "Last month", "This year", "Older"];
  const groups = new Map<string, Thread[]>();
  for (const t of threads) {
    const label = threadGroupLabel(t);
    groups.set(label, [...(groups.get(label) || []), t]);
  }
  return labels
    .map((label) => ({ label, threads: groups.get(label) || [] }))
    .filter((group) => group.threads.length > 0);
}

/** Ingest progress. When one or more PDFs are being indexed, each gets its own
 *  row + bar so concurrent ingests are visible; otherwise falls back to the
 *  single status line (used by remove/temp-doc messages). */
function IngestProgress() {
  const files = ingestFiles();
  if (files.length > 0) {
    return (
      <div className="mt-1 max-h-[22vh] space-y-1.5 overflow-y-auto px-2 py-1.5">
        {files.map((f) => {
          const isErr = f.phase === "error";
          const isSkip = f.phase === "skip";
          const isDone = f.phase === "done";
          const right = isErr ? "failed" : isSkip ? f.detail
            : isDone ? "✓" : `${Math.round(f.percent)}%`;
          return (
            <div key={f.name} title={`${f.name}${f.detail ? ` — ${f.detail}` : ""}`}>
              <div className="flex items-center gap-1.5 text-[11px]">
                <span className="min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-muted">
                  {f.name.replace(/\.pdf$/i, "")}
                </span>
                <span className={`shrink-0 font-mono text-[10px] ${isErr ? "text-danger" : isDone ? "text-tint-strong" : "text-faint"}`}>
                  {right}
                </span>
              </div>
              {!isSkip && (
                <div className="mt-0.5 h-[3px] overflow-hidden rounded-full bg-surface-3">
                  <div
                    className={`h-full rounded-full transition-[width] duration-300 ${isErr ? "bg-danger" : "bg-tint"}`}
                    style={{ width: `${Math.max(0, Math.min(100, f.percent))}%` }}
                  />
                </div>
              )}
              {f.eta && !isErr && !isDone && (
                <div className="mt-0.5 text-right font-mono text-[9.5px] text-faint">{f.eta}</div>
              )}
            </div>
          );
        })}
      </div>
    );
  }
  return (
    <>
      {store.ingest.text && (
        <div className="overflow-hidden text-ellipsis whitespace-nowrap px-2 py-1.5 text-[11.5px] text-tint">{store.ingest.text}</div>
      )}
      {store.ingest.percent !== null && (
        <div className="mx-2 mb-1.5 mt-0.5 h-[4px] overflow-hidden rounded-full bg-surface-3">
          <div className="h-full rounded-full bg-tint transition-[width] duration-300" style={{ width: `${Math.max(0, Math.min(100, store.ingest.percent))}%` }} />
        </div>
      )}
    </>
  );
}

export function Sidebar() {
  const [docsOpen, setDocsOpen] = useState(true);
  const threads = visibleThreads();
  const threadGroups = groupThreadsByDate(threads);
  const searching = store.searchResults !== null;
  const working = !store.ready || !!store.ingest.text || !!activeThread()?.busy;
  const docs = threadDocs();
  const enabledCount = enabledDocs().length;

  return (
    <aside className="relative z-30 flex min-h-0 w-[300px] min-w-[300px] shrink-0 flex-col border-r border-border bg-surface px-3 pb-3 pt-3">
      <button
        className={`${navRow} font-medium text-ink`}
        title="New chat (⌘N)"
        onClick={() => newThread(true)}
      >
        <EditIcon />
        <span>New chat</span>
      </button>

      <label className={`${navRow} mb-4`}>
        <SearchIcon />
        <input
          className="min-w-0 flex-1 border-none bg-transparent text-[13.5px] text-ink outline-none placeholder:text-muted"
          type="search" placeholder="Search"
          value={store.searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
        />
      </label>

      <div className="mb-2 px-2 text-[13px] text-faint">Conversations</div>
      <ul className="min-h-0 flex-1 list-none overflow-y-auto pr-1">
        {searching && threads.length === 0 && <li className="px-2.5 py-2 text-[12.5px] text-faint">No matching chats</li>}
        {threadGroups.map((group) => (
          <React.Fragment key={group.label}>
            <li className="px-2.5 pb-1 pt-2 text-[11px] font-medium uppercase text-faint">
              {group.label}
            </li>
            {group.threads.map((t) => {
              const active = t.id === store.activeId;
              const threadedOff = !!t.branchedFromThreadId || /\s↳ branch$/.test(t.title);
              return (
                <li
                  key={t.id}
                  className={`group mb-px flex h-[32px] cursor-pointer items-center gap-2 rounded-lg pl-2.5 pr-1.5 text-[13px] transition-colors ${active ? "bg-bg font-medium text-ink shadow-[0_1px_2px_rgba(20,20,18,0.03)]" : "text-muted hover:bg-bg hover:text-ink"}`}
                  onClick={() => selectThread(t.id)}
                  onContextMenu={(e) => { e.preventDefault(); selectThread(t.id); showThreadMenu(t.id); }}
                >
                  {t.busy && <SidebarSpinner />}
                  {!t.busy && threadedOff && (
                    <span className="shrink-0 text-faint" title="Threaded off from another chat">
                      <BranchIcon />
                    </span>
                  )}
                  <span className="flex-1 overflow-hidden text-ellipsis whitespace-nowrap">{t.title}</span>
                  <button
                    className="flex h-[20px] w-[20px] items-center justify-center rounded text-faint opacity-0 transition-opacity hover:!text-danger hover:bg-surface-2 group-hover:opacity-70"
                    title="Delete chat"
                    onClick={(e) => { e.stopPropagation(); deleteThread(t.id); }}
                  ><XIcon /></button>
                </li>
              );
            })}
          </React.Fragment>
        ))}
      </ul>

      <div className="mt-3 flex items-center gap-1 px-1 pb-1 pt-2" title="Active library">
        <button
          className="flex h-[28px] w-[24px] shrink-0 items-center justify-center rounded-md text-faint transition hover:bg-bg hover:text-muted"
          title={docsOpen ? "Collapse documents" : "Expand documents"}
          aria-label={docsOpen ? "Collapse documents" : "Expand documents"}
          aria-expanded={docsOpen}
          onClick={() => setDocsOpen((v) => !v)}
        >
          <ChevronIcon open={docsOpen} />
        </button>
        {store.collections.length >= 1 && (
          <select
            className="min-w-0 flex-1 cursor-pointer appearance-none truncate border-none bg-transparent px-0 py-1 font-mono text-[12px] text-muted outline-none transition hover:text-ink focus:text-ink"
            title="Active library"
            value={store.activeCollection}
            onChange={(e) => switchCollection(e.target.value)}
          >
            {store.collections.map((c) => (
              <option key={c.name} value={c.name}>
                {c.name === "default" ? "Default library" : c.name} ({c.docs})
              </option>
            ))}
          </select>
        )}
        {store.collections.length === 0 && (
          <div className="flex h-[28px] min-w-0 flex-1 items-center gap-2 rounded-md px-1.5 text-[13px] text-faint">
            <FolderIcon />
            <span className="overflow-hidden text-ellipsis whitespace-nowrap">Documents</span>
            <span className="ml-auto text-[12px]">{enabledCount}/{docs.length}</span>
          </div>
        )}
        {/*
        {docs.length > 0 && (
          <button
            className={iconBtn}
            title={allDocsEnabled ? "Disable all documents for this chat" : "Enable all documents for this chat"}
            onClick={() => setAllDocsEnabled(!allDocsEnabled)}
          >
            <span className="font-mono text-[10px]">{allDocsEnabled ? "0" : "All"}</span>
          </button>
        )}
        */}
        <button
          className={iconBtn}
          title="Add PDFs to the index" onClick={() => void addPdfs()}
        ><PlusIcon /></button>
      </div>

      {docsOpen && (
        <ul className="max-h-[26vh] list-none overflow-y-auto pr-1">
          {docs.length === 0 && <li className="px-2.5 py-1.5 text-[12px] text-faint">No PDFs indexed</li>}
          {docs.map((d) => {
            const isTemp = !!activeThread()?.tempDocs?.includes(d);
            return (
            <li
              key={d}
              className="flex h-[27px] cursor-default items-center gap-1.5 overflow-hidden text-ellipsis whitespace-nowrap rounded-md px-2 text-[12.5px] text-muted transition-colors hover:bg-bg hover:text-ink"
              title={`${d}\n(double-click to open${SEP}right-click for options)`}
              onDoubleClick={() => openDoc(d)}
              onContextMenu={(e) => { e.preventDefault(); showDocMenu(d); }}
            >
              <input
                type="checkbox"
                className="h-[13px] w-[13px] shrink-0 accent-tint"
                checked={docEnabled(d)}
                title={docEnabled(d) ? "Searched in this chat" : "Ignored in this chat"}
                onChange={(e) => setDocEnabled(d, e.target.checked)}
                onClick={(e) => e.stopPropagation()}
                onDoubleClick={(e) => e.stopPropagation()}
              />
              <span className="shrink-0 text-faint"><FileIcon /></span>
              <span className={`overflow-hidden text-ellipsis whitespace-nowrap ${docEnabled(d) ? "" : "text-faint line-through decoration-border-strong"}`}>
                {d.replace(/\.pdf$/i, "")}
              </span>
              {isTemp && <span className="ml-auto shrink-0 rounded bg-tint-soft px-1 font-mono text-[9.5px] text-tint-strong">chat</span>}
            </li>
            );
          })}
        </ul>
      )}

      <IngestProgress />

      <div className={`mt-1.5 flex items-center gap-2 border-t border-border px-2 pt-2.5 font-mono text-[10.5px] ${store.statusErr ? "text-danger" : "text-faint"}`}>
        {working && <SidebarSpinner />}
        <span className="min-w-0 overflow-hidden text-ellipsis whitespace-nowrap">{store.status}</span>
      </div>

      <UpdateBanner />

      <button className="mt-2 flex h-[34px] items-center gap-2 rounded-lg px-2.5 text-[13.5px] text-ink transition hover:bg-bg" onClick={openSettings}>
        <SettingsIcon />
        <span>Settings</span>
      </button>
    </aside>
  );
}
