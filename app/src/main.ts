/**
 * Electron main process.
 *
 * Spawns the Python backend (`python -m pdf_qa.serve`) and bridges its
 * line-delimited JSON protocol to the renderer over IPC. Also opens page-image
 * files in the OS default viewer when the user clicks a figure.
 */
import { app, BrowserWindow, ipcMain, shell, dialog } from "electron";
import { spawn, ChildProcessWithoutNullStreams } from "child_process";
import * as readline from "readline";
import * as path from "path";

let win: BrowserWindow | null = null;
let serve: ChildProcessWithoutNullStreams | null = null;

// project root = parent of the app/ directory (dist/ -> app/ -> project/)
const PROJECT_ROOT = path.resolve(__dirname, "..", "..");
const PYTHON = process.env.PDF_QA_PYTHON || "python3";

// The backend emits its "ready" event within milliseconds of spawning — often
// before the renderer has loaded and subscribed. Buffer everything until the
// page reports it has finished loading, then flush, so no event is lost.
let rendererReady = false;
const pending: { channel: string; payload: unknown }[] = [];

function sendToRenderer(channel: string, payload: unknown): void {
  if (rendererReady && win && !win.isDestroyed()) {
    win.webContents.send(channel, payload);
  } else {
    pending.push({ channel, payload });
  }
}

function flushPending(): void {
  if (!win || win.isDestroyed()) return;
  rendererReady = true;
  for (const m of pending) win.webContents.send(m.channel, m.payload);
  pending.length = 0;
}

function startBackend(): void {
  serve = spawn(PYTHON, ["-u", "-m", "pdf_qa.serve"], {
    cwd: PROJECT_ROOT,
    env: { ...process.env },
  });

  let sawBackendError = false;
  let stderrTail = "";

  const rl = readline.createInterface({ input: serve.stdout });
  rl.on("line", (line: string) => {
    line = line.trim();
    if (!line) return;
    try {
      const obj = JSON.parse(line);
      if (obj && obj.type === "error") sawBackendError = true;
      sendToRenderer("serve-event", obj);
    } catch {
      // non-JSON stdout (e.g. stray print) — surface as a log
      sendToRenderer("serve-log", line);
    }
  });

  let errBuf = "";
  serve.stderr.on("data", (d: Buffer) => {
    errBuf += d.toString();
    stderrTail = (stderrTail + d.toString()).slice(-2000);
    const parts = errBuf.split("\n");
    errBuf = parts.pop() || "";
    for (const p of parts) if (p.trim()) sendToRenderer("serve-log", p);
  });

  serve.on("error", (e: Error) => {
    sendToRenderer("serve-event", {
      type: "error",
      message: `Could not start Python "${PYTHON}": ${e.message}. ` +
        `Point the app at the interpreter that has the project's deps: ` +
        `PDF_QA_PYTHON=/path/to/python npm start`,
    });
  });

  serve.on("exit", (code: number | null) => {
    if (code === 0 || sawBackendError) return; // clean exit, or a specific error was already shown
    // Surface the real reason from Python's stderr (e.g. ModuleNotFoundError, traceback).
    const reason = stderrTail.trim().split("\n").filter(Boolean).slice(-3).join(" · ");
    sendToRenderer("serve-event", {
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
    backgroundColor: "#11131a",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });
  win.loadFile(path.join(__dirname, "..", "renderer", "index.html"));
  // Once the page is up and listeners are registered, release buffered events.
  win.webContents.on("did-finish-load", flushPending);
}

// --- IPC: renderer -> main --------------------------------------------------
ipcMain.on("serve-request", (_e, req: unknown) => {
  if (serve && serve.stdin.writable) {
    serve.stdin.write(JSON.stringify(req) + "\n");
  }
});

ipcMain.handle("open-figure", async (_e, filePath: string) => {
  // Opens the page image in the OS default viewer. Returns "" on success.
  return shell.openPath(filePath);
});

// Pick PDFs and ingest them incrementally, streaming progress to the renderer.
ipcMain.handle("add-pdfs", async () => {
  if (!win) return { canceled: true };
  const picked = await dialog.showOpenDialog(win, {
    title: "Add PDFs to the index",
    properties: ["openFile", "multiSelections"],
    filters: [{ name: "PDF", extensions: ["pdf"] }],
  });
  if (picked.canceled || picked.filePaths.length === 0) return { canceled: true };

  await new Promise<void>((resolve) => {
    const proc = spawn(PYTHON, ["-u", "-m", "pdf_qa.ingest", "--add", ...picked.filePaths, "--json"],
      { cwd: PROJECT_ROOT, env: { ...process.env } });
    const rl = readline.createInterface({ input: proc.stdout });
    rl.on("line", (line) => {
      line = line.trim();
      if (!line) return;
      try { sendToRenderer("ingest-event", JSON.parse(line)); }
      catch { sendToRenderer("serve-log", line); }
    });
    let err = "";
    proc.stderr.on("data", (d: Buffer) => { err = (err + d.toString()).slice(-1500); });
    proc.on("error", (e) =>
      sendToRenderer("ingest-event", { type: "ingest_error", message: e.message }));
    proc.on("close", (code) => {
      if (code !== 0)
        sendToRenderer("ingest-event",
          { type: "ingest_error", message: err.trim().split("\n").slice(-2).join(" ") || `exit ${code}` });
      // tell the live backend to reload the freshly-written index
      if (serve && serve.stdin.writable) serve.stdin.write(JSON.stringify({ type: "reload" }) + "\n");
      resolve();
    });
  });
  return { canceled: false, count: picked.filePaths.length };
});

app.whenReady().then(() => {
  startBackend();
  createWindow();
  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  if (serve) serve.kill();
  if (process.platform !== "darwin") app.quit();
});
