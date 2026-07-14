/**
 * App store: holds all chat state and the backend event handlers, ported from
 * the original imperative renderer. React subscribes via `useStore()`; mutations
 * call `bump()` to trigger a re-render. Keeping the data model + protocol
 * handling here (rather than scattered through components) preserves the
 * battle-tested logic and keeps the React layer a thin view.
 */
import { useSyncExternalStore } from "react";
import { api } from "./trpc";
import type { UpdateState } from "./trpc";
import { SEP, IS_REMOTE } from "./platform";
import { threadToMarkdown, threadFilename } from "./export";
import type {
  Thread, AssistantMsg, ModelOption, Source, Usage,
  ServeEvent, ReadyEvent, BackendError, ThreadsEvent,
  ThreadTitleEvent, ThreadResultsEvent, ThreadResult, ToolEvent, AnswerEvent, DeltaEvent,
  HighlightedEvent, Collection, ViewerState,
} from "./types";

// ---- subscription plumbing -------------------------------------------------
const listeners = new Set<() => void>();
let version = 0;
export function bump(): void { version++; listeners.forEach((l) => l()); }
export function useStore(): number {
  return useSyncExternalStore(
    (cb) => { listeners.add(cb); return () => listeners.delete(cb); },
    () => version,
  );
}

const uid = () => Math.random().toString(36).slice(2, 10);
const MODEL_STORAGE_KEY = "pdf_qa_model";

function readStoredModel(): string {
  try { return localStorage.getItem(MODEL_STORAGE_KEY) || ""; }
  catch { return ""; }
}

function writeStoredModel(id: string): void {
  try { localStorage.setItem(MODEL_STORAGE_KEY, id); }
  catch { /* localStorage unavailable */ }
}

// Tool calls the model makes DURING the answer — rendered inline as a timeline.
// Everything else (embed_query/search/collect_pages/model) is a pipeline stage.
const INLINE_TOOLS = new Set(["calculate", "search_documents", "get_pages"]);

// ---- state -----------------------------------------------------------------
export type IngestPhase = "pages" | "embed" | "done" | "error" | "skip";
// Per-document ingest progress, keyed by filename, so several PDFs ingesting
// concurrently each get their own row + bar in the sidebar.
export interface IngestFile { name: string; percent: number; phase: IngestPhase; detail: string; eta?: string | null }
interface IngestState { text: string; percent: number | null; files?: Record<string, IngestFile> }
interface SessionTokens { prompt: number; completion: number; total: number; queries: number }

interface State {
  threads: Thread[];
  activeId: string;
  debug: boolean;
  visionModel: string;
  selectedModel: string;
  models: ModelOption[];
  defaultModel: string;
  docs: string[];
  status: string;
  statusErr: boolean;
  searchResults: ThreadResult[] | null;   // null = show all threads
  searchQuery: string;
  ingest: IngestState;
  tokens: SessionTokens;
  settingsOpen: boolean;
  librarySettings: string | null;   // name of the library whose settings dialog is open (null = closed)
  ready: boolean;
  update: UpdateState | null;   // auto-update state; drives the sidebar restart indicator
  collections: Collection[];    // known libraries (default + named)
  activeCollection: string;     // which collection the backend is currently serving
  viewer: ViewerState | null;   // in-app page viewer (null = closed)
}

export const store: State = {
  threads: [],
  activeId: "",
  debug: false,
  visionModel: "gpt-4o",
  selectedModel: readStoredModel(),
  models: [],
  defaultModel: "",
  docs: [],
  status: "connecting to backend…",
  statusErr: false,
  searchResults: null,
  searchQuery: "",
  ingest: { text: "", percent: null },
  tokens: { prompt: 0, completion: 0, total: 0, queries: 0 },
  settingsOpen: false,
  librarySettings: null,
  ready: false,
  update: null,
  collections: [],
  activeCollection: "default",
  viewer: null,
};

const reqToThread = new Map<string, string>();

// ---- helpers ---------------------------------------------------------------
export function activeThread(): Thread | undefined {
  return store.threads.find((t) => t.id === store.activeId);
}

export function visibleThreads(): Thread[] {
  if (!store.searchResults) return store.threads;
  return store.searchResults
    .map((r) => store.threads.find((t) => t.id === r.id))
    .filter((t): t is Thread => !!t);
}

export function threadDocs(t = activeThread()): string[] {
  const seen = new Set<string>();
  return [...store.docs, ...(t?.tempDocs || [])].filter((d) => {
    if (seen.has(d)) return false;
    seen.add(d);
    return true;
  });
}

export function enabledDocs(t = activeThread()): string[] {
  const disabled = new Set(t?.disabledDocs || []);
  return threadDocs(t).filter((d) => !disabled.has(d));
}

