/**
 * Renderer: multi-thread chat UI over the Python backend.
 *
 * Shows the same information as the CLI — a live tool-call trace (embed →
 * search → collect_pages → gpt-4o) with timings and optional debug detail —
 * plus answers whose figures/sources are underlined and open in the OS viewer.
 */

// ---- backend protocol (mirrors pdf_qa/serve.py) ----------------------------
interface Source { doc: string; page: number; image: string; }
interface ToolEvent {
  type: "tool"; reqId?: string; name: string; args: string;
  detail: string[]; debug: string[]; duration: number;
}
interface Usage { prompt?: number; completion?: number; total?: number; reasoning?: number; }
interface Calc { expression: string; ok: boolean; result?: string; error?: string; verified?: boolean; }
interface AnswerEvent {
  type: "answer"; reqId?: string; text: string; thinking?: string; sources: Source[];
  usage: Usage; calculations?: Calc[]; model?: string;
}
interface DeltaEvent { type: "delta"; reqId?: string; text: string; }
interface ModelOption { id: string; label: string; }
interface ReadyEvent {
  type: "ready"; docs: string[]; chunks: number; vision_model: string; embed_model: string;
  models?: ModelOption[]; default_model?: string;
}
interface BackendError { type: "error"; reqId?: string; message: string; }
type ServeEvent = ToolEvent | AnswerEvent | ReadyEvent | BackendError | { type: string; reqId?: string };
export {}; // make this a module so the `Window` augmentation below is allowed

// ---- the API exposed by preload.ts -----------------------------------------
declare global {
  interface Window {
    api: {
      onServeEvent: (cb: (e: ServeEvent) => void) => void;
      onServeLog: (cb: (line: string) => void) => void;
      sendRequest: (req: unknown) => void;
      openFigure: (filePath: string) => Promise<string>;
      addPdfs: () => Promise<{ canceled: boolean; count?: number }>;
      onIngestEvent: (cb: (e: any) => void) => void;
    };
  }
}

// ---- app state -------------------------------------------------------------
interface AssistantMsg {
  kind: "assistant"; reqId: string; trace: ToolEvent[];
  raw?: string;          // accumulated streamed text (may contain <thinking>)
  thinking?: string;     // parsed reasoning
  text?: string; sources?: Source[]; usage?: Usage; calculations?: Calc[];
  model?: string;        // concrete answerer model that produced this reply
  streaming?: boolean;   // currently receiving deltas
  error?: string; done: boolean;
}
interface UserMsg { kind: "user"; text: string; }
type Msg = UserMsg | AssistantMsg;

interface Thread {
  id: string; title: string; messages: Msg[];
  history: { role: "user" | "assistant"; content: string }[];
  busy: boolean;
}

const threads: Thread[] = [];
let activeId = "";
const reqToThread = new Map<string, string>();
let debug = false;
let visionModel = "gpt-4o";
let selectedModel = localStorage.getItem("pdf_qa_model") || "";  // UI model id; "" until ready

const uid = () => Math.random().toString(36).slice(2, 10);

// ---- persistence (threads survive app restarts) ----------------------------
const STORE_KEY = "pdf_qa_threads_v1";

function saveState(): void {
  try {
    const data = JSON.stringify({
      activeId,
      // strip transient streaming buffers; keep durable content
      threads: threads.map((t) => ({ ...t, busy: false })),
    });
    localStorage.setItem(STORE_KEY, data);
  } catch { /* quota / serialization — ignore */ }
}

function loadState(): boolean {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    if (!Array.isArray(data.threads) || data.threads.length === 0) return false;
    for (const t of data.threads as Thread[]) {
      t.busy = false;
      for (const m of t.messages) {
        if (m.kind === "assistant") {
          m.streaming = false;
          if (!m.done) { m.done = true; if (!m.text && !m.error) m.error = "interrupted (app was closed)"; }
        }
      }
      threads.push(t);
    }
    activeId = threads.find((t) => t.id === data.activeId) ? data.activeId : threads[0].id;
    return true;
  } catch {
    return false;
  }
}

