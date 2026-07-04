/**
 * Electron main process.
 *
 * Spawns the Python backend (`python -m pdf_qa.serve`) and bridges its
 * line-delimited JSON protocol to the renderer via tRPC (electron-trpc IPC
 * transport): one-shot calls are mutations/queries, the backend's event feeds
 * are tRPC subscriptions. Also opens documents / page images in the OS viewer.
 */
import { app, BrowserWindow, shell, dialog, Menu, MenuItemConstructorOptions, clipboard } from "electron";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import { EventEmitter } from "events";
import * as readline from "readline";
import * as path from "path";
import * as fs from "fs";
import * as os from "os";
import { createIPCHandler } from "electron-trpc/main";
import logger from "electron-log/main";
import { readSettings, writeSettings, Settings } from "./settings";
import { createAppRouter, RouterDeps } from "./trpc";
import { checkForUpdates, initAutoUpdater, installDownloadedUpdate, getUpdateState } from "./updater";
import type { UpdateState } from "./trpc";
import { APP_NAME } from "./branding";
import { initAnalytics, setAnalyticsEnabled, track } from "./analytics";
import { initErrorReporting, setErrorReportingEnabled, backendSentryEnv, recordLog } from "./errors";

let win: BrowserWindow | null = null;
let serve: ChildProcessWithoutNullStreams | null = null;
let restarting = false;  // set while we intentionally kill+respawn the backend

app.setName(APP_NAME);

// project root = parent of the app/ directory (dist/ -> app/ -> project/)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = process.env.PDF_QA_PYTHON || "python3";
const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";

// --- backend command resolution ---------------------------------------------
// In development we run the Python source directly (`python3 -m pdf_qa.<sub>`).
// In a packaged build there is no interpreter or source tree: PyInstaller has
// frozen everything into a standalone binary shipped under Resources/backend
// (see pdf_qa_backend.spec + electron-builder.yml). The frozen binary takes the
// sub-command as its first argument instead of `-m pdf_qa.<sub>`.
const FROZEN_BACKEND_DIR = path.join(process.resourcesPath ?? "", "backend");

function backendCommand(sub: "serve" | "ingest", extra: string[] = []): {
  cmd: string; args: string[]; cwd: string;
} {
  if (app.isPackaged) {
    const exe = process.platform === "win32" ? "pdf-qa-backend.exe" : "pdf-qa-backend";
    return {
      cmd: path.join(FROZEN_BACKEND_DIR, exe),
      args: [sub, ...extra],
      cwd: FROZEN_BACKEND_DIR,
    };
  }
  return { cmd: PYTHON, args: ["-u", "-m", `pdf_qa.${sub}`, ...extra], cwd: PROJECT_ROOT };
}

// --- debug logging ----------------------------------------------------------
// electron-log handles the console + file sinks and rotation for us. On macOS
// the file lands in ~/Library/Logs/<App>/main.log, which Console.app reads. We
// override the file/console format to the classic syslog line
// `MMM D HH:MM:SS host PROC[pid]: message` so Console parses the timestamp,
// host and process columns. Set PDF_QA_DEBUG=0 to silence verbose info lines
// (warnings and errors always log).
const DEBUG = process.env.PDF_QA_DEBUG !== "0";
const LOG_HOST = os.hostname().split(".")[0];
const LOG_PROC = `${APP_NAME}[${process.pid}]`;

const SYSLOG_MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
                       "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** Syslog timestamp: `Jun  8 09:04:01` (day space-padded to width 2). */
function syslogTimestamp(d: Date): string {
  const day = String(d.getDate()).padStart(2, " ");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  return `${SYSLOG_MONTHS[d.getMonth()]} ${day} ${hh}:${mm}:${ss}`;
}

// Render every electron-log message as a single syslog/ASL line. The leading
// `MMM D HH:MM:SS host PROC[pid]:` prefix is what Console keys off of; the
// `[main] [level] …` text after the colon is the free-form message.
// Return a single-element array, not a string: the console transport runs
// further style transforms over the result and calls data.reduce on it.
const syslogFormat = ({ message }: { message: { date: Date; level: string; data: unknown[] } }): string[] => {
  const text = message.data
    .map((d) => (typeof d === "string" ? d : JSON.stringify(d)))
    .join(" ");
  return [`${syslogTimestamp(message.date)} ${LOG_HOST} ${LOG_PROC}: [main] [${message.level}] ${text}`];
};

logger.transports.file.fileName = "main.log";
logger.transports.file.format = syslogFormat as never;
logger.transports.console.format = syslogFormat as never;
const logLevel = DEBUG ? "info" : "warn";
logger.transports.file.level = logLevel;
logger.transports.console.level = logLevel;

function logFilePath(): string | null {
  try { return logger.transports.file.getFile().path; }
  catch { return null; }   // app not ready yet
}

function openLog(): void {
  log("info", `=== session start · ${new Date().toISOString()} · v${app.getVersion()} · python=${PYTHON} ===`);
  log("info", `log file: ${logFilePath()}`);
}

function log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  let line = msg;
  if (extra !== undefined) {
    let tail: string;
    try { tail = typeof extra === "string" ? extra : JSON.stringify(extra); }
    catch { tail = "[unserialisable]"; }
    line = `${msg} ${tail}`;
  }
  logger[level](line);
  // Forward to Sentry (stream to Logs + buffer for error context). No-op until
  // Sentry has initialised and the user is opted in.
  recordLog(level, line);
}

async function openLogsAction(): Promise<void> {
  const p = logFilePath();
  if (!p) return;
  openLog();
  log("info", `open-logs ${p}`);
  const err = await shell.openPath(p);
  if (err) {
    log("warn", `open-logs failed: ${err}`);
    shell.showItemInFolder(p);
  }
}

/** Compact, truncated preview of an IPC/protocol payload for the logs. */
function preview(obj: unknown, max = 200): string {
  let s: string;
  try { s = typeof obj === "string" ? obj : JSON.stringify(obj); }
  catch { return "[unserialisable]"; }
  return s.length > max ? s.slice(0, max) + `…(+${s.length - max})` : s;
}