export function docEnabled(name: string, t = activeThread()): boolean {
  return !new Set(t?.disabledDocs || []).has(name);
}

function persistThread(t: Thread | undefined): void {
  if (!t) return;
  const { tempDocs: _tempDocs, ...persisted } = t;
  api.sendRequest({
    type: "thread_upsert",
    thread: {
      ...persisted,
      disabledDocs: (t.disabledDocs || []).filter((d) => store.docs.includes(d)),
      busy: false,
    },
  });
}

function touchThread(t: Thread): void {
  const now = Date.now();
  t.createdAt ||= now;
  t.updatedAt = now;
}

function lastUserText(t: Thread): string {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.kind === "user") return m.text;
  }
  return "";
}

// ---- thread actions --------------------------------------------------------
export function newThread(userInitiated = false): Thread {
  const now = Date.now();
  const t: Thread = {
    id: uid(), title: "New thread", messages: [], history: [],
    createdAt: now, updatedAt: now,
    disabledDocs: [], tempDocs: [], busy: false,
  };
  store.threads.unshift(t);
  store.activeId = t.id;
  store.searchResults = null;
  store.searchQuery = "";
  bump();
  persistThread(t);
  if (userInitiated) api.track("thread_created");
  return t;
}

export function selectThread(id: string): void {
  store.activeId = id;
  bump();
}

export function deleteThread(id: string): void {
  const i = store.threads.findIndex((t) => t.id === id);
  if (i < 0) return;
  api.track("thread_deleted");
  api.sendRequest({ type: "temp_index_clear", threadId: id });
  store.threads.splice(i, 1);
  api.sendRequest({ type: "thread_delete", id });
  if (store.activeId === id) store.activeId = store.threads[0]?.id || "";
  if (!store.activeId) { newThread(); return; }
  bump();
}

export function setDebug(v: boolean): void { store.debug = v; bump(); }

export function setModel(id: string): void {
  store.selectedModel = id;
  writeStoredModel(id);
  bump();
}

export async function showModelMenu(): Promise<void> {
  const selected = await api.showModelMenu(store.models, store.selectedModel);
  if (selected) setModel(selected);
}

export function setDocEnabled(name: string, enabled: boolean): void {
  const t = activeThread();
  if (!t) return;
  const disabled = new Set(t.disabledDocs || []);
  if (enabled) disabled.delete(name);
  else disabled.add(name);
  const docs = new Set(threadDocs(t));
  t.disabledDocs = [...disabled].filter((d) => docs.has(d));
  bump();
  persistThread(t);
}

export function setAllDocsEnabled(enabled: boolean): void {
  const t = activeThread();
  if (!t) return;
  t.disabledDocs = enabled ? [] : [...threadDocs(t)];
  bump();
  persistThread(t);
}

export async function addTempPdfsToThread(filePaths: string[]): Promise<void> {
  const t = activeThread();
  const pdfs = filePaths.filter((p) => /\.pdf$/i.test(p));
  if (!t || pdfs.length === 0) return;
  store.ingest = { text: `Adding ${pdfs.length} file(s) to this chat...`, percent: null };
  bump();
  try {
    const r = await api.addTempPdfs(t.id, pdfs);
    if (!r.ok) {
      store.ingest = { text: "No PDFs were added to this chat.", percent: null };
      bump();
      setTimeout(() => { store.ingest = { text: "", percent: null }; bump(); }, 3000);
    }
  } catch (e) {
    store.ingest = { text: `Could not add PDF: ${String((e as Error)?.message || e)}`, percent: null };
    bump();
  }
}

// ---- in-app page viewer -----------------------------------------------------
// A citation click opens the cited page inside the app: the plain page shows
// immediately, then the backend's highlighted render (the cited passage boxed)
// upgrades it, and prev/next flips through pages without leaving the app. Async
// responses are correlated by a "vw-" reqId so stale ones are ignored; the plain
// image is remembered as a fallback if highlighting finds nothing.
const highlightPending = new Map<string, string>();
let viewerReq = "";

async function loadViewerImage(path: string, reqId: string): Promise<void> {
  if (!path) { if (store.viewer && reqId === viewerReq) { store.viewer.loading = false; bump(); } return; }
  const url = await api.readImage(path);
  if (store.viewer && reqId === viewerReq && url) {
    store.viewer.imageUrl = url;
    store.viewer.loading = false;
    bump();
  }
}

