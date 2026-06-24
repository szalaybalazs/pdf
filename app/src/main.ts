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
import { createIPCHandler } from "electron-trpc/main";
import { readSettings, writeSettings, Settings } from "./settings";
import { createAppRouter, RouterDeps } from "./trpc";

let win: BrowserWindow | null = null;
let serve: ChildProcessWithoutNullStreams | null = null;
let restarting = false;  // set while we intentionally kill+respawn the backend

// project root = parent of the app/ directory (dist/ -> app/ -> project/)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = process.env.PDF_QA_PYTHON || "python3";

// --- debug logging ----------------------------------------------------------
// Everything the main process does is timestamped to the console *and* appended
// to <userData>/main.log, so issues can be diagnosed after the fact. Set
// PDF_QA_DEBUG=0 to silence the verbose per-event lines (errors always log).
const DEBUG = process.env.PDF_QA_DEBUG !== "0";
let logStream: fs.WriteStream | null = null;

function logFilePath(): string | null {
  try { return path.join(app.getPath("userData"), "main.log"); }
  catch { return null; }   // app not ready yet
}

function openLog(): void {
  const p = logFilePath();
  if (!p || logStream) return;
  try {
    logStream = fs.createWriteStream(p, { flags: "a" });
    log("info", `=== session start · ${new Date().toISOString()} · python=${PYTHON} ===`);
    log("info", `log file: ${p}`);
  } catch { /* console-only if the file can't be opened */ }
}

function log(level: "info" | "warn" | "error", msg: string, extra?: unknown): void {
  if (level === "info" && !DEBUG) return;
  const ts = new Date().toISOString();
  let line = `[${ts}] [main] [${level}] ${msg}`;
  if (extra !== undefined) {
    try { line += " " + (typeof extra === "string" ? extra : JSON.stringify(extra)); }
    catch { line += " [unserialisable]"; }
  }
  const sink = level === "error" ? console.error : console.log;
  sink(line);
  try { logStream?.write(line + "\n"); } catch { /* ignore */ }
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
  return env;
}

function startBackend(): void {
  log("info", `spawning backend: ${PYTHON} -u -m pdf_qa.serve (cwd=${PROJECT_ROOT})`);
  serve = spawn(PYTHON, ["-u", "-m", "pdf_qa.serve"], {
    cwd: PROJECT_ROOT,
    env: backendEnv(),
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
    for (const p of parts) if (p.trim()) { log("warn", "backend stderr", preview(p, 500)); emitLog(p); }
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
  win = new BrowserWindow({
    width: 1180,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    title: "pdf_qa",
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
      label: app.name,
      submenu: [
        { label: "Settings…", accelerator: "CommandOrControl+,", click: () => dispatchRendererEvent("pdf-qa-open-settings") },
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
          { label: "Settings…", accelerator: "CommandOrControl+,", click: () => dispatchRendererEvent("pdf-qa-open-settings") } as MenuItemConstructorOptions,
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

async function getSettingsAction() {
  return { ...readSettings(), dataDir: dataDir() };
}

async function setSettingsAction(s: Settings): Promise<{ ok: boolean }> {
  log("info", "set-settings (keys updated); restarting backend");
  writeSettings({
    openaiKey: s.openaiKey || "",
    anthropicKey: s.anthropicKey || "",
    openrouterKey: s.openrouterKey || "",
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
    const proc = spawn(PYTHON, ["-u", "-m", "pdf_qa.ingest", "--add", ...picked.filePaths, "--json"],
      { cwd: PROJECT_ROOT, env: backendEnv() });
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
  exportPdf: exportPdfAction,
  showDocMenu: showDocMenuAction,
};
const appRouter = createAppRouter(routerDeps);

app.whenReady().then(() => {
  openLog();
  startBackend();
  installApplicationMenu();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  log("info", "all windows closed; shutting down backend");
  if (serve) serve.kill();
  if (process.platform !== "darwin") app.quit();
});