// All app data (PDF index, page renders, threads.db) lives under the per-user
// Electron directory. Resolved lazily — app.getPath is only valid once ready.
function dataDir(): string {
  return app.getPath("userData");
}

// The active collection (independent library) is persisted here and applied to
// the backend env on spawn. Switching collections respawns the backend, matching
// how settings changes are applied.
function activeCollectionPath(): string {
  return path.join(dataDir(), "active-collection.txt");
}

function getActiveCollection(): string {
  try {
    const v = fs.readFileSync(activeCollectionPath(), "utf-8").trim();
    return v || "default";
  } catch {
    return "default";
  }
}

function setActiveCollectionFile(name: string): void {
  try {
    fs.writeFileSync(activeCollectionPath(), (name || "default").trim());
  } catch (e) {
    log("warn", "could not persist active collection", (e as Error).message);
  }
}

// Directory holding a collection's index. "default" keeps the historical layout
// (index directly under DATA_DIR); named collections nest under collections/<name>.
function collectionIndexDir(name: string): string {
  return name && name.toLowerCase() !== "default"
    ? path.join(dataDir(), "collections", name, "index")
    : path.join(dataDir(), "index");
}

function cleanupTempThreadIndexes(): void {
  try {
    fs.rmSync(path.join(dataDir(), "temp-threads"), { recursive: true, force: true });
  } catch (e) {
    log("warn", "could not clean temp thread indexes", (e as Error).message);
  }
}

function backupIfExists(filePath: string, stamp: string): void {
  if (!fs.existsSync(filePath)) return;
  const backup = `${filePath}.pre-migration-${stamp}`;
  fs.renameSync(filePath, backup);
  log("info", `backed up ${filePath} -> ${backup}`);
}

function copyLegacyDataIfNeeded(): void {
  const current = dataDir();
  const legacy = path.join(path.dirname(current), "pdf-qa-desktop");
  if (!fs.existsSync(legacy) || legacy === current) return;

  const currentStore = path.join(current, "index", "store.npy");
  const legacyStore = path.join(legacy, "index", "store.npy");
  if (fs.existsSync(currentStore) || !fs.existsSync(legacyStore)) return;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  log("info", `migrating legacy app data from ${legacy} to ${current}`);

  fs.mkdirSync(current, { recursive: true });
  const currentIndex = path.join(current, "index");
  if (fs.existsSync(currentIndex)) {
    fs.renameSync(currentIndex, `${currentIndex}.pre-migration-${stamp}`);
  }
  fs.cpSync(path.join(legacy, "index"), currentIndex, { recursive: true });

  for (const name of ["threads.db", "settings.json", "docpaths.json"]) {
    const src = path.join(legacy, name);
    const dst = path.join(current, name);
    if (!fs.existsSync(src)) continue;
    backupIfExists(dst, stamp);
    fs.copyFileSync(src, dst);
  }
}

// --- document source paths --------------------------------------------------
// The index only records a PDF's *filename*, but to "open" a document we want
// its original file. We remember filename -> absolute source path whenever a PDF
// is ingested, persisted to <userData>/docpaths.json so it survives restarts.
function docPathsFile(): string {
  return path.join(dataDir(), "docpaths.json");
}

function readDocPaths(): Record<string, string> {
  try { return JSON.parse(fs.readFileSync(docPathsFile(), "utf-8")); }
  catch { return {}; }
}

function rememberDocPaths(filePaths: string[]): void {
  const map = readDocPaths();
  for (const fp of filePaths) map[path.basename(fp)] = fp;
  try {
    fs.writeFileSync(docPathsFile(), JSON.stringify(map, null, 2));
    log("info", `remembered ${filePaths.length} doc path(s)`);
  } catch (e) {
    log("warn", "could not persist docpaths.json", (e as Error).message);
  }
}

function forgetDocPath(name: string): void {
  const map = readDocPaths();
  if (name in map) {
    delete map[name];
    try { fs.writeFileSync(docPathsFile(), JSON.stringify(map, null, 2)); }
    catch (e) { log("warn", "could not update docpaths.json", (e as Error).message); }
  }
}

/** Resolve a document name to an openable file: the original PDF if we still
 *  have it, otherwise the rendered first page (mirrors ingest's safe-name rule). */
function resolveDocTarget(name: string): string | null {
  const known = readDocPaths()[name];
  if (known && fs.existsSync(known)) return known;
  const safe = name.replace(/\.pdf$/i, "").replace(/ /g, "_");
  const firstPage = path.join(dataDir(), "index", "pages", safe, "p0001.png");
  if (fs.existsSync(firstPage)) return firstPage;
  return known || null;   // last resort: the remembered path even if missing
}

// Event bus the tRPC subscriptions listen on. The backend emits its "ready"
// event within milliseconds of spawning — often before the renderer has
// subscribed — so serve events are buffered until the first subscriber attaches,
// then replayed, ensuring nothing is lost.
const bus = new EventEmitter();
bus.setMaxListeners(0);
let serveSubscribed = false;
const serveBuffer: unknown[] = [];

function emitServe(ev: unknown): void {
  if (serveSubscribed) bus.emit("serve-event", ev);
  else serveBuffer.push(ev);
}
function emitIngest(ev: unknown): void { bus.emit("ingest-event", ev); }
function emitLog(line: string): void { bus.emit("serve-log", line); }