export function openCitation(image: string, doc?: string, page?: number,
                             snippet?: string): void {
  if (!doc || !page) { void api.openFigure(image); return; }   // can't locate — OS viewer
  store.viewer = { doc, page, label: String(page), imageUrl: "", loading: true };
  bump();
  const reqId = "vw-" + uid();
  viewerReq = reqId;
  highlightPending.set(reqId, image);
  void loadViewerImage(image, reqId);   // show the plain page right away
  const question = lastUserText(activeThread() || ({} as Thread));
  // …then upgrade to the highlighted render when it's ready.
  api.sendRequest({ type: "highlight", reqId, doc, page, query: question, snippet: snippet || "" });
}

export function closeViewer(): void { store.viewer = null; bump(); }

export function viewerGoto(delta: number): void {
  if (!store.viewer) return;
  const page = store.viewer.page + delta;
  if (page < 1) return;
  store.viewer.loading = true;
  bump();
  const reqId = "vw-" + uid();
  viewerReq = reqId;
  api.sendRequest({ type: "page_image", reqId, doc: store.viewer.doc, page });
}

// ---- sending ---------------------------------------------------------------
export function send(question: string): void {
  const t = activeThread();
  question = question.trim();
  if (!t || !question || t.busy) return;
  const docs = enabledDocs(t);
  if (threadDocs(t).length > 0 && docs.length === 0) return;

  // Title the thread from the very first question, before the answer arrives,
  // so a thread streaming in the background is identifiable right away.
  const isFirstMessage = t.messages.every((m) => m.kind !== "user");

  const reqId = uid();
  touchThread(t);
  // A new question is being asked — retire any follow-up suggestion from the
  // previous answer so the composer placeholder doesn't linger as stale.
  t.followup = undefined;
  // Stamp the library this question is asked in (the active library at send time
  // is exactly the context the backend will retrieve from — it can't switch
  // mid-request). Recorded per message so a thread that spans libraries is
  // faithfully represented.
  const library = store.activeCollection;
  const coll = store.collections.find((c) => c.name === library);
  // Stamp the model we're asking with, so the footer shows the right model while
  // the answer streams (before the backend reports the actual one it used, which
  // then overwrites this). Without it the footer would fall back to the default
  // vision model and mislabel every in-flight answer.
  const picked = store.models.find((m) => m.id === store.selectedModel);
  const intendedModel = picked?.model || picked?.label || undefined;
  t.messages.push({ kind: "user", text: question, library });
  t.messages.push({
    kind: "assistant", reqId, trace: [], done: false,
    library, remote: !!coll?.remote, libraryUrl: coll?.url,
    model: intendedModel,
  });
  t.busy = true;
  reqToThread.set(reqId, t.id);

  api.sendRequest({
    type: "query", reqId, question, history: t.history,
    debug: store.debug, model: store.selectedModel, docs,
  });
  if (isFirstMessage) {
    api.sendRequest({ type: "title_suggest", id: t.id, question, answer: "" });
  }
  bump();
  persistThread(t);
}

/** Rebuild a thread's rolling history from its current messages (last 8 turns). */
function rebuildHistory(t: Thread): void {
  const h: { role: "user" | "assistant"; content: string }[] = [];
  for (const m of t.messages) {
    if (m.kind === "user") h.push({ role: "user", content: m.text });
    else if (m.kind === "assistant" && m.text) h.push({ role: "assistant", content: m.text });
  }
  t.history = h.slice(-8);
}

/** Re-run the question that produced this assistant message. Discards this answer
 *  (and anything after it in the thread), then asks again. */
export function regenerate(reqId: string): void {
  const t = activeThread();
  if (!t || t.busy) return;
  const ai = t.messages.findIndex((m) => m.kind === "assistant" && (m as AssistantMsg).reqId === reqId);
  if (ai < 1) return;
  let ui = ai - 1;
  while (ui >= 0 && t.messages[ui].kind !== "user") ui--;
  if (ui < 0) return;
  const question = (t.messages[ui] as { text: string }).text;
  t.messages.splice(ui);           // drop the user turn + its (re)generated answer onward
  rebuildHistory(t);
  bump();
  api.track("answer_regenerated");
  send(question);
}

/** Branch a new thread that continues from this message, leaving the original intact. */
export function threadOff(reqId: string): void {
  const t = activeThread();
  if (!t) return;
  const ai = t.messages.findIndex((m) => m.kind === "assistant" && (m as AssistantMsg).reqId === reqId);
  if (ai < 0) return;
  const slice = (typeof structuredClone === "function"
    ? structuredClone(t.messages.slice(0, ai + 1))
    : JSON.parse(JSON.stringify(t.messages.slice(0, ai + 1)))) as typeof t.messages;
  const nt: Thread = {
    id: uid(), title: `${t.title} ↳ branch`, messages: slice, history: [],
    createdAt: Date.now(), updatedAt: Date.now(),
    disabledDocs: [...(t.disabledDocs || [])], tempDocs: [...(t.tempDocs || [])], busy: false,
    branchedFromThreadId: t.id, branchedFromReqId: reqId,
  };
  rebuildHistory(nt);
  store.threads.unshift(nt);
  store.activeId = nt.id;
  store.searchResults = null;
  store.searchQuery = "";
  api.track("thread_branched");
  if ((t.tempDocs || []).length > 0) {
    api.sendRequest({ type: "temp_index_clone", fromThreadId: t.id, toThreadId: nt.id });
  }
  bump();
  persistThread(nt);
}

