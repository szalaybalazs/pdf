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
import { isKnownOcrLanguage } from "./languages";
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
// Default remote index-server URL, used when a remote library is added without an
// explicit URL (the server runs on :8000 by default; see index_server/).
const DEFAULT_REMOTE_INDEX_URL = "http://localhost:8000";

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

// The index directory for whichever collection is currently active. Everything
// that touches the on-disk index (opening a page, clearing the index) must use
// this rather than a hardcoded dataDir()/index, or it silently targets the
// default collection after a switch.
function activeIndexDir(): string {
  return collectionIndexDir(getActiveCollection());
}

// --- remote libraries -------------------------------------------------------
// A remote library keeps its index on a shared server (index_server/) so several
// apps can query and grow the same index. We store the connection details in a
// registry file; a library is "remote" when its name is in this registry. The
// backend is pointed at it via PDF_QA_REMOTE_* env on spawn (see backendEnv).
interface RemoteLibrary { name: string; url: string; secret: string; remoteName: string; }

function remoteLibrariesPath(): string {
  return path.join(dataDir(), "remote-libraries.json");
}

function readRemoteLibraries(): RemoteLibrary[] {
  try {
    const raw = JSON.parse(fs.readFileSync(remoteLibrariesPath(), "utf-8"));
    if (!Array.isArray(raw)) return [];
    return raw
      .filter((r) => r && typeof r.name === "string" && typeof r.url === "string")
      .map((r) => ({
        name: String(r.name), url: String(r.url).replace(/\/+$/, ""),
        secret: typeof r.secret === "string" ? r.secret : "",
        remoteName: typeof r.remoteName === "string" && r.remoteName ? r.remoteName : String(r.name),
      }));
  } catch { return []; }
}

function writeRemoteLibraries(libs: RemoteLibrary[]): void {
  try {
    fs.writeFileSync(remoteLibrariesPath(), JSON.stringify(libs, null, 2));
  } catch (e) {
    log("warn", "could not persist remote libraries", (e as Error).message);
  }
}

function findRemoteLibrary(name: string): RemoteLibrary | undefined {
  return readRemoteLibraries().find((r) => r.name === name);
}

// The remote config for whichever library is active, or null when the active
// library is a local (on-disk) collection.
function getActiveRemote(): RemoteLibrary | null {
  return findRemoteLibrary(getActiveCollection()) ?? null;
}

// Per-library settings live in a small meta.json inside the collection's index
// dir (which always exists — created on collection create, and dataDir()/index
// for the default library). Currently just the OCR language.
function collectionMetaPath(name: string): string {
  return path.join(collectionIndexDir(name), "meta.json");
}

// The library's chosen OCR language (a Tesseract code, e.g. "deu"), or "" when
// none is set. "" means "inherit the OCR_LANG env / backend default (eng)", so
// the historical behaviour is preserved for libraries that never picked one.
function getCollectionLanguage(name: string): string {
  try {
    const meta = JSON.parse(fs.readFileSync(collectionMetaPath(name), "utf-8"));
    const lang = typeof meta.language === "string" ? meta.language.trim() : "";
    return isKnownOcrLanguage(lang) ? lang : "";
  } catch {
    return "";
  }
}

// Persist a library's OCR language (merging into any existing meta.json). An
// empty/unknown code clears it back to the default. Best-effort; logs on failure.
function setCollectionLanguageFile(name: string, code: string): void {
  const lang = isKnownOcrLanguage(code) ? code : "";
  const p = collectionMetaPath(name);
  let meta: Record<string, unknown> = {};
  try { meta = JSON.parse(fs.readFileSync(p, "utf-8")); } catch { /* new/absent meta */ }
  if (lang) meta.language = lang; else delete meta.language;
  try {
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(meta, null, 2));
  } catch (e) {
    log("warn", `could not persist language for ${name}`, (e as Error).message);
  }
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
  const firstPage = path.join(activeIndexDir(), "pages", safe, "p0001.png");
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
  const remote = getActiveRemote();
  // A remote library has no local collection dir — pointing INDEX_DIR at one
  // would create a phantom `collections/<name>` that then shows up as a bogus
  // LOCAL library. Use a remote-scoped cache dir instead (page images fetched
  // from the server are cached under here).
  const INDEX_DIR = remote
    ? path.join(DATA_DIR, "remote-cache", remote.remoteName, "index")
    : collectionIndexDir(collection);
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const settings = readSettings();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PDF_QA_DATA_DIR: DATA_DIR,
    INDEX_DIR,
    PDF_QA_COLLECTION: collection,
  };
  // The active library's OCR language drives Tesseract for scanned/figure pages
  // (read at ingest time — both serve and ingest spawn through here). Only set it
  // when the library picked one, so an explicit OCR_LANG env override still wins
  // for libraries that never chose a language.
  const ocrLang = getCollectionLanguage(collection);
  if (ocrLang) env.OCR_LANG = ocrLang;
  // When the active library is remote, point the backend at the shared server.
  // serve/ingest then route through the RemoteVectorStore instead of local disk.
  if (remote) {
    env.PDF_QA_REMOTE_URL = remote.url;
    env.PDF_QA_REMOTE_SECRET = remote.secret;
    env.PDF_QA_REMOTE_LIBRARY = remote.remoteName;
  }
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