function backendEnv(): NodeJS.ProcessEnv {
  const DATA_DIR = dataDir();
  const collection = getActiveCollection();
  const INDEX_DIR = collectionIndexDir(collection);
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const settings = readSettings();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PDF_QA_DATA_DIR: DATA_DIR,
    INDEX_DIR,
    PDF_QA_COLLECTION: collection,
  };
  // Keys set in the settings page take precedence over any inherited / .env value.
  if (settings.openaiKey) env.OPENAI_API_KEY = settings.openaiKey;
  if (settings.anthropicKey) env.ANTHROPIC_API_KEY = settings.anthropicKey;
  if (settings.openrouterKey) env.OPENROUTER_API_KEY = settings.openrouterKey;
  // AWS Bedrock (OpenAI-compatible gateway). The key is a bearer token; region
  // defaults are handled in the backend. Setting the key enables the provider.
  if (settings.bedrockApiKey) env.BEDROCK_API_KEY = settings.bedrockApiKey;
  if (settings.bedrockRegion.trim()) env.BEDROCK_REGION = settings.bedrockRegion.trim();
  // Let the backend report crashes/errors into the same Sentry project, but
  // only while the user is opted in (and only if a DSN is configured at all).
  Object.assign(env, backendSentryEnv(settings.analyticsEnabled !== false));
  if (settings.systemPrompt.trim()) env.PDF_QA_SYSTEM_PROMPT = settings.systemPrompt;
  // Local OpenAI-compatible server (Ollama, LM Studio, …). The backend offers
  // local answerers when a model is set. Blank row URLs fall back to Ollama's
  // OpenAI-compatible default; each row can still override it.
  const localModels = (settings.localModels || [])
    .map((m) => ({
      base_url: m.baseUrl.trim() || settings.localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL,
      api_key: m.apiKey.trim() || "local",
      model: m.model.trim(),
      text_only: !!m.textOnly,
    }))
    .filter((m) => m.model);
  if (!localModels.length && settings.localModel.trim()) {
    localModels.push({
      base_url: settings.localBaseUrl.trim() || DEFAULT_LOCAL_BASE_URL,
      api_key: settings.localApiKey.trim() || "local",
      model: settings.localModel.trim(),
      text_only: false,
    });
  }
  if (localModels.length) {
    env.LOCAL_MODELS = JSON.stringify(localModels);
    env.LOCAL_BASE_URL = localModels[0].base_url;
    env.LOCAL_API_KEY = localModels[0].api_key;
    env.LOCAL_MODEL = localModels[0].model;
  }
  return env;
}

// --- analytics: model attribution ------------------------------------------
// Built from each backend "ready" event so questions/answers can be attributed
// to a provider + concrete model without parsing strings. `reqModel`/`reqTools`
// carry the chosen model and the agentic tool-call counts from a query through
// to its answer/error (keyed by reqId).
interface ModelMeta { provider: string; model: string; via_openrouter: boolean; }
interface ReqTools { searches: number; getPages: number; }
const modelCatalog = new Map<string, ModelMeta>();   // model id -> meta
const reqModel = new Map<string, ModelMeta>();        // reqId -> model used
const reqTools = new Map<string, ReqTools>();         // reqId -> in-flight tool counts
let sessionReadyTracked = false;

function modelProps(meta?: ModelMeta): Record<string, string | boolean> {
  return meta ? { provider: meta.provider, model: meta.model, via_openrouter: meta.via_openrouter } : {};
}

// Drop any per-request state once an answer/error closes it out (or a query is
// abandoned), so the maps can't grow without bound over a long session.
function clearReqState(reqId?: string): void {
  if (!reqId) return;
  reqModel.delete(reqId);
  reqTools.delete(reqId);
}

// Bucket a backend error message into a coarse, content-free category. The raw
// message can contain file paths or document text, so it is NEVER forwarded —
// only this enum is.
function errorKind(message: unknown): string {
  const m = typeof message === "string" ? message.toLowerCase() : "";
  if (!m) return "unknown";
  if (m.includes("no index") || m.includes("build the index")) return "no_index";
  if (m.includes("no documents are enabled")) return "no_docs_enabled";
  if (m.includes("could not start python") || m.includes("spawn")) return "spawn_failed";
  if (m.includes("modulenotfound") || (m.includes("module") && m.includes("not found"))) return "missing_module";
  if (m.includes("exited")) return "backend_exited";
  if (m.includes("unauthor") || m.includes("api key") || m.includes("401")) return "auth";
  if (m.includes("rate limit") || m.includes("429")) return "rate_limit";
  if (m.includes("timeout") || m.includes("timed out")) return "timeout";
  if (m.includes("connection") || m.includes("network") || m.includes("econn")) return "network";
  return "other";
}

// Refresh the catalog from a "ready" event and, once per session, report the
// configured providers + library size (counts only, never document names).
function updateModelCatalog(ev: {
  models?: { id?: string; provider?: string; model?: string; via_openrouter?: boolean }[];
  docs?: unknown[]; chunks?: number;
}): void {
  if (Array.isArray(ev.models)) {
    modelCatalog.clear();
    for (const m of ev.models) {
      if (m && typeof m.id === "string") {
        modelCatalog.set(m.id, {
          provider: m.provider || "other",
          model: m.model || m.id,
          via_openrouter: !!m.via_openrouter,
        });
      }
    }
  }
  if (!sessionReadyTracked && modelCatalog.size) {
    sessionReadyTracked = true;
    const providers = [...new Set([...modelCatalog.values()].map((m) => m.provider))].sort();
    track("session_ready", {
      model_count: modelCatalog.size,
      providers: providers.join(",") || "none",
      library_documents: Array.isArray(ev.docs) ? ev.docs.length : 0,
      library_chunks: typeof ev.chunks === "number" ? ev.chunks : 0,
    });
  }
}