// ---- thread search (semantic, debounced) -----------------------------------
let searchTimer: ReturnType<typeof setTimeout> | undefined;
export function setSearchQuery(q: string): void {
  store.searchQuery = q;
  const trimmed = q.trim();
  clearTimeout(searchTimer);
  if (!trimmed) { store.searchResults = null; bump(); return; }
  bump();
  searchTimer = setTimeout(() => {
    api.track("thread_search_used");   // count only — never the query text
    api.sendRequest({ type: "thread_search", q: trimmed });
  }, 200);
}

// ---- documents -------------------------------------------------------------
export async function addPdfs(): Promise<void> {
  store.ingest = { text: "Choose PDFs…", percent: null };
  bump();
  const r = await api.addPdfs();
  if (r.canceled) { store.ingest = { text: "", percent: null }; bump(); }
}

export function openDoc(name: string): void {
  void api.openDoc(name);
}

export function showDocMenu(name: string): void {
  void api.showDocMenu(name);   // native Electron menu; Open / Remove handled in main
}

// ---- collections (libraries) ------------------------------------------------
// Collections are owned by the main process (directories + which one the backend
// serves), so list/create/delete are direct tRPC calls, not backend events.
export async function refreshCollections(): Promise<void> {
  try {
    store.collections = await api.listCollections();
    const active = store.collections.find((c) => c.active);
    if (active) store.activeCollection = active.name;
    bump();
  } catch (e) {
    console.error("[collections] list", e);
  }
}

// Display label for a library id (the "default" collection reads nicer spelled out).
export function libraryLabel(name?: string): string {
  return !name ? "" : name === "default" ? "Default library" : name;
}

// Distinct libraries a thread's questions were asked in, in first-seen order.
export function threadLibraries(t: Thread): string[] {
  const seen: string[] = [];
  for (const m of t.messages) {
    const lib = (m as { library?: string }).library;
    if (lib && !seen.includes(lib)) seen.push(lib);
  }
  return seen;
}

// Compact badge for a thread's library context: "" when nothing's been asked
// yet, the single library's label, or "First +N" when the thread spans several.
export function threadLibraryBadge(t: Thread): string {
  const libs = threadLibraries(t);
  if (libs.length === 0) return "";
  if (libs.length === 1) return libraryLabel(libs[0]);
  return `${libraryLabel(libs[0])} +${libs.length - 1}`;
}

export function switchCollection(name: string): void {
  if (!name || name === store.activeCollection) return;
  store.status = `switching to ${name === "default" ? "Default library" : name}…`;
  store.ready = false;
  bump();
  // Respawns the backend with the new collection; a fresh `ready` event follows.
  void api.setCollection(name);
}

export async function createCollection(name: string, language = ""): Promise<boolean> {
  const clean = name.trim();
  if (!clean) return false;
  const res = await api.createCollection(clean, language);
  if (!res.ok) {
    store.status = res.error || "Could not create library."; store.statusErr = true; bump();
    return false;
  }
  // On success the backend respawns into the new (empty) library; show the
  // switching state until the fresh `ready` arrives.
  store.status = `opening ${res.name}…`; store.statusErr = false; store.ready = false; bump();
  return true;
}

// Rename a library. Returns the new (sanitized) name on success, or null on
// failure (status carries the reason). When it's the active library the backend
// respawns; otherwise the list is refreshed in place.
export async function renameCollection(name: string, newName: string): Promise<string | null> {
  const clean = newName.trim();
  if (!clean || name === "default") return null;
  const isActive = name === store.activeCollection;
  const res = await api.renameCollection(name, clean);
  if (!res.ok || !res.name) {
    store.status = res.error || "Could not rename library."; store.statusErr = true; bump();
    return null;
  }
  if (store.librarySettings === name) store.librarySettings = res.name;   // keep the open dialog pointed at it
  if (isActive) {
    store.status = `opening ${res.name}…`; store.statusErr = false; store.ready = false; bump();
  } else {
    void refreshCollections();
  }
  return res.name;
}