function libraryMenuItems(): MenuItemConstructorOptions[] {
  return listCollectionsAction().map((c) => ({
    label: c.remote
      ? `${c.name} (remote)`
      : `${c.name === "default" ? "Default library" : c.name} (${c.docs})`,
    type: "radio" as const,
    checked: c.active,
    click: () => { setCollectionAction(c.name); },
  }));
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
        { type: "separator" },
        { label: "Library", submenu: libraryMenuItems() },
        { label: "New Library…", click: () => dispatchRendererEvent("pdf-qa-new-library") },
        { label: "Library Settings…", click: () => dispatchRendererEvent("pdf-qa-library-settings") },
        { label: "Delete Current Library…", click: () => dispatchRendererEvent("pdf-qa-delete-library") },
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

// Read a rendered page image as a data URL for the in-app viewer. Guarded to the
// user's data directory so the renderer can't read arbitrary files.
function readImageAction(filePath: string): string {
  try {
    const resolved = path.resolve(filePath);
    if (!resolved.startsWith(path.resolve(dataDir()))) {
      log("warn", `read-image blocked (outside dataDir): ${resolved}`);
      return "";
    }
    const buf = fs.readFileSync(resolved);
    return `data:image/png;base64,${buf.toString("base64")}`;
  } catch (e) {
    log("warn", "read-image failed", (e as Error).message);
    return "";
  }
}

// Collections are a main-process concern: they're directories on disk plus which
// one the backend was spawned to serve. Owning list/create/delete here (rather
// than round-tripping the Python backend) keeps create/delete atomic with the
// active-collection switch and its respawn — no cross-process timing races.
function collectionsRootDir(): string {
  return path.join(dataDir(), "collections");
}

function sanitizeCollectionName(name: string): string {
  return (name || "").replace(/[^A-Za-z0-9 _-]/g, "").trim().slice(0, 64);
}

function docCountForIndex(indexDir: string): number {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(indexDir, "manifest.json"), "utf-8"));
    return Object.keys(m).filter((k) => !k.startsWith("_")).length;
  } catch { /* no manifest — fall through */ }
  try {
    const docs = new Set<string>();
    for (const line of fs.readFileSync(path.join(indexDir, "store.jsonl"), "utf-8").split("\n")) {
      if (!line.trim()) continue;
      try { docs.add(JSON.parse(line).doc); } catch { /* skip bad line */ }
    }
    docs.delete(undefined as unknown as string);
    return docs.size;
  } catch { return 0; }
}

function listCollectionsAction(): { name: string; docs: number; active: boolean; language: string; remote: boolean; url?: string }[] {
  const active = getActiveCollection();
  // Remote library names are reserved: never list them as local, even if a stale
  // `collections/<name>` dir exists from an older build.
  const remoteNames = new Set(readRemoteLibraries().map((r) => r.name));
  const names = ["default"];
  try {
    for (const d of fs.readdirSync(collectionsRootDir(), { withFileTypes: true })) {
      if (d.isDirectory() && d.name !== "default" && !remoteNames.has(d.name)) names.push(d.name);
    }
  } catch { /* no collections dir yet */ }
  const local = names.map((n) => ({
    name: n,
    docs: docCountForIndex(collectionIndexDir(n)),
    active: n === active,
    language: getCollectionLanguage(n),
    remote: false,
  }));
  // Remote libraries live in the registry, not on disk. Their doc count isn't
  // known without a network call, so report -1 (the UI shows the live count from
  // the backend "ready" event once one is active).
  const remote = readRemoteLibraries().map((r) => ({
    name: r.name, docs: -1, active: r.name === active, language: "",
    remote: true, url: r.url,
  }));
  return [...local, ...remote];
}