// Translate a backend stdout event into an anonymous analytics event. Only
// counts/latencies/providers/model ids are forwarded — never answer text,
// sources, error messages, or document names.
function trackBackendEvent(obj: unknown): void {
  const ev = obj as {
    type?: string; reqId?: string; name?: string; message?: string; latency?: number; model?: string;
    usage?: { prompt?: number; completion?: number; total?: number; reasoning?: number };
    sources?: unknown[]; calculations?: unknown[];
    models?: { id?: string; provider?: string; model?: string; via_openrouter?: boolean }[];
    docs?: unknown[]; chunks?: number;
  };
  if (!ev || typeof ev.type !== "string") return;
  if (ev.type === "ready") { updateModelCatalog(ev); return; }
  if (ev.type === "tool" && ev.reqId && (ev.name === "search_documents" || ev.name === "get_pages")) {
    // The backend emits a search_documents/get_pages tool row for both the initial
    // retrieval and each model-driven re-fetch — counting them shows how heavily
    // the agentic loop is used. (calculate is reported via the answer's calc list.)
    const agg = reqTools.get(ev.reqId) || { searches: 0, getPages: 0 };
    if (ev.name === "search_documents") agg.searches++; else agg.getPages++;
    reqTools.set(ev.reqId, agg);
    return;
  }
  if (ev.type === "answer") {
    const meta = ev.reqId ? reqModel.get(ev.reqId) : undefined;
    const tools = ev.reqId ? reqTools.get(ev.reqId) : undefined;
    const props: Record<string, string | number | boolean> = { ...modelProps(meta) };
    if (!meta && ev.model) props.model = ev.model;   // fallback when the selection wasn't in the catalog
    if (typeof ev.latency === "number") props.latency_ms = Math.round(ev.latency * 1000);
    if (ev.usage) {
      if (typeof ev.usage.prompt === "number") props.prompt_tokens = ev.usage.prompt;
      if (typeof ev.usage.completion === "number") props.completion_tokens = ev.usage.completion;
      if (typeof ev.usage.total === "number") props.total_tokens = ev.usage.total;
      if (ev.usage.reasoning) props.reasoning_tokens = ev.usage.reasoning;
    }
    if (Array.isArray(ev.sources)) props.num_sources = ev.sources.length;
    if (Array.isArray(ev.calculations)) props.num_calculations = ev.calculations.length;
    props.num_searches = tools?.searches ?? 0;       // incl. the initial retrieval
    props.num_get_pages = tools?.getPages ?? 0;      // model-driven page fetches
    track("answer_received", props);
    clearReqState(ev.reqId);
  } else if (ev.type === "error" && ev.reqId) {
    track("answer_error", { ...modelProps(reqModel.get(ev.reqId)), kind: errorKind(ev.message) });
    clearReqState(ev.reqId);
  } else if (ev.type === "error") {
    // No reqId → an app/backend-level failure (spawn, exit, missing index/key).
    track("backend_error", { kind: errorKind(ev.message) });
  }
}

// Ingest failures, by category — never the raw message (it can carry paths).
function trackIngestEvent(ev: { type?: string; reason?: string }): void {
  if (!ev || typeof ev.type !== "string") return;
  if (ev.type === "ingest_error") track("ingest_failed");
  else if (ev.type === "file_error") track("file_failed");
  else if (ev.type === "file_skip") {
    const r = (ev.reason || "").toLowerCase();
    const reason = r.includes("already") ? "already_indexed" : r.includes("not found") ? "not_found" : "other";
    track("file_skipped", { reason });
  }
}

// Once-per-install activation markers (e.g. first PDF, first question). Backed by
// a stamp file under userData so the funnel survives restarts; returns true the
// first time only. Never throws.
function firstTime(marker: string): boolean {
  const f = path.join(dataDir(), "analytics-markers", marker);
  try {
    if (fs.existsSync(f)) return false;
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, new Date().toISOString());
    return true;
  } catch { return false; }
}

function startBackend(): void {
  const { cmd, args, cwd } = backendCommand("serve");
  log("info", `spawning backend: ${cmd} ${args.join(" ")} (cwd=${cwd})`);
  serve = spawn(cmd, args, {
    cwd,
    env: backendEnv(),
    windowsHide: true,   // hide the frozen backend's console window on Windows
  });
  log("info", `backend pid=${serve.pid ?? "?"}`);

  let sawBackendError = false;
  let stderrTail = "";

  const rl = readline.createInterface({ input: serve.stdout });
  rl.on("line", (line: string) => {
    line = line.trim();
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === "error") { sawBackendError = true; log("error", "backend event: error", preview(obj)); }
      else log("info", `backend event: ${obj?.type ?? "?"}`, preview(obj));
      trackBackendEvent(obj);
      emitServe(obj);
    } catch {
      // non-JSON stdout (e.g. stray print) — surface as a log
      log("info", "backend stdout (non-JSON)", preview(line));
      emitLog(line);
    }
  });

  let errBuf = "";
  serve.stderr.on("data", (d: Buffer) => {
    errBuf += d.toString();
    stderrTail = (stderrTail + d.toString()).slice(-2000);
    const parts = errBuf.split("\n");
    errBuf = parts.pop() || "";
    for (const p of parts) if (p.trim()) {
      // Elevate the loud OCR-unavailable banner from the backend to error level
      // so a missing/broken bundled tesseract stands out in the logs.
      const level = /OCR UNAVAILABLE/i.test(p) ? "error" : "warn";
      log(level, "backend stderr", preview(p, 500));
      emitLog(p);
    }
  });

  serve.on("error", (e: Error) => {
    log("error", "backend spawn error", e.message);
    emitServe({
      type: "error",
      message: `Could not start Python "${PYTHON}": ${e.message}. ` +
        `Point the app at the interpreter that has the project's deps: ` +
        `PDF_QA_PYTHON=/path/to/python npm start`,
    });
  });

  serve.on("exit", (code: number | null) => {
    log(code === 0 ? "info" : "warn", `backend exited (code ${code ?? "?"})`);
    if (restarting) { restarting = false; return; } // intentional restart (e.g. after settings change)
    if (code === 0 || sawBackendError) return; // clean exit, or a specific error was already shown
    // Surface the real reason from Python's stderr (e.g. ModuleNotFoundError, traceback).
    const reason = stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" · ");
    emitServe({
      type: "error",
      message: `Backend (${PYTHON}) exited (code ${code ?? "?"}). ` +
        (reason ? `Reason: ${reason}` :
          `Ensure the index is built (python -m pdf_qa.ingest) and deps are installed for this interpreter.`),
    });
  });
}