// Change a library's OCR language. When it's the active library the backend
// respawns (a fresh `ready` follows); otherwise we refresh the list in place so
// the picker reflects the new value.
export async function setCollectionLanguage(name: string, language: string): Promise<void> {
  const current = store.collections.find((c) => c.name === name)?.language || "";
  if (language === current) return;
  const isActive = name === store.activeCollection;
  const res = await api.setCollectionLanguage(name, language);
  if (!res.ok) {
    store.status = res.error || "Could not set language."; store.statusErr = true; bump();
    return;
  }
  if (isActive) {
    store.status = "applying language…"; store.statusErr = false; store.ready = false; bump();
  } else {
    void refreshCollections();
  }
}

export async function deleteCollection(name: string): Promise<void> {
  if (!name || name === "default") return;
  const res = await api.deleteCollection(name);
  if (!res.ok) { store.status = res.error || "Could not delete library."; store.statusErr = true; bump(); }
  // If the deleted library was active the backend respawns (ready refreshes);
  // otherwise refresh the list in place.
  if (store.ready) void refreshCollections();
}

// Add a remote library: the main process tests the connection, persists it, and
// switches to it (respawning the backend pointed at the server). Returns true on
// success; on failure the status line carries the reason.
export async function addRemoteLibrary(input: { name: string; url: string; secret: string; remoteName?: string }): Promise<boolean> {
  const clean = input.name.trim();
  if (!clean || !input.url.trim()) return false;
  const res = await api.addRemoteLibrary({ ...input, name: clean, url: input.url.trim() });
  if (!res.ok) {
    store.status = res.error || "Could not add remote library."; store.statusErr = true; bump();
    return false;
  }
  store.status = `connecting to ${res.name}…`; store.statusErr = false; store.ready = false; bump();
  return true;
}

// Rename a remote library's app-side label (the server library is untouched).
// Returns the new name on success, or null on failure (status carries the why).
export async function renameRemoteLibrary(name: string, newName: string): Promise<string | null> {
  const clean = newName.trim();
  if (!clean || clean === name) return clean === name ? name : null;
  const isActive = name === store.activeCollection;
  const res = await api.renameRemoteLibrary(name, clean);
  if (!res.ok || !res.name) {
    store.status = res.error || "Could not rename library."; store.statusErr = true; bump();
    return null;
  }
  if (store.librarySettings === name) store.librarySettings = res.name;
  if (isActive) {
    store.status = `opening ${res.name}…`; store.statusErr = false; store.ready = false; bump();
  } else {
    void refreshCollections();
  }
  return res.name;
}

// Remove (disconnect) a remote library from the app. Does not touch the server.
export async function removeRemoteLibrary(name: string): Promise<void> {
  const res = await api.removeRemoteLibrary(name);
  if (!res.ok) { store.status = res.error || "Could not remove remote library."; store.statusErr = true; bump(); }
  if (store.ready) void refreshCollections();
}

export function showThreadMenu(id: string): void {
  const t = store.threads.find((thread) => thread.id === id);
  if (!t) return;
  // Serialize the transcript here (the renderer owns the message model) and hand
  // it to the native menu so its copy/export actions have ready-made Markdown.
  void api.showThreadMenu(t.title, t.messages, threadToMarkdown(t), threadFilename(t));
}

export function removeDoc(name: string): void {
  // Optimistically drop it from the list; the backend's follow-up "ready" event
  // (with the authoritative doc list) will reconcile.
  store.docs = store.docs.filter((d) => d !== name);
  store.ingest = { text: `Removing ${name}…`, percent: null };
  bump();
  void api.removeDoc(name);
}

// ---- settings --------------------------------------------------------------
export function openSettings(): void {
  if (IS_REMOTE) return;   // settings are never available to remote web clients
  store.settingsOpen = true; bump();
}
export function closeSettings(): void { store.settingsOpen = false; bump(); }
export function openLibrarySettings(name = store.activeCollection): void { store.librarySettings = name; bump(); }
export function closeLibrarySettings(): void { store.librarySettings = null; bump(); }

// ---- auto-update -----------------------------------------------------------
// The main process downloads updates in the background and pushes state here;
// the sidebar shows a "Restart to update" row once status === "downloaded".
export function handleUpdateEvent(s: UpdateState | null): void {
  store.update = s;
  bump();
}

export function installUpdate(): void {
  void api.installUpdate()
    .then((triggered) => {
      console.log(`[update] install requested → ${triggered ? "restarting to apply" : "no-op (dev build; would restart when packaged)"}`);
    })
    .catch((e) => console.error("[update] install", e));
}

// ---- model picker / token stats -------------------------------------------
function applyModels(models: ModelOption[], defaultId: string): void {
  if (!models.length) return;
  const savedModel = readStoredModel();
  const selected = models.some((m) => m.id === savedModel)
    ? savedModel
    : models.some((m) => m.id === store.selectedModel)
      ? store.selectedModel
      : defaultId || models[0].id;
  if (store.selectedModel !== selected) {
    store.selectedModel = selected;
  }
  writeStoredModel(selected);
  store.models = models;
  store.defaultModel = defaultId;
}