function createCollectionAction(name: string, language = ""): { ok: boolean; name?: string; error?: string } {
  const clean = sanitizeCollectionName(name);
  if (!clean || clean.toLowerCase() === "default") return { ok: false, error: "Invalid library name." };
  const dir = path.join(collectionsRootDir(), clean);
  if (fs.existsSync(dir)) return { ok: false, error: "A library with that name already exists." };
  try {
    fs.mkdirSync(path.join(dir, "index"), { recursive: true });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (language) setCollectionLanguageFile(clean, language);
  log("info", `created collection ${clean}${language ? ` (lang ${language})` : ""}`);
  track("collection_created");
  setActiveCollectionFile(clean);   // drop straight into the new (empty) library
  installApplicationMenu();
  restartBackend();
  return { ok: true, name: clean };
}

// Set a library's OCR language. The next ingest into that library picks it up
// (both serve and ingest read OCR_LANG from backendEnv at spawn time). If it's
// the active library we respawn the backend so a subsequent add-PDFs run uses
// the new language without needing a manual restart. Already-indexed documents
// keep their old OCR text until re-added.
function setCollectionLanguageAction(input: { name: string; language: string }): { ok: boolean; error?: string } {
  const name = (input?.name || "").trim() || "default";
  const language = (input?.language || "").trim();
  if (language && !isKnownOcrLanguage(language)) return { ok: false, error: "Unknown language." };
  const known = name === "default" || fs.existsSync(path.join(collectionsRootDir(), sanitizeCollectionName(name)));
  if (!known) return { ok: false, error: "No such library." };
  setCollectionLanguageFile(name === "default" ? "default" : sanitizeCollectionName(name), language);
  log("info", `set language for ${name} -> ${language || "(default)"}`);
  track("collection_language_set");
  if (name === getActiveCollection()) restartBackend();
  return { ok: true };
}

function deleteCollectionAction(name: string): { ok: boolean; error?: string } {
  const clean = sanitizeCollectionName(name);
  if (clean.toLowerCase() === "default") return { ok: false, error: "The Default library can't be deleted." };
  const dir = path.join(collectionsRootDir(), clean);
  if (!fs.existsSync(dir)) return { ok: false, error: "No such library." };
  const wasActive = clean === getActiveCollection();
  if (wasActive) setActiveCollectionFile("default");   // can't serve a deleted library
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  log("info", `deleted collection ${clean}${wasActive ? " (was active -> default)" : ""}`);
  track("collection_deleted");
  installApplicationMenu();
  if (wasActive) restartBackend();
  return { ok: true };
}

// Rename a named library: move its directory (index, meta, page images all
// travel with it since stored paths are relative). The Default library keeps the
// historical top-level layout and can't be renamed. If it's the active library
// we re-point the active file and respawn so the backend serves the new path.
function renameCollectionAction(input: { name: string; newName: string }): { ok: boolean; name?: string; error?: string } {
  const old = sanitizeCollectionName(input?.name || "");
  if (old.toLowerCase() === "default" || (input?.name || "").trim().toLowerCase() === "default") {
    return { ok: false, error: "The Default library can't be renamed." };
  }
  const clean = sanitizeCollectionName(input?.newName || "");
  if (!clean || clean.toLowerCase() === "default") return { ok: false, error: "Invalid library name." };
  if (clean === old) return { ok: true, name: old };
  const src = path.join(collectionsRootDir(), old);
  if (!fs.existsSync(src)) return { ok: false, error: "No such library." };
  const dst = path.join(collectionsRootDir(), clean);
  if (fs.existsSync(dst)) return { ok: false, error: "A library with that name already exists." };
  const wasActive = old === getActiveCollection();
  try {
    fs.renameSync(src, dst);
  } catch (e) {
    return { ok: false, error: (e as Error).message };
  }
  if (wasActive) setActiveCollectionFile(clean);
  log("info", `renamed collection ${old} -> ${clean}`);
  track("collection_renamed");
  installApplicationMenu();
  if (wasActive) restartBackend();
  return { ok: true, name: clean };
}

// Probe a remote index server's /health. Returns {ok} or {ok:false,error} — used
// by the "Add remote library" dialog's connection test and before persisting one.
async function testRemoteAction(input: { url: string; secret: string }): Promise<{ ok: boolean; error?: string; libraries?: number; documents?: number }> {
  const url = ((input?.url || "").trim().replace(/\/+$/, "")) || DEFAULT_REMOTE_INDEX_URL;
  if (!/^https?:\/\//i.test(url)) return { ok: false, error: "Enter a URL starting with http:// or https://" };
  try {
    const headers: Record<string, string> = {};
    if (input.secret) headers["Authorization"] = `Bearer ${input.secret}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    // Probe the authenticated inventory endpoint: it confirms reachability, checks
    // the secret, and gives us the library + document counts in one call.
    const res = await fetch(`${url}/v1/libraries`, { headers, signal: controller.signal });
    clearTimeout(timer);
    if (res.status === 401) return { ok: false, error: "Unauthorized — check the secret." };
    if (!res.ok) return { ok: false, error: `Server responded ${res.status}` };
    const body = await res.json().catch(() => ({ libraries: [] }));
    const libs: { docs?: number }[] = Array.isArray(body.libraries) ? body.libraries : [];
    const documents = libs.reduce((n, l) => n + (typeof l.docs === "number" && l.docs > 0 ? l.docs : 0), 0);
    return { ok: true, libraries: libs.length, documents };
  } catch (e) {
    return { ok: false, error: `Could not reach the server: ${(e as Error).message}` };
  }
}

// Add a remote library: validate + test the connection, persist it to the
// registry, then switch to it (respawns the backend pointed at the server).
async function addRemoteLibraryAction(input: { name: string; url: string; secret: string; remoteName?: string }): Promise<{ ok: boolean; name?: string; error?: string }> {
  const name = sanitizeCollectionName(input?.name || "");
  const url = ((input?.url || "").trim().replace(/\/+$/, "")) || DEFAULT_REMOTE_INDEX_URL;
  const secret = input?.secret || "";
  const remoteName = sanitizeCollectionName(input?.remoteName || "") || name;
  if (!name || name.toLowerCase() === "default") return { ok: false, error: "Invalid library name." };
  if (fs.existsSync(path.join(collectionsRootDir(), name))) return { ok: false, error: "A local library with that name already exists." };
  if (findRemoteLibrary(name)) return { ok: false, error: "A remote library with that name already exists." };
  const probe = await testRemoteAction({ url, secret });
  if (!probe.ok) return { ok: false, error: probe.error || "Could not reach the server." };
  const libs = readRemoteLibraries();
  libs.push({ name, url, secret, remoteName });
  writeRemoteLibraries(libs);
  log("info", `added remote library ${name} -> ${url} (${remoteName})`);
  track("remote_library_added");
  setActiveCollectionFile(name);   // drop straight into it
  installApplicationMenu();
  restartBackend();
  return { ok: true, name };
}

// Rename a remote library's app-side label. The server library (remoteName) is
// left untouched — this only changes how the library is named in this app — so
// other apps connected to the same server are unaffected.
function renameRemoteLibraryAction(input: { name: string; newName: string }): { ok: boolean; name?: string; error?: string } {
  const libs = readRemoteLibraries();
  const idx = libs.findIndex((r) => r.name === input?.name);
  if (idx < 0) return { ok: false, error: "No such remote library." };
  const clean = sanitizeCollectionName(input?.newName || "");
  if (!clean || clean.toLowerCase() === "default") return { ok: false, error: "Invalid library name." };
  if (clean === input.name) return { ok: true, name: clean };
  if (fs.existsSync(path.join(collectionsRootDir(), clean))) return { ok: false, error: "A local library with that name already exists." };
  if (libs.some((r) => r.name === clean)) return { ok: false, error: "A remote library with that name already exists." };
  const wasActive = input.name === getActiveCollection();
  libs[idx] = { ...libs[idx], name: clean };
  writeRemoteLibraries(libs);
  if (wasActive) setActiveCollectionFile(clean);
  log("info", `renamed remote library ${input.name} -> ${clean}`);
  track("remote_library_renamed");
  installApplicationMenu();
  if (wasActive) restartBackend();
  return { ok: true, name: clean };
}

// Remove a remote library from the registry (does NOT delete anything on the
// server). If it was active, fall back to the Default library.
function removeRemoteLibraryAction(name: string): { ok: boolean; error?: string } {
  const libs = readRemoteLibraries();
  const next = libs.filter((r) => r.name !== name);
  if (next.length === libs.length) return { ok: false, error: "No such remote library." };
  const wasActive = name === getActiveCollection();
  if (wasActive) setActiveCollectionFile("default");
  writeRemoteLibraries(next);
  log("info", `removed remote library ${name}${wasActive ? " (was active -> default)" : ""}`);
  track("remote_library_removed");
  installApplicationMenu();
  if (wasActive) restartBackend();
  return { ok: true };
}

// Switch the active collection: persist the choice and respawn the backend so it
// loads that collection's index. Returns the collection now active.
function setCollectionAction(name: string): string {
  const target = (name || "default").trim() || "default";
  if (target === getActiveCollection()) return target;
  setActiveCollectionFile(target);
  log("info", `switching collection -> ${target}`);
  track("collection_switched");
  installApplicationMenu();
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

  const indexDir = activeIndexDir();
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

// Run one `pdf_qa.ingest` subprocess, streaming its JSON progress lines to the
// renderer as ingest events. Resolves with the exit code. Shared by the local
// "Add PDFs" path and both phases of the remote path.
function runIngestProc(extraArgs: string[], env: NodeJS.ProcessEnv): Promise<number> {
  return new Promise((resolve) => {
    const { cmd, args, cwd } = backendCommand("ingest", extraArgs);
    const proc = spawn(cmd, args, { cwd, env, windowsHide: true });
    log("info", `ingest pid=${proc.pid ?? "?"} (${extraArgs[0]})`);
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
      } catch { emitLog(line); }
    });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); log("warn", "ingest stderr", preview(d.toString(), 500)); });
    proc.on("error", (e) => {
      log("error", "ingest spawn error", e.message);
      track("ingest_failed", { kind: "spawn_failed" });
      emitIngest({ type: "ingest_error", message: e.message });
      resolve(1);
    });
    proc.on("close", (code) => {
      log(code === 0 ? "info" : "warn", `ingest exited (code ${code ?? "?"})`);
      if (code !== 0)
        emitIngest({ type: "ingest_error", message: err.trim().split("\n").slice(-2).join(" ") || `exit ${code}` });
      resolve(code ?? 0);
    });
  });
}

// Remote "Add PDFs": build the index LOCALLY into a throwaway temp dir (reusing
// all the normal render/OCR/embed machinery, with the remote env stripped so it
// writes to disk), then push the result up to the shared server. Two phases keep
// the heavy ingest path identical to the local one; only the upload is new.
async function ingestToRemote(filePaths: string[], remote: RemoteLibrary): Promise<void> {
  const tempIndexDir = path.join(dataDir(), "remote-ingest", String(Date.now()));
  fs.mkdirSync(tempIndexDir, { recursive: true });
  // Phase 1 — local build into temp. Strip the remote vars so ingest writes to
  // disk; point INDEX_DIR at the temp dir.
  const localEnv: NodeJS.ProcessEnv = { ...backendEnv(), INDEX_DIR: tempIndexDir };
  delete localEnv.PDF_QA_REMOTE_URL;
  delete localEnv.PDF_QA_REMOTE_SECRET;
  delete localEnv.PDF_QA_REMOTE_LIBRARY;
  const buildCode = await runIngestProc(["--add", ...filePaths, "--json"], localEnv);
  // Copy the original PDFs alongside the built index so the push uploads them to
  // the server — that's what lets the cited-passage highlight overlay work for
  // every app connected to this library (it re-renders from the source PDF).
  if (buildCode === 0) {
    const sourcesDir = path.join(tempIndexDir, "sources");
    fs.mkdirSync(sourcesDir, { recursive: true });
    for (const fp of filePaths) {
      try { fs.copyFileSync(fp, path.join(sourcesDir, path.basename(fp))); }
      catch (e) { log("warn", `could not stage source PDF ${fp}`, (e as Error).message); }
    }
    // Phase 2 — push temp -> server (remote env set via backendEnv()).
    await runIngestProc(["--push-remote", tempIndexDir, "--json"], backendEnv());
  }
  // The live backend refetches the server's chunk metadata.
  sendToBackend({ type: "reload" });
  try { fs.rmSync(tempIndexDir, { recursive: true, force: true }); }
  catch (e) { log("warn", "could not clean remote-ingest temp dir", (e as Error).message); }
}

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
    const remote = getActiveRemote();
    if (remote) {
      await ingestToRemote(picked.filePaths, remote);
    } else {
      await runIngestProc(["--add", ...picked.filePaths, "--json"], backendEnv());
      sendToBackend({ type: "reload" });   // reload the freshly-written local index
    }
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
  listCollections: listCollectionsAction,
  createCollection: createCollectionAction,
  deleteCollection: deleteCollectionAction,
  renameCollection: renameCollectionAction,
  setCollectionLanguage: setCollectionLanguageAction,
  addRemoteLibrary: addRemoteLibraryAction,
  removeRemoteLibrary: removeRemoteLibraryAction,
  renameRemoteLibrary: renameRemoteLibraryAction,
  testRemote: testRemoteAction,
  readImage: readImageAction,
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