// ---- DOM refs --------------------------------------------------------------
const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const threadList = $("thread-list");
const messagesEl = $("messages");
const inputEl = $("input") as HTMLTextAreaElement;
const sendBtn = $("send") as HTMLButtonElement;
const statusEl = $("index-status");
const debugToggle = $("debug-toggle") as HTMLInputElement;
const modelSelect = $("model-select") as HTMLSelectElement;
const tokenStatsEl = $("token-stats");
const docCountEl = $("doc-count");
const docListEl = $("doc-list");
const addPdfBtn = $("add-pdf") as HTMLButtonElement;
const ingestStatusEl = $("ingest-status");

/** Build the model picker from the backend's advertised model list. */
function renderModelSelect(models: ModelOption[], defaultId: string): void {
  if (!models.length) return;
  // honour a previously chosen model if it's still offered, else the backend default
  if (!models.some((m) => m.id === selectedModel)) selectedModel = defaultId || models[0].id;
  modelSelect.innerHTML = "";
  for (const m of models) {
    const opt = document.createElement("option");
    opt.value = m.id;
    opt.textContent = m.label;
    if (m.id === selectedModel) opt.selected = true;
    modelSelect.appendChild(opt);
  }
}

function renderDocs(docs: string[]): void {
  docCountEl.textContent = String(docs.length);
  docListEl.innerHTML = "";
  for (const d of docs) {
    const li = document.createElement("li");
    li.className = "doc-item";
    li.title = d;
    li.textContent = d.replace(/\.pdf$/i, "");
    docListEl.appendChild(li);
  }
}

async function addPdfs(): Promise<void> {
  addPdfBtn.disabled = true;
  ingestStatusEl.textContent = "Choose PDFs…";
  try {
    const r = await window.api.addPdfs();
    if (r.canceled) ingestStatusEl.textContent = "";
  } finally {
    addPdfBtn.disabled = false;
  }
}

window.api.onIngestEvent((ev: any) => {
  switch (ev.type) {
    case "ingest_start": ingestStatusEl.textContent = `Ingesting ${ev.total} file(s)…`; break;
    case "file_start": ingestStatusEl.textContent = `Indexing ${ev.name} (${ev.index}/${ev.total})…`; break;
    case "file_done": ingestStatusEl.textContent = `✓ ${ev.name} — ${ev.pages}p, ${ev.chunks} chunks`; break;
    case "file_skip": ingestStatusEl.textContent = `• ${ev.name}: ${ev.reason}`; break;
    case "file_error": ingestStatusEl.textContent = `⚠ ${ev.name}: ${ev.message}`; break;
    case "ingest_done":
      ingestStatusEl.textContent = ev.added ? `Added ${ev.added} document(s).` : "Nothing new to add.";
      if (Array.isArray(ev.docs)) renderDocs(ev.docs);          // immediate refresh
      setTimeout(() => { ingestStatusEl.textContent = ""; }, 4000);
      break;
    case "ingest_error": ingestStatusEl.textContent = `⚠ ${ev.message}`; break;
  }
});

// running session token totals
const sessionTokens = { prompt: 0, completion: 0, total: 0, queries: 0 };
function updateTokenStats(u: Usage): void {
  sessionTokens.prompt += u.prompt || 0;
  sessionTokens.completion += u.completion || 0;
  sessionTokens.total += u.total || 0;
  sessionTokens.queries += 1;
  tokenStatsEl.textContent =
    `session: ${sessionTokens.total.toLocaleString()} tok ` +
    `(${sessionTokens.prompt.toLocaleString()} in / ${sessionTokens.completion.toLocaleString()} out) · ${sessionTokens.queries} q`;
}