function createWindow(): void {
  // Window/taskbar icon for Windows & Linux (macOS uses the app bundle's .icns).
  // In a packaged app the exe already carries the icon; this mainly helps dev.
  const iconPath = path.join(__dirname, "..", "build", "icon.png");
  const windowIcon = process.platform !== "darwin" && fs.existsSync(iconPath) ? iconPath : undefined;
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: APP_NAME,
    icon: windowIcon,
    // Don't show the window until the renderer has painted its first frame, so
    // the user never sees an empty white/vibrancy shell while JS boots.
    show: false,
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 13, y: 13 },
    vibrancy: process.platform === "darwin" ? "under-window" : undefined,
    visualEffectState: "active",
    backgroundColor: "#fbfbfa",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      // electron-trpc's preload bridge requires a non-sandboxed preload so it can
      // require("electron-trpc/main"); context isolation still protects the page.
      sandbox: false,
    },
  });
  // Attach the tRPC IPC handler to this window's webContents.
  createIPCHandler({ router: appRouter, windows: [win] });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  win.once("ready-to-show", () => win?.show());
  win.webContents.on("did-finish-load", () => log("info", "renderer loaded"));
}

function dispatchRendererEvent(name: string): void {
  if (!win) return;
  void win.webContents.executeJavaScript(
    `window.dispatchEvent(new Event(${JSON.stringify(name)}));`,
  );
}