function updateTokenStats(u: Usage): void {
  store.tokens.prompt += u.prompt || 0;
  store.tokens.completion += u.completion || 0;
  store.tokens.total += u.total || 0;
  store.tokens.queries += 1;
}

// ---- hydration -------------------------------------------------------------
function hydrateThreads(dumped: Thread[]): void {
  store.threads = [];
  for (const t of dumped) {
    const now = Date.now();
    t.createdAt ||= t.updatedAt || now;
    t.updatedAt ||= t.createdAt;
    t.busy = false;
    if (store.docs.length) {
      t.disabledDocs = (t.disabledDocs || []).filter((d) => store.docs.includes(d));
    } else {
      t.disabledDocs = t.disabledDocs || [];
    }
    t.tempDocs = [];
    for (const m of t.messages) {
      if (m.kind === "assistant") {
        m.streaming = false;
        if (!m.done) { m.done = true; if (!m.text && !m.error) m.error = "interrupted (app was closed)"; }
      }
    }
    store.threads.push(t);
  }
  if (store.threads.length) {
    store.activeId = store.threads.find((t) => t.id === store.activeId) ? store.activeId : store.threads[0].id;
    bump();
  } else {
    newThread();
  }
}

// ---- backend events --------------------------------------------------------
function findAssistant(reqId: string): { thread: Thread; msg: AssistantMsg } | null {
  const tid = reqToThread.get(reqId);
  const thread = store.threads.find((t) => t.id === tid);
  if (!thread) return null;
  const msg = thread.messages.find(
    (m) => m.kind === "assistant" && m.reqId === reqId) as AssistantMsg | undefined;
  return msg ? { thread, msg } : null;
}