// ---- thread management -----------------------------------------------------
function newThread(): Thread {
  const t: Thread = { id: uid(), title: "New thread", messages: [], history: [], busy: false };
  threads.unshift(t);
  activeId = t.id;
  renderThreads();
  renderMessages();
  saveState();
  return t;
}

function activeThread(): Thread | undefined {
  return threads.find((t) => t.id === activeId);
}

function deleteThread(id: string): void {
  const i = threads.findIndex((t) => t.id === id);
  if (i < 0) return;
  threads.splice(i, 1);
  if (activeId === id) activeId = threads[0]?.id || "";
  if (!activeId) newThread();
  else { renderThreads(); renderMessages(); }
  saveState();
}

function renderThreads(): void {
  threadList.innerHTML = "";
  for (const t of threads) {
    const li = document.createElement("li");
    li.className = "thread-item" + (t.id === activeId ? " active" : "");
    const label = document.createElement("span");
    label.textContent = t.title;
    const del = document.createElement("span");
    del.className = "del"; del.textContent = "✕";
    del.onclick = (e) => { e.stopPropagation(); deleteThread(t.id); };
    li.append(label, del);
    li.onclick = () => { activeId = t.id; renderThreads(); renderMessages(); saveState(); };
    threadList.appendChild(li);
  }
}

// ---- rendering -------------------------------------------------------------
function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Minimal, XSS-safe Markdown → HTML (escapes first, then formats).
 *  Covers headings, bold, italic, inline code, fenced code, lists, blockquotes. */
/** Render a LaTeX string to HTML with KaTeX (best-effort; falls back to raw on error). */
function renderMath(latex: string, display: boolean): string {
  const katex = (window as any).katex;
  if (!katex) return `<code>${escapeHtml(latex)}</code>`;
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: false, output: "html" });
  } catch {
    return `<code>${escapeHtml(latex)}</code>`;
  }
}