function installApplicationMenu(): void {
  const isMac = process.platform === "darwin";
  const template: MenuItemConstructorOptions[] = [
    ...(isMac ? [{
      label: APP_NAME,
      submenu: [
        { role: "about", label: `About ${APP_NAME}` },
        { label: "Check for Updates…", click: () => { void checkForUpdates(true); } },
        { type: "separator" },
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => dispatchRendererEvent("pdf-qa-open-settings") },
        { label: "Open Logs", click: () => { void openLogsAction(); } },
        { label: "Clear File Index…", click: () => { void clearFileIndexAction(); } },
        { type: "separator" },
        { role: "services" },
        { type: "separator" },
        { role: "hide" },
        { role: "hideOthers" },
        { role: "unhide" },
        { type: "separator" },
        { role: "quit" },
      ],
    } as MenuItemConstructorOptions] : []),
    {
      label: "File",
      submenu: [
        { label: "New Chat", accelerator: "CommandOrControl+N", click: () => dispatchRendererEvent("pdf-qa-new-thread") },
        { type: "separator" },
        { label: "Add PDFs to Index…", accelerator: "CommandOrControl+O", click: () => { void addPdfsAction(); } },
        ...(!isMac ? [
          { type: "separator" } as MenuItemConstructorOptions,
          { label: "Check for Updates…", click: () => { void checkForUpdates(true); } } as MenuItemConstructorOptions,
          { type: "separator" } as MenuItemConstructorOptions,
          { label: "Settings…", accelerator: "CommandOrControl+,", click: () => dispatchRendererEvent("pdf-qa-open-settings") } as MenuItemConstructorOptions,
          { label: "Open Logs", click: () => { void openLogsAction(); } } as MenuItemConstructorOptions,
          { label: "Clear File Index…", click: () => { void clearFileIndexAction(); } } as MenuItemConstructorOptions,
          { type: "separator" } as MenuItemConstructorOptions,
          { role: "quit" } as MenuItemConstructorOptions,
        ] : []),
      ],
    },
    {
      label: "Edit",
      submenu: [
        { role: "undo" },
        { role: "redo" },
        { type: "separator" },
        { role: "cut" },
        { role: "copy" },
        { role: "paste" },
        { role: "selectAll" },
      ],
    },
    {
      label: "View",
      submenu: [
        { role: "reload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    {
      label: "Window",
      submenu: [
        { role: "minimize" },
        { role: "zoom" },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function restartBackend(): void {
  if (serve) {
    restarting = true;
    serve.kill();
  }
  startBackend();
}

// Switch the active collection: persist the choice and respawn the backend so it
// loads that collection's index. Returns the collection now active.
function setCollectionAction(name: string): string {
  const target = (name || "default").trim() || "default";
  if (target === getActiveCollection()) return target;
  setActiveCollectionFile(target);
  log("info", `switching collection -> ${target}`);
  track("collection_switched");
  restartBackend();
  return target;
}

// --- backend actions (exposed to the renderer through the tRPC router) -------
function sendToBackend(req: unknown): void {
  const type = (req as { type?: string })?.type ?? "?";
  if (type === "query") {
    // Count + chosen model only — never the question text, history, or doc names.
    const q = req as { reqId?: string; model?: string; docs?: unknown[] };
    const meta = typeof q.model === "string" ? modelCatalog.get(q.model) : undefined;
    if (q.reqId && meta) reqModel.set(q.reqId, meta);   // carry through to the answer/error
    track("question_asked", {
      doc_count: Array.isArray(q.docs) ? q.docs.length : 0,
      ...modelProps(meta),
    });
    if (firstTime("first_question")) track("first_question_asked", modelProps(meta));
  }
  if (serve && serve.stdin.writable) {
    log("info", `-> backend request: ${type}`, preview(req));
    serve.stdin.write(JSON.stringify(req) + "\n");
  } else {
    log("warn", `dropped request (backend not writable): ${type}`);
  }
}

async function openDocAction(name: string): Promise<string> {
  const target = resolveDocTarget(name);
  log("info", `open-doc "${name}" -> ${target ?? "(unresolved)"}`);
  if (!target) return `Could not locate "${name}".`;
  const err = await shell.openPath(target);
  if (err) log("warn", `open-doc failed: ${err}`);
  return err;
}

async function openFigureAction(filePath: string): Promise<string> {
  log("info", `open-figure ${filePath}`);
  return shell.openPath(filePath);   // "" on success
}

async function removeDocAction(name: string): Promise<void> {
  log("info", `remove-doc "${name}"`);
  forgetDocPath(name);
  // The live backend owns the in-memory index: it removes the chunks, persists,
  // deletes the page images, and emits an updated "ready" event we relay back.
  sendToBackend({ type: "doc_remove", doc: name });
}

async function clearFileIndexAction(): Promise<void> {
  const opts = {
    type: "warning" as const,
    buttons: ["Cancel", "Clear Index"],
    defaultId: 0,
    cancelId: 0,
    message: "Clear the file index?",
    detail: "This removes indexed chunks and rendered page images. Your original PDF files and chats are not deleted.",
  };
  const res = win
    ? await dialog.showMessageBox(win, opts)
    : await dialog.showMessageBox(opts);
  if (res.response !== 1) {
    log("info", "clear-file-index canceled");
    return;
  }

  const indexDir = path.join(dataDir(), "index");
  log("info", `clear-file-index ${indexDir}`);
  try {
    fs.rmSync(indexDir, { recursive: true, force: true });
    fs.rmSync(docPathsFile(), { force: true });
    restartBackend();
  } catch (e) {
    log("error", "clear-file-index failed", (e as Error).message);
    if (win) {
      await dialog.showMessageBox(win, {
        type: "error",
        message: "Could not clear the file index.",
        detail: (e as Error).message,
      });
    }
  }
}

// Native right-click menu for a document in the sidebar.
async function showDocMenuAction(name: string): Promise<void> {
  log("info", `doc-menu "${name}"`);
  const menu = Menu.buildFromTemplate([
    { label: `${name}`, enabled: false },
    { type: "separator" },
    { label: "Open", click: () => { void openDocAction(name); } },
    {
      label: "Remove from index", click: async () => {
        const res = await dialog.showMessageBox(win!, {
          type: "warning", buttons: ["Cancel", "Remove"], defaultId: 1, cancelId: 0,
          message: `Remove "${name}" from the index?`,
          detail: "This deletes its chunks and rendered page images. You can re-add the PDF later.",
        });
        if (res.response === 1) await removeDocAction(name);
      },
    },
  ]);
  menu.popup({ window: win ?? undefined });
}

// Native right-click menu for a chat thread in the sidebar.
async function showThreadMenuAction(
  input: { title: string; messages: unknown[]; markdown?: string; filename?: string },
): Promise<void> {
  log("info", `thread-menu "${input.title}" messages=${input.messages.length}`);
  const md = input.markdown || "";
  const menu = Menu.buildFromTemplate([
    { label: input.title || "Thread", enabled: false },
    { type: "separator" },
    {
      label: "Copy as Markdown",
      enabled: !!md,
      click: () => { clipboard.writeText(md); },
    },
    {
      label: "Export as Markdown…",
      enabled: !!md,
      click: () => { void saveMarkdownFile(md, input.filename || "conversation"); },
    },
    {
      label: "Copy messages as JSON",
      click: () => { clipboard.writeText(JSON.stringify(input.messages || [], null, 2)); },
    },
  ]);
  menu.popup({ window: win ?? undefined });
}

async function saveMarkdownFile(markdown: string, filename: string): Promise<void> {
  if (!win) return;
  const res = await dialog.showSaveDialog(win, {
    title: "Export thread as Markdown",
    defaultPath: `${filename.replace(/[\/:*?"<>|]+/g, "_").slice(0, 60) || "conversation"}.md`,
    filters: [{ name: "Markdown", extensions: ["md"] }],
  });
  if (res.canceled || !res.filePath) { log("info", "export-md canceled"); return; }
  try {
    fs.writeFileSync(res.filePath, markdown, "utf-8");
    log("info", `export-md -> ${res.filePath}`);
    track("thread_exported_md");
    void shell.showItemInFolder(res.filePath);
  } catch (e) {
    log("error", "export-md failed", (e as Error).message);
  }
}

function modelProviderLabel(provider: string): string {
  switch (provider) {
    case "openai": return "OpenAI";
    case "anthropic": return "Anthropic";
    case "zai": return "Z.ai";
    case "local": return "Local";
    case "cli": return "Local CLI";
    default: return provider ? provider[0].toUpperCase() + provider.slice(1) : "Other";
  }
}

function platformMenuLabel(label: string): string {
  return process.platform === "win32" ? label.replace(/\s*·\s*/g, " - ") : label;
}

function modelMenuLabel(model: { label: string; model?: string; provider?: string }): string {
  const provider = modelProviderLabel(model.provider || "");
  const prefix = `${provider} · `;
  if (model.label.startsWith(prefix)) return platformMenuLabel(model.label.slice(prefix.length).replace(/ · OpenRouter$/, ""));
  return platformMenuLabel(model.model || model.label);
}

async function showModelMenuAction(input: {
  models: { id: string; label: string; provider?: string; model?: string; via_openrouter?: boolean }[];
  selectedModel: string;
}): Promise<string | null> {
  log("info", "model-menu", preview(input));
  if (!input.models.length) return null;
  return new Promise((resolve) => {
    let picked: string | null = null;
    const providers: { label: string; models: typeof input.models }[] = [];
    const openRouterProviders: { label: string; models: typeof input.models }[] = [];
    for (const model of input.models) {
      const label = modelProviderLabel(model.provider || model.label.split("·")[0]?.trim() || "");
      const target = model.via_openrouter ? openRouterProviders : providers;
      let group = target.find((p) => p.label === label);
      if (!group) {
        group = { label, models: [] };
        target.push(group);
      }
      group.models.push(model);
    }
    const modelItems = (group: { models: typeof input.models }) => group.models.map((model) => ({
      label: modelMenuLabel(model),
      type: "checkbox",
      checked: model.id === input.selectedModel,
      click: () => {
        picked = model.id;
        track("model_selected", {
          provider: model.provider || "other",
          model: model.model || model.id,
          via_openrouter: !!model.via_openrouter,
        });
        resolve(picked);
      },
    } as MenuItemConstructorOptions));
    const template: MenuItemConstructorOptions[] = [];
    if (openRouterProviders.length) {
      template.push({
        label: "OpenRouter",
        submenu: openRouterProviders.map((group) => ({
          label: group.label,
          submenu: modelItems(group),
        } as MenuItemConstructorOptions)),
      });
    }
    template.push(...providers.map((group) => ({
      label: group.label,
      submenu: modelItems(group),
    } as MenuItemConstructorOptions)));
    const menu = Menu.buildFromTemplate(template);
    menu.popup({
      window: win ?? undefined,
      callback: () => resolve(picked),
    });
  });
}

async function getSettingsAction() {
  return { ...readSettings(), dataDir: dataDir() };
}

async function setSettingsAction(s: Settings): Promise<{ ok: boolean }> {
  log("info", "set-settings (settings updated); restarting backend");
  writeSettings({
    openaiKey: s.openaiKey || "",
    anthropicKey: s.anthropicKey || "",
    openrouterKey: s.openrouterKey || "",
    systemPrompt: s.systemPrompt || "",
    localBaseUrl: s.localBaseUrl || "",
    localApiKey: s.localApiKey || "",
    localModel: s.localModel || "",
    localModels: (s.localModels || []).map((m) => ({
      baseUrl: m.baseUrl || "",
      apiKey: m.apiKey || "",
      model: m.model || "",
      textOnly: !!m.textOnly,
    })),
    bedrockApiKey: s.bedrockApiKey || "",
    bedrockRegion: s.bedrockRegion || "",
    analyticsEnabled: s.analyticsEnabled !== false,
  });
  setAnalyticsEnabled(s.analyticsEnabled !== false);       // honor opt-in/out without a restart
  setErrorReportingEnabled(s.analyticsEnabled !== false);  // same toggle gates Sentry too
  // Which providers are configured + whether a custom prompt is set — booleans
  // and counts only, NEVER the key values or prompt text.
  track("settings_saved", {
    has_openai: !!s.openaiKey,
    has_anthropic: !!s.anthropicKey,
    has_openrouter: !!s.openrouterKey,
    has_bedrock: !!s.bedrockApiKey,
    local_model_count: (s.localModels || []).filter((m) => m.model?.trim()).length,
    has_system_prompt: !!s.systemPrompt?.trim(),
    analytics_enabled: s.analyticsEnabled !== false,
  });
  restartBackend(); // respawn so the Python backend picks up the new keys
  return { ok: true };
}

// Guards against two concurrent main-index ingests. Each ingest process does
// load -> add -> save on the same store, so overlapping runs would clobber each
// other's additions. The sidebar "+", the File ▸ Add PDFs… menu item, and ⌘O all
// funnel through here, so the guard lives here. (Per-chat temp ingests write to
// their own throwaway index dir, so they're unaffected and not guarded.)
let mainIngestInFlight = false;

// Pick PDFs and ingest them incrementally, streaming progress to the renderer.
// The dialog allows selecting many files at once ("multiSelections"); every
// picked file is handed to a single ingest run that processes them concurrently.
async function addPdfsAction(): Promise<{ canceled: boolean; count?: number }> {
  if (!win) return { canceled: true };
  if (mainIngestInFlight) {
    log("info", "add-pdfs ignored: an ingest is already running");
    await dialog.showMessageBox(win, {
      type: "info",
      message: "An ingest is already in progress.",
      detail: "Wait for the current PDFs to finish indexing before adding more.",
    });
    return { canceled: true };
  }
  const picked = await dialog.showOpenDialog(win, {
    title: "Add PDFs to the index",
    buttonLabel: "Add to Index",
    message: "Select one or more PDFs to index (⌘-click or Shift-click for several).",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) { log("info", "add-pdfs canceled"); return { canceled: true }; }

  log("info", `add-pdfs: ${picked.filePaths.length} file(s)`, preview(picked.filePaths, 400));
  rememberDocPaths(picked.filePaths);   // so we can "open" them later

  mainIngestInFlight = true;
  try {
    await new Promise<void>((resolve) => {
      const { cmd, args, cwd } = backendCommand("ingest", ["--add", ...picked.filePaths, "--json"]);
      const proc = spawn(cmd, args, { cwd, env: backendEnv(), windowsHide: true });
      log("info", `ingest pid=${proc.pid ?? "?"}`);
      const rl = readline.createInterface({ input: proc.stdout });
      rl.on("line", (line) => {
        line = line.trim();
        if (!line) return;
        try {
          const ev = JSON.parse(line);
          log("info", `ingest event: ${ev?.type ?? "?"}`, preview(ev));
          if (ev?.type === "ingest_done" && typeof ev.added === "number") {
            track("pdf_ingested", { added: ev.added });
            if (ev.added > 0 && firstTime("first_pdf")) track("first_pdf_added", { added: ev.added });
          }
          trackIngestEvent(ev);
          emitIngest(ev);
        }
        catch { emitLog(line); }
      });
      let err = "";
      proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); log("warn", "ingest stderr", preview(d.toString(), 500)); });
      proc.on("error", (e) => {
        log("error", "ingest spawn error", e.message);
        track("ingest_failed", { kind: "spawn_failed" });
        emitIngest({ type: "ingest_error", message: e.message });
      });
      proc.on("close", (code) => {
        log(code === 0 ? "info" : "warn", `ingest exited (code ${code ?? "?"})`);
        if (code !== 0)
          emitIngest({ type: "ingest_error", message: err.trim().split("\n").slice(-2).join(" ") || `exit ${code}` });
        // tell the live backend to reload the freshly-written index
        sendToBackend({ type: "reload" });
        resolve();
      });
    });
  } finally {
    mainIngestInFlight = false;
  }
  return { canceled: false, count: picked.filePaths.length };
}

async function addTempPdfsAction(input: { threadId: string; filePaths: string[] }): Promise<{ ok: boolean; docs: string[] }> {
  const pdfs = input.filePaths
    .filter((p) => path.extname(p).toLowerCase() === ".pdf")
    .filter((p) => fs.existsSync(p));
  if (!input.threadId || pdfs.length === 0) return { ok: false, docs: [] };

  const safeThread = input.threadId.replace(/[^a-zA-Z0-9_-]/g, "_");
  const tempIndexDir = path.join(dataDir(), "temp-threads", safeThread, String(Date.now()));
  fs.mkdirSync(tempIndexDir, { recursive: true });
  log("info", `temp-pdfs: thread=${input.threadId} files=${pdfs.length}`, preview(pdfs, 400));

  const docs = new Set<string>();
  await new Promise<void>((resolve) => {
    const { cmd, args, cwd } = backendCommand("ingest", ["--add", ...pdfs, "--json", "--force"]);
    const proc = spawn(cmd, args, {
      cwd,
      env: { ...backendEnv(), INDEX_DIR: tempIndexDir },
      windowsHide: true,
    });
    log("info", `temp ingest pid=${proc.pid ?? "?"}`);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      try {
        const ev = JSON.parse(line);
        if (ev?.type === "file_done" && ev.name) docs.add(ev.name);
        log("info", `temp ingest event: ${ev?.type ?? "?"}`, preview(ev));
        trackIngestEvent(ev);
        emitIngest({ ...ev, temp: true, threadId: input.threadId });
      } catch {
        emitLog(line);
      }
    });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); log("warn", "temp ingest stderr", preview(d.toString(), 500)); });
    proc.on("error", (e) => {
      log("error", "temp ingest spawn error", e.message);
      track("ingest_failed", { kind: "spawn_failed" });
      emitIngest({ type: "ingest_error", temp: true, threadId: input.threadId, message: e.message });
    });
    proc.on("close", (code) => {
      log(code === 0 ? "info" : "warn", `temp ingest exited (code ${code ?? "?"})`);
      if (code !== 0) {
        emitIngest({
          type: "ingest_error", temp: true, threadId: input.threadId,
          message: err.trim().split("\n").slice(-2).join(" ") || `exit ${code}`,
        });
      } else if (docs.size > 0) {
        sendToBackend({ type: "temp_index_add", threadId: input.threadId, prefix: path.join(tempIndexDir, "store") });
      }
      resolve();
    });
  });
  if (docs.size > 0) track("chat_pdf_added", { count: docs.size });
  return { ok: docs.size > 0, docs: [...docs].sort() };
}

