/**
 * App store: holds all chat state and the backend event handlers, ported from
 * the original imperative renderer. React subscribes via `useStore()`; mutations
 * call `bump()` to trigger a re-render. Keeping the data model + protocol
 * handling here (rather than scattered through components) preserves the
 * battle-tested logic and keeps the React layer a thin view.
 */
import { useSyncExternalStore } from "react";
import { api } from "./trpc";
import type {
  Thread, AssistantMsg, ModelOption, Source, Usage,
  ServeEvent, ReadyEvent, BackendError, ThreadsEvent,
  ThreadTitleEvent, ThreadResultsEvent, ThreadResult, ToolEvent, AnswerEvent, DeltaEvent,
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

// Tool calls the model makes DURING the answer — rendered inline as a timeline.
// Everything else (embed_query/search/collect_pages/model) is a pipeline stage.
const INLINE_TOOLS = new Set(["calculate", "search_documents", "get_pages"]);

// ---- state -----------------------------------------------------------------
interface IngestState { text: string; percent: number | null }
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
  ready: boolean;
}

export const store: State = {
  threads: [],
  activeId: "",
  debug: false,
  visionModel: "gpt-4o",
  selectedModel: localStorage.getItem("pdf_qa_model") || "",
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
  ready: false,
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

function persistThread(t: Thread | undefined): void {
  if (!t) return;
  api.sendRequest({ type: "thread_upsert", thread: { ...t, busy: false } });
}

function lastUserText(t: Thread): string {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.kind === "user") return m.text;
  }
  return "";
}

// ---- thread actions --------------------------------------------------------
export function newThread(): Thread {
  const t: Thread = { id: uid(), title: "New thread", messages: [], history: [], busy: false };
  store.threads.unshift(t);
  store.activeId = t.id;
  store.searchResults = null;
  store.searchQuery = "";
  bump();
  persistThread(t);
  return t;
}

export function selectThread(id: string): void {
  store.activeId = id;
  bump();
}

export function deleteThread(id: string): void {
  const i = store.threads.findIndex((t) => t.id === id);
  if (i < 0) return;
  store.threads.splice(i, 1);
  api.sendRequest({ type: "thread_delete", id });
  if (store.activeId === id) store.activeId = store.threads[0]?.id || "";
  if (!store.activeId) { newThread(); return; }
  bump();
}

export function setDebug(v: boolean): void { store.debug = v; bump(); }

export function setModel(id: string): void {
  store.selectedModel = id;
  localStorage.setItem("pdf_qa_model", id);
  bump();
}

// ---- sending ---------------------------------------------------------------
export function send(question: string): void {
  const t = activeThread();
  question = question.trim();
  if (!t || !question || t.busy) return;

  const reqId = uid();
  t.messages.push({ kind: "user", text: question });
  t.messages.push({ kind: "assistant", reqId, trace: [], done: false });
  t.busy = true;
  reqToThread.set(reqId, t.id);

  api.sendRequest({
    type: "query", reqId, question, history: t.history,
    debug: store.debug, model: store.selectedModel,
  });
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
  const nt: Thread = { id: uid(), title: `${t.title} ↳ branch`, messages: slice, history: [], busy: false };
  rebuildHistory(nt);
  store.threads.unshift(nt);
  store.activeId = nt.id;
  store.searchResults = null;
  store.searchQuery = "";
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
  searchTimer = setTimeout(() => api.sendRequest({ type: "thread_search", q: trimmed }), 200);
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

export function removeDoc(name: string): void {
  // Optimistically drop it from the list; the backend's follow-up "ready" event
  // (with the authoritative doc list) will reconcile.
  store.docs = store.docs.filter((d) => d !== name);
  store.ingest = { text: `Removing ${name}…`, percent: null };
  bump();
  void api.removeDoc(name);
}

// ---- settings --------------------------------------------------------------
export function openSettings(): void { store.settingsOpen = true; bump(); }
export function closeSettings(): void { store.settingsOpen = false; bump(); }

// ---- model picker / token stats -------------------------------------------
function applyModels(models: ModelOption[], defaultId: string): void {
  if (!models.length) return;
  if (!models.some((m) => m.id === store.selectedModel)) {
    store.selectedModel = defaultId || models[0].id;
  }
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
    t.busy = false;
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
    store.status = `${r.chunks} chunks · ${r.docs.length} document(s)`;
    store.docs = r.docs;
    store.ready = true;
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
    msg.model = a.model; msg.sessionId = (a as any).session_id; msg.streaming = false; msg.done = true;
    if (a.usage && a.usage.total) updateTokenStats(a.usage);
    const question = lastUserText(thread);
    thread.history.push({ role: "user", content: question });
    thread.history.push({ role: "assistant", content: a.text });
    thread.history = thread.history.slice(-8);
    thread.busy = false;
    persistThread(thread);
    if (thread.messages.filter((m) => m.kind === "user").length === 1) {
      api.sendRequest({ type: "title_suggest", id: thread.id, question, answer: a.text });
    }
  } else if (ev.type === "error") {
    msg.error = (ev as BackendError).message; msg.done = true;
    thread.busy = false;
    persistThread(thread);
  }
  bump();
}

export function handleIngestEvent(ev: any): void {
  const set = (text: string, percent: number | null) => { store.ingest = { text, percent }; };
  switch (ev.type) {
    case "ingest_start": set(`Ingesting ${ev.total} file(s)…`, null); break;
    case "file_start": set(`Indexing ${ev.name} (${ev.index}/${ev.total})…`, 0); break;
    case "file_progress": {
      const label = ev.phase === "embed"
        ? `Embedding ${ev.name} (${ev.index}/${ev.total})…`
        : `Indexing ${ev.name} (${ev.index}/${ev.total}) - page ${ev.page}/${ev.pages}`;
      set(`${label} ${ev.percent}%`, ev.percent);
      break;
    }
    case "file_done": set(`${ev.name}: ${ev.pages}p, ${ev.chunks} chunks`, 100); break;
    case "file_skip": set(`${ev.name}: ${ev.reason}`, null); break;
    case "file_error": set(`${ev.name}: ${ev.message}`, null); break;
    case "ingest_done":
      set(ev.added ? `Added ${ev.added} document(s).` : "Nothing new to add.", null);
      if (Array.isArray(ev.docs)) store.docs = ev.docs;
      setTimeout(() => { store.ingest = { text: "", percent: null }; bump(); }, 4000);
      break;
    case "ingest_error": set(`${ev.message}`, null); break;
  }
  bump();
}