function renderMarkdown(src: string, allowMermaid = false): string {
  const codeBlocks: string[] = [];
  const mermaidBlocks: string[] = [];
  const mathBlocks: string[] = [];
  // pull out math first (before escaping/formatting) so LaTeX is untouched.
  //   display:  \[ ... \]   or  $$ ... $$
  //   inline:   \( ... \)   or  $ ... $
  src = src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), true)); return `@@MATH${mathBlocks.length - 1}@@`; })
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), true)); return `@@MATH${mathBlocks.length - 1}@@`; })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), false)); return `@@MATH${mathBlocks.length - 1}@@`; })
    .replace(/\$([^$\n]+?)\$/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), false)); return `@@MATH${mathBlocks.length - 1}@@`; });
  // pull out fenced blocks first so their contents aren't reformatted
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
    const code = body.replace(/\n$/, "");
    if (allowMermaid && lang === "mermaid") {
      mermaidBlocks.push(escapeHtml(code));
      return `@@MERMAID${mermaidBlocks.length - 1}@@`;
    }
    codeBlocks.push(escapeHtml(code));
    return `@@CODE${codeBlocks.length - 1}@@`;
  });
  text = escapeHtml(text);

  const inline = (s: string): string =>
    s.replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
     .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
     .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
     .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");

  const lines = text.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  for (const raw of lines) {
    const line = raw.trimEnd();
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inline(m[2])}</h${lvl}>`);
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inline(m[1])}</li>`);
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote>${inline(m[1])}</blockquote>`);
    } else if (line.trim() === "") {
      closeList();
      out.push("");
    } else {
      closeList();
      out.push(`<p>${inline(line)}</p>`);
    }
  }
  closeList();

  let html = out.join("\n");
  html = html.replace(/@@CODE(\d+)@@/g, (_m, i) => `<pre><code>${codeBlocks[+i]}</code></pre>`);
  html = html.replace(/@@MERMAID(\d+)@@/g, (_m, i) =>
    `<div class="mermaid-pending" data-code="${mermaidBlocks[+i]}"></div>`);
  html = html.replace(/@@MATH(\d+)@@/g, (_m, i) => mathBlocks[+i]);
  return html;
}

/** After messages are in the DOM, turn pending mermaid blocks into rendered SVG. */
let mermaidSeq = 0;
async function renderMermaidBlocks(): Promise<void> {
  const mermaid = (window as any).mermaid;
  const nodes = Array.from(messagesEl.querySelectorAll(".mermaid-pending")) as HTMLElement[];
  for (const node of nodes) {
    const code = node.getAttribute("data-code") || "";
    node.removeAttribute("data-code");
    node.classList.remove("mermaid-pending");
    if (!mermaid) { node.innerHTML = `<pre><code>${escapeHtml(code)}</code></pre>`; continue; }
    try {
      const { svg } = await mermaid.render("mmd" + mermaidSeq++, code);
      node.innerHTML = svg;
      node.classList.add("mermaid-rendered");
    } catch {
      node.innerHTML = `<pre class="mermaid-err"><code>${escapeHtml(code)}</code></pre>`;
    }
  }
}

/** Split streamed text into [thinking, answer], tolerant of an unclosed tag mid-stream. */
function splitThinking(text: string): [string, string] {
  let m = text.match(/<thinking>([\s\S]*?)<\/thinking>([\s\S]*)/);
  if (m) return [m[1].trim(), m[2].trim()];
  m = text.match(/<thinking>([\s\S]*)/);
  if (m) return [m[1].trim(), ""];
  return ["", text.trim()];
}

/** Turn "(Doc... p.12)" citations into underlined links. Operates on already-rendered
 *  (HTML-safe) markup, so it composes after renderMarkdown without double-escaping. */
function linkifyCitationsHtml(html: string, sources: Source[]): string {
  return html.replace(/\(([^()]*?p\.?\s?(\d+))\)/g, (whole, _inner, pageStr) => {
    const page = parseInt(pageStr, 10);
    const src = sources.find((s) => s.page === page);
    if (!src) return whole;
    return `<a class="fig" data-img="${escapeHtml(src.image)}">${whole}</a>`;
  });
}

function traceRow(ev: ToolEvent, pending = false): string {
  const detail = ev.detail.map((d) => `<div class="trace-detail">⎿ ${escapeHtml(d)}</div>`).join("");
  const dbg = (debug ? ev.debug : []).map(
    (d) => `<div class="trace-detail debug">· ${escapeHtml(d)}</div>`).join("");
  const dur = pending ? "" : `<span class="dur">  ${ev.duration.toFixed(2)}s</span>`;
  const bullet = pending ? "○" : "⏺";
  return `<div class="trace-row${pending ? " trace-pending" : ""}">` +
    `<span class="bullet">${bullet}</span> <span class="name">${escapeHtml(ev.name)}</span> ` +
    `<span class="args">${escapeHtml(ev.args)}</span>${dur}</div>${detail}${dbg}`;
}

function renderAssistant(m: AssistantMsg): string {
  let html = ``;
  if (m.trace.length) {
    html += `<div class="trace">${m.trace.map((e) => traceRow(e)).join("")}` +
      (m.done ? "" : traceRow({ type: "tool", name: "…", args: "", detail: [], debug: [], duration: 0 }, true)) +
      `</div>`;
  } else if (!m.done) {
    html += `<div class="trace">${traceRow({ type: "tool", name: "thinking", args: "", detail: [], debug: [], duration: 0 }, true)}</div>`;
  }
  // thinking panel (live while streaming, collapsible afterwards)
  if (m.thinking) {
    const openAttr = m.done ? "" : " open";
    html += `<details class="thinking"${openAttr}><summary>🧠 thinking</summary>` +
      `<div class="think-body">${escapeHtml(m.thinking)}${m.streaming && !m.text ? '<span class="cursor">▋</span>' : ""}</div></details>`;
  }
  if (m.error) {
    html += `<div class="err-text">⚠ ${escapeHtml(m.error)}</div>`;
  } else if (m.text !== undefined && m.text !== "") {
    const cursor = m.streaming ? '<span class="cursor">▋</span>' : "";
    const body = linkifyCitationsHtml(renderMarkdown(m.text, m.done === true), m.sources || []);
    html += `<div class="answer"><span class="dot">●</span> ${body}${cursor}</div>`;
    if (m.calculations && m.calculations.length) {
      const rows = m.calculations.map((c) => {
        const icon = !c.ok ? '<span class="calc-bad">✕</span>'
          : c.verified ? '<span class="calc-ok">✓</span>'
          : '<span class="calc-warn">⚠</span>';
        const rhs = c.ok ? escapeHtml(c.result || "") : escapeHtml(c.error || "error");
        return `<div class="calc-row">${icon} <code>${escapeHtml(c.expression)}</code> = <b>${rhs}</b></div>`;
      }).join("");
      html += `<details class="calcs" open><summary>🧮 verified calculations (${m.calculations.length})</summary>${rows}</details>`;
    }
    if (m.sources && m.sources.length) {
      const chips = m.sources.map(
        (s) => `<span class="fig-chip" data-img="${escapeHtml(s.image)}">📄 ${escapeHtml(s.doc)} p.${s.page}</span>`).join("");
      html += `<div class="sources">${chips}</div>`;
    }
    if (m.usage && m.usage.total) {
      const r = m.usage.reasoning ? ` · ${m.usage.reasoning} reasoning` : "";
      html += `<div class="usage">▮ ${m.usage.prompt} in + ${m.usage.completion} out = ` +
        `${m.usage.total} tokens${r} · ${escapeHtml(m.model || visionModel)}</div>`;
    }
  }
  return html;
}

function renderMessages(): void {
  const t = activeThread();
  messagesEl.innerHTML = "";
  if (!t || t.messages.length === 0) {
    messagesEl.innerHTML = `<div class="empty-hint">What can I help with?</div><div class="empty-hint-sub" style="text-align: center;">Ask a question about your indexed PDFs. Figures in answers are underlined — click to open the page.</div>`;
    return;
  }
  for (const m of t.messages) {
    const div = document.createElement("div");
    div.className = "msg " + m.kind;
    if (m.kind === "user") {
      div.innerHTML = `<div class="bubble">${escapeHtml(m.text)}</div>`;
    } else {
      div.innerHTML = renderAssistant(m);
    }
    messagesEl.appendChild(div);
  }
  messagesEl.scrollTop = messagesEl.scrollHeight;
  void renderMermaidBlocks(); // render any mermaid diagrams now in the DOM
}

// ---- sending ---------------------------------------------------------------
function send(): void {
  const t = activeThread();
  const question = inputEl.value.trim();
  if (!t || !question || t.busy) return;

  if (t.messages.length === 0) t.title = question.slice(0, 40);
  const reqId = uid();
  t.messages.push({ kind: "user", text: question });
  t.messages.push({ kind: "assistant", reqId, trace: [], done: false });
  t.busy = true;
  reqToThread.set(reqId, t.id);

  window.api.sendRequest({ type: "query", reqId, question, history: t.history, debug, model: selectedModel });

  inputEl.value = "";
  autoSize();
  setBusy(true);
  renderThreads();
  renderMessages();
  saveState();
}

function setBusy(b: boolean): void {
  sendBtn.disabled = b;
  sendBtn.textContent = b ? "…" : "Send";
}

// ---- backend events --------------------------------------------------------
function findAssistant(reqId: string): { thread: Thread; msg: AssistantMsg } | null {
  const tid = reqToThread.get(reqId);
  const thread = threads.find((t) => t.id === tid);
  if (!thread) return null;
  const msg = thread.messages.find(
    (m) => m.kind === "assistant" && m.reqId === reqId) as AssistantMsg | undefined;
  return msg ? { thread, msg } : null;
}

window.api.onServeEvent((ev: ServeEvent) => {
  if (ev.type === "ready") {
    const r = ev as ReadyEvent;
    visionModel = r.vision_model;
    if (r.models) renderModelSelect(r.models, r.default_model || "");
    statusEl.classList.remove("err");
    statusEl.textContent = `${r.chunks} chunks · ${r.docs.length} document(s)`;
    renderDocs(r.docs);
    return;
  }
  if (ev.type === "error" && !(ev as BackendError).reqId) {
    statusEl.classList.add("err");
    statusEl.textContent = (ev as BackendError).message;
    return;
  }
  const reqId = (ev as { reqId?: string }).reqId;
  if (!reqId) return;
  const found = findAssistant(reqId);
  if (!found) return;
  const { thread, msg } = found;

  if (ev.type === "tool") {
    msg.trace.push(ev as ToolEvent);
  } else if (ev.type === "delta") {
    msg.raw = (msg.raw || "") + (ev as DeltaEvent).text;
    const [think, ans] = splitThinking(msg.raw);
    msg.thinking = think; msg.text = ans; msg.streaming = true;
  } else if (ev.type === "answer") {
    const a = ev as AnswerEvent;
    msg.text = a.text; msg.thinking = a.thinking ?? msg.thinking;
    msg.sources = a.sources; msg.usage = a.usage; msg.calculations = a.calculations;
    msg.model = a.model; msg.streaming = false; msg.done = true;
    if (a.usage && a.usage.total) updateTokenStats(a.usage);
    saveState();
    thread.history.push({ role: "user", content: lastUserText(thread) });
    thread.history.push({ role: "assistant", content: a.text });
    thread.history = thread.history.slice(-8);
    thread.busy = false;
    if (thread.id === activeId) setBusy(false);
  } else if (ev.type === "error") {
    msg.error = (ev as BackendError).message; msg.done = true;
    thread.busy = false;
    if (thread.id === activeId) setBusy(false);
  }
  if (thread.id === activeId) renderMessages();
});

window.api.onServeLog((line: string) => console.log("[backend]", line));

function lastUserText(t: Thread): string {
  for (let i = t.messages.length - 1; i >= 0; i--) {
    const m = t.messages[i];
    if (m.kind === "user") return m.text;
  }
  return "";
}

// ---- figure clicks (event delegation) --------------------------------------
messagesEl.addEventListener("click", (e) => {
  const el = (e.target as HTMLElement).closest("[data-img]") as HTMLElement | null;
  if (!el) return;
  const img = el.getAttribute("data-img");
  if (img) window.api.openFigure(img);
});

// ---- composer behaviour ----------------------------------------------------
function autoSize(): void {
  inputEl.style.height = "auto";
  inputEl.style.height = Math.min(inputEl.scrollHeight, 180) + "px";
}
inputEl.addEventListener("input", autoSize);
inputEl.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); }
});
sendBtn.addEventListener("click", send);
$("new-thread").addEventListener("click", () => { newThread(); inputEl.focus(); });
addPdfBtn.addEventListener("click", addPdfs);
debugToggle.addEventListener("change", () => { debug = debugToggle.checked; renderMessages(); });
modelSelect.addEventListener("change", () => {
  selectedModel = modelSelect.value;
  localStorage.setItem("pdf_qa_model", selectedModel);
});

// Cmd/Ctrl+N → new thread
window.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "n") {
    e.preventDefault();
    newThread();
    inputEl.focus();
  }
});

// ---- boot ------------------------------------------------------------------
const _mermaid = (window as any).mermaid;
if (_mermaid) _mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });

if (loadState()) { renderThreads(); renderMessages(); }
else newThread();
inputEl.focus();
// Backstop for the startup race: explicitly ask the backend for its status,
// in case the initial "ready" was emitted before this listener existed.
window.api.sendRequest({ type: "info" });