export function handleServeEvent(ev: ServeEvent): void {
  if (ev.type === "ready") {
    const r = ev as ReadyEvent;
    store.visionModel = r.vision_model;
    if (r.models) applyModels(r.models, r.default_model || "");
    store.statusErr = false;
    store.status = `${r.chunks} chunks${SEP}${r.docs.length} document(s)`;
    store.docs = r.docs;
    if ((r as { collection?: string }).collection) {
      store.activeCollection = (r as { collection?: string }).collection as string;
    }
    for (const t of store.threads) {
      t.disabledDocs = (t.disabledDocs || []).filter((d) => r.docs.includes(d));
    }
    store.ready = true;
    void refreshCollections();   // pull the library list from the main process
    bump();
    return;
  }
  if (ev.type === "doc_removed") {
    const e = ev as any;
    store.ingest = { text: `Removed ${e.doc} (${e.removed} chunks)`, percent: null };
    bump();
    setTimeout(() => { store.ingest = { text: "", percent: null }; bump(); }, 3000);
    return;
  }
  if (ev.type === "highlighted") {
    const e = ev as HighlightedEvent;
    const fallback = e.reqId ? highlightPending.get(e.reqId) : undefined;
    if (e.reqId) highlightPending.delete(e.reqId);
    // Upgrade the open viewer to the highlighted render (or keep the plain page).
    if (e.reqId && e.reqId === viewerReq && store.viewer) {
      void loadViewerImage(e.path || fallback || "", e.reqId);
    }
    return;
  }
  if (ev.type === "page_image") {
    const e = ev as unknown as { reqId?: string; page: number; label: string; path: string | null };
    if (e.reqId && e.reqId === viewerReq && store.viewer) {
      if (e.path) {
        store.viewer.page = e.page;
        store.viewer.label = e.label || String(e.page);
        void loadViewerImage(e.path, e.reqId);
      } else {
        store.viewer.loading = false;   // out of range — nothing to show
        bump();
      }
    }
    return;
  }
  if (ev.type === "threads") { hydrateThreads((ev as ThreadsEvent).threads || []); return; }
  if (ev.type === "thread_results") {
    store.searchResults = (ev as ThreadResultsEvent).results || [];
    bump();
    return;
  }
  if (ev.type === "thread_title") {
    const e = ev as ThreadTitleEvent;
    const t = store.threads.find((x) => x.id === e.id);
    if (t) { t.title = e.title; bump(); persistThread(t); }
    return;
  }
  if (ev.type === "followup") {
    const e = ev as { type: "followup"; reqId?: string; text?: string };
    const tid = e.reqId ? reqToThread.get(e.reqId) : undefined;
    const t = store.threads.find((x) => x.id === tid);
    // Only surface it while this is still the thread's latest answer — if the
    // user has already asked again, the suggestion is stale and `send()` cleared it.
    if (t && !t.busy && e.text) { t.followup = e.text; bump(); persistThread(t); }
    return;
  }
  if (ev.type === "temp_indexed") {
    const e = ev as any;
    const t = store.threads.find((x) => x.id === e.threadId);
    if (t) {
      const docs = new Set([...(t.tempDocs || []), ...((e.docs || []) as string[])]);
      t.tempDocs = [...docs];
      store.ingest = { text: `Added ${e.docs?.length || 0} temporary document(s) to this chat.`, percent: null };
      bump();
      setTimeout(() => { store.ingest = { text: "", percent: null }; bump(); }, 3000);
    }
    return;
  }
  if (ev.type === "error" && !(ev as BackendError).reqId) {
    store.statusErr = true;
    store.status = (ev as BackendError).message;
    bump();
    return;
  }
  const reqId = (ev as { reqId?: string }).reqId;
  if (!reqId) return;
  const found = findAssistant(reqId);
  if (!found) return;
  const { thread, msg } = found;

  if (ev.type === "tool") {
    const te = ev as ToolEvent;
    // In-answer tool calls become inline timeline entries; pipeline stages
    // (embed/search/collect/model) stay in the trace box at the top.
    if (INLINE_TOOLS.has(te.name)) {
      (msg.stream ||= []).push(te);
    } else {
      msg.trace.push(te);
    }
  } else if (ev.type === "delta") {
    const txt = (ev as DeltaEvent).text;
    msg.raw = (msg.raw || "") + txt;
    msg.stream ||= [];
    const last = msg.stream[msg.stream.length - 1];
    if (typeof last === "string") msg.stream[msg.stream.length - 1] = last + txt;
    else msg.stream.push(txt);
    msg.streaming = true;
  } else if (ev.type === "answer") {
    const a = ev as AnswerEvent;
    msg.text = a.text; msg.thinking = a.thinking ?? msg.thinking;
    msg.sources = a.sources; msg.usage = a.usage; msg.calculations = a.calculations;
    msg.confidence = a.confidence; msg.topScore = a.top_score;
    msg.latency = a.latency;
    msg.model = a.model; msg.sessionId = (a as any).session_id; msg.streaming = false; msg.done = true;
    if (a.usage && a.usage.total) updateTokenStats(a.usage);
    const question = lastUserText(thread);
    thread.history.push({ role: "user", content: question });
    thread.history.push({ role: "assistant", content: a.text });
    thread.history = thread.history.slice(-8);
    thread.busy = false;
    touchThread(thread);
    persistThread(thread);
    // Ask the small model for a suggested next question (used as the composer
    // placeholder). Best-effort and off the answer path — a `followup` event
    // may or may not follow; the placeholder just falls back to its default.
    if (a.text && a.text.trim()) {
      api.sendRequest({ type: "followup_suggest", reqId, question, answer: a.text });
    }
  } else if (ev.type === "error") {
    msg.error = (ev as BackendError).message; msg.done = true;
    thread.busy = false;
    touchThread(thread);
    persistThread(thread);
  }
  bump();
}

// Per-document ingest progress as a list, in first-seen order, for rendering.
export function ingestFiles(): IngestFile[] {
  return Object.values(store.ingest.files || {});
}

// ETA is derived on the app side (the CLI's tqdm bars aren't visible here).
// We work in *pages*, not the overall percentage: percent lurches every time a
// file completes, but page throughput (pages/sec) is smooth and is exactly what
// tqdm reports. The files ingest concurrently, so the batch finishes when the
// SLOWEST file finishes — the ETA is the max of the per-file ETAs, each from
// that file's own throughput over a trailing window.
const ETA_WINDOW_MS = 20_000;
// Per-file page counts for the current run: {done, total}, plus a trailing
// window of (time, done) samples to measure that file's own pages/sec.
interface PageStat { done: number; total: number; samples: { t: number; done: number }[] }
let pageStats: Record<string, PageStat> = {};
// Total files in the current run and how many were skipped, so the overall bar
// averages over what will actually be processed.
let ingestTotal = 0;
let skipCount = 0;

function resetEta(): void { pageStats = {}; }