function readRendererFile(rel: string): string {
  try { return fs.readFileSync(path.join(__dirname, "..", "renderer", rel), "utf-8"); }
  catch { return ""; }
}

// Render a message's HTML to a PDF via an offscreen window's printToPDF, inlining
// the app + KaTeX stylesheets so math/tables/figures look right in the export.
async function exportPdfAction(input: { html: string; title: string }): Promise<string> {
  if (!win) return "";
  const css = readRendererFile("styles.css") + "\n" + readRendererFile("vendor/katex/katex.min.css");
  // The document <title> becomes the PDF's title metadata (shown by viewers).
  const titleEsc = (input.title || "answer").replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] as string));
  const doc = `<!doctype html><html><head><meta charset="utf-8"><title>${titleEsc}</title><style>${css}\n` +
    `body{background:#fff;color:#1a1a18;max-width:760px;margin:0 auto;padding:36px;}` +
    `</style></head><body><div class="answer">${input.html}</div></body></html>`;
  const pdfWin = new BrowserWindow({ show: false, webPreferences: { sandbox: true } });
  try {
    await pdfWin.loadURL("data:text/html;charset=utf-8," + encodeURIComponent(doc));
    const data = await pdfWin.webContents.printToPDF({ printBackground: true, pageSize: "A4" });
    const res = await dialog.showSaveDialog(win, {
      title: "Save answer as PDF",
      defaultPath: `${(input.title || "answer").replace(/[\/:*?"<>|]+/g, "_").slice(0, 60)}.pdf`,
      filters: [{ name: "PDF", extensions: ["pdf"] }],
    });
    if (res.canceled || !res.filePath) { log("info", "export-pdf canceled"); return ""; }
    fs.writeFileSync(res.filePath, data);
    log("info", `export-pdf -> ${res.filePath}`);
    track("pdf_exported");
    void shell.openPath(res.filePath);
    return res.filePath;
  } catch (e) {
    log("error", "export-pdf failed", (e as Error).message);
    return "";
  } finally {
    pdfWin.destroy();
  }
}

