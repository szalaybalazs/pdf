/**
 * Electron main process.
 *
 * Spawns the Python backend (`python -m pdf_qa.serve`) and bridges its
 * line-delimited JSON protocol to the renderer via tRPC (electron-trpc IPC
 * transport): one-shot calls are mutations/queries, the backend's event feeds
 * are tRPC subscriptions. Also opens documents / page images in the OS viewer.
 */
import { app, BrowserWindow, shell, dialog, Menu, MenuItemConstructorOptions } from "electron";
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
  if (extra !== undefined) {
    let tail: string;
    try { tail = typeof extra === "string" ? extra : JSON.stringify(extra); }
    catch { tail = "[unserialisable]"; }
    logger[level](`${msg} ${tail}`);
  } else {
    logger[level](msg);
  }
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
  const INDEX_DIR = path.join(DATA_DIR, "index");
  fs.mkdirSync(INDEX_DIR, { recursive: true });
  const settings = readSettings();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    PDF_QA_DATA_DIR: DATA_DIR,
    INDEX_DIR,
  };
  // Keys set in the settings page take precedence over any inherited / .env value.
  if (settings.openaiKey) env.OPENAI_API_KEY = settings.openaiKey;
  if (settings.anthropicKey) env.ANTHROPIC_API_KEY = settings.anthropicKey;
  if (settings.openrouterKey) env.OPENROUTER_API_KEY = settings.openrouterKey;
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

// --- backend actions (exposed to the renderer through the tRPC router) -------
function sendToBackend(req: unknown): void {
  const type = (req as { type?: string })?.type ?? "?";
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

function modelMenuLabel(model: { label: string; model?: string; provider?: string }): string {
  const provider = modelProviderLabel(model.provider || "");
  const prefix = `${provider} · `;
  if (model.label.startsWith(prefix)) return model.label.slice(prefix.length).replace(/ · OpenRouter$/, "");
  return model.model || model.label;
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
      type: "radio",
      checked: model.id === input.selectedModel,
      click: () => {
        picked = model.id;
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
  });
  restartBackend(); // respawn so the Python backend picks up the new keys
  return { ok: true };
}

// Pick PDFs and ingest them incrementally, streaming progress to the renderer.
async function addPdfsAction(): Promise<{ canceled: boolean; count?: number }> {
  if (!win) return { canceled: true };
  const picked = await dialog.showOpenDialog(win, {
    title: "Add PDFs to the index",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) { log("info", "add-pdfs canceled"); return { canceled: true }; }

  log("info", `add-pdfs: ${picked.filePaths.length} file(s)`, preview(picked.filePaths, 400));
  rememberDocPaths(picked.filePaths);   // so we can "open" them later

  await new Promise<void>((resolve) => {
    const { cmd, args, cwd } = backendCommand("ingest", ["--add", ...picked.filePaths, "--json"]);
    const proc = spawn(cmd, args, { cwd, env: backendEnv(), windowsHide: true });
    log("info", `ingest pid=${proc.pid ?? "?"}`);
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      try { const ev = JSON.parse(line); log("info", `ingest event: ${ev?.type ?? "?"}`, preview(ev)); emitIngest(ev); }
      catch { emitLog(line); }
    });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); log("warn", "ingest stderr", preview(d.toString(), 500)); });
    proc.on("error", (e) => {
      log("error", "ingest spawn error", e.message);
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
        emitIngest({ ...ev, temp: true, threadId: input.threadId });
      } catch {
        emitLog(line);
      }
    });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); log("warn", "temp ingest stderr", preview(d.toString(), 500)); });
    proc.on("error", (e) => {
      log("error", "temp ingest spawn error", e.message);
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
  const doc = `<!doctype html><html><head><meta charset="utf-8"><style>${css}\n` +
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
    void shell.openPath(res.filePath);
    return res.filePath;
  } catch (e) {
    log("error", "export-pdf failed", (e as Error).message);
    return "";
  } finally {
    pdfWin.destroy();
  }
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
  showModelMenu: showModelMenuAction,
  getUpdateState,
  installUpdate: installDownloadedUpdate,
};
const appRouter = createAppRouter(routerDeps);

app.whenReady().then(() => {
  openLog();
  copyLegacyDataIfNeeded();
  cleanupTempThreadIndexes();
  startBackend();
  installApplicationMenu();
  createWindow();
  initAutoUpdater(() => win, log, (s: UpdateState) => bus.emit("update-event", s));
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  log("info", "all windows closed; shutting down backend");
  if (serve) serve.kill();
  if (process.platform !== "darwin") app.quit();
});