function formatEta(secs: number): string {
  if (!isFinite(secs) || secs < 0) return "";
  const s = Math.round(secs);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  if (m < 60) return r ? `${m}m ${r}s` : `${m}m`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

// A single file's ETA from its own throughput: rate = Δ(its pages) / Δtime over
// the trailing window, ETA = remaining / rate. Null until the rate is stable.
function fileEta(name: string): string | null {
  const p = pageStats[name];
  if (!p) return null;
  const remaining = p.total - p.done;
  if (remaining <= 0) return null;                   // this file is done
  const first = p.samples[0];
  if (!first) return null;
  const now = Date.now();
  const dDone = p.done - first.done;
  const dT = (now - first.t) / 1000;
  if (dT < 2 || dDone <= 0) return null;             // not enough throughput yet
  const rate = dDone / dT;                           // pages per second
  const left = formatEta(remaining / rate);
  if (!left) return null;
  const rateStr = rate >= 10 ? Math.round(rate).toString() : rate.toFixed(1);
  return `${rateStr} p/s · about ${left} left`;
}


// Record page progress for a file so computeEta() can measure its throughput.
function trackPages(name: string, done: number, total: number): void {
  if (!(total > 0)) return;
  const d = Math.min(done, total);
  const p = pageStats[name] || (pageStats[name] = { done: 0, total, samples: [] });
  p.done = d;
  p.total = total;
  const now = Date.now();
  p.samples.push({ t: now, done: d });
  while (p.samples.length > 1 && now - p.samples[0].t > ETA_WINDOW_MS) p.samples.shift();
}

export function handleIngestEvent(ev: any): void {
  const temp = !!ev.temp;
  const scope = temp ? "this chat" : "the index";
  // Carry the per-file map forward across events; each event upserts one file.
  const files: Record<string, IngestFile> = { ...(store.ingest.files || {}) };
  const upsert = (name: string, patch: Partial<IngestFile>) => {
    const prev: IngestFile = files[name] || { name, percent: 0, phase: "pages", detail: "" };
    files[name] = { ...prev, ...patch, name };
  };
  // Overall bar = mean of the per-file percentages (done counts as 100),
  // averaged over the run's full file count — not just the files seen so far,
  // or the bar would spike then plunge as later files start (skips excluded,
  // since they're never processed).
  const overall = (): number | null => {
    const vals = Object.values(files).filter((f) => f.phase !== "skip");
    if (!vals.length) return null;
    const sum = vals.reduce((s, f) => s + (f.phase === "done" ? 100 : f.percent), 0);
    const denom = Math.max(vals.length, ingestTotal - skipCount);
    return Math.round(sum / Math.max(1, denom));
  };
  const setStatus = (text: string, percent: number | null) => {
    store.ingest = { text, percent, files };
  };

  switch (ev.type) {
    case "ingest_start":
      ingestTotal = typeof ev.total === "number" ? ev.total : 0;
      skipCount = 0;
      resetEta();
      store.ingest = { text: `Ingesting ${ev.total} file(s) for ${scope}…`, percent: null, files: {} };
      break;
    case "file_start":
      upsert(ev.name, { percent: 0, phase: "pages", detail: "starting…" });
      setStatus(`Indexing ${ev.name}…`, overall());
      break;
    case "file_progress": {
      const embedding = ev.phase === "embed";
      // The embed event carries dummy page counts (0/1); treat embedding as
      // "all pages processed" for throughput and leave the real total in place.
      if (embedding) { const p = pageStats[ev.name]; if (p) p.done = p.total; }
      else trackPages(ev.name, ev.page, ev.pages);
      upsert(ev.name, {
        percent: ev.percent,
        phase: embedding ? "embed" : "pages",
        detail: embedding ? "embedding…" : `page ${ev.page}/${ev.pages}`,
        eta: embedding ? null : fileEta(ev.name),
      });
      setStatus(`Indexing ${ev.name}… ${ev.percent}%`, overall());
      break;
    }
    case "file_done":
      if (typeof ev.pages === "number") trackPages(ev.name, ev.pages, ev.pages);
      upsert(ev.name, { percent: 100, phase: "done", detail: `${ev.pages}p · ${ev.chunks} chunks` });
      setStatus(`${ev.name}: ${ev.pages}p, ${ev.chunks} chunks`, overall());
      break;
    case "file_skip":
      skipCount += 1;
      upsert(ev.name, { percent: 0, phase: "skip", detail: ev.reason });
      setStatus(`${ev.name}: ${ev.reason}`, overall());
      break;
    case "file_error":
      upsert(ev.name, { percent: 100, phase: "error", detail: ev.message });
      setStatus(`${ev.name}: ${ev.message}`, overall());
      break;
    case "ingest_done":
      resetEta();
      store.ingest = {
        text: ev.added ? `Added ${ev.added} document(s).` : "Nothing new to add.",
        percent: null, files: {},
      };
      if (!temp && Array.isArray(ev.docs)) store.docs = ev.docs;
      setTimeout(() => { store.ingest = { text: "", percent: null, files: {} }; bump(); }, 4000);
      break;
    case "ingest_error":
      resetEta();
      store.ingest = { text: `${ev.message}`, percent: null, files: {} };
      break;
  }
  bump();
}