// Renderer-originated engagement events. Allowlisted so the renderer can only
// emit these known, content-free names (defence-in-depth against ever shipping
// document text through the analytics channel).
const RENDERER_EVENTS = new Set([
  "thread_created", "thread_deleted", "answer_regenerated", "thread_branched", "thread_search_used",
]);
function trackFromRenderer(event: string, props?: Record<string, string | number | boolean>): void {
  if (!RENDERER_EVENTS.has(event)) { log("warn", `analytics: ignoring unknown renderer event "${event}"`); return; }
  track(event, props);
}

function installUpdateAction(): boolean {
  track("update_install_clicked");
  return installDownloadedUpdate();
}

// --- tRPC router ------------------------------------------------------------
const routerDeps: RouterDeps = {
  bus,
  drainServeBuffer: () => serveBuffer.splice(0, serveBuffer.length),
  markServeSubscribed: () => { serveSubscribed = true; },
  sendToBackend,
  getSettings: getSettingsAction,
  setSettings: setSettingsAction,
  openFigure: openFigureAction,
  openDoc: openDocAction,
  removeDoc: removeDocAction,
  addPdfs: addPdfsAction,
  addTempPdfs: addTempPdfsAction,
  exportPdf: exportPdfAction,
  showDocMenu: showDocMenuAction,
  showThreadMenu: showThreadMenuAction,
  showModelMenu: showModelMenuAction,
  setCollection: setCollectionAction,
  getUpdateState,
  installUpdate: installUpdateAction,
  track: trackFromRenderer,
};
const appRouter = createAppRouter(routerDeps);

// Initialise crash reporting as early as possible so startup failures are
// caught. Like analytics, the opt-out flag is applied once settings are
// readable (inside the ready handler), before any event could be sent.
initErrorReporting({ log });

// Aptabase requires initialize() to run before the app `ready` event; it waits
// for whenReady internally. The opt-out flag is applied once settings are
// readable (inside the ready handler, before any event is tracked).
initAnalytics({ log });

app.whenReady().then(() => {
  openLog();
  copyLegacyDataIfNeeded();
  cleanupTempThreadIndexes();
  const startupSettings = readSettings();
  setAnalyticsEnabled(startupSettings.analyticsEnabled);
  setErrorReportingEnabled(startupSettings.analyticsEnabled);
  track("app_started", { platform: process.platform, arch: process.arch });
  startBackend();
  installApplicationMenu();
  createWindow();
  initAutoUpdater(() => win, log, (s: UpdateState) => {
    if (s.status === "downloaded") track("update_downloaded", s.version ? { version: s.version } : {});
    bus.emit("update-event", s);
  });
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  log("info", "all windows closed; shutting down backend");
  if (serve) serve.kill();
  if (process.platform !== "darwin") app.quit();
});
