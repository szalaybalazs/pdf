/**
 * Preload: exposes a minimal, safe API to the renderer via contextBridge.
 * No Node globals leak into the page.
 */
import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("api", {
  /** Subscribe to backend events (ready / tool / answer / error). */
  onServeEvent: (cb: (event: any) => void) =>
    ipcRenderer.on("serve-event", (_e, ev) => cb(ev)),

  /** Subscribe to raw backend log lines (stderr / stray stdout). */
  onServeLog: (cb: (line: string) => void) =>
    ipcRenderer.on("serve-log", (_e, line) => cb(line)),

  /** Send a request to the backend (e.g. a query). */
  sendRequest: (req: unknown) => ipcRenderer.send("serve-request", req),

  /** Open a page-image file in the OS default viewer. */
  openFigure: (filePath: string): Promise<string> =>
    ipcRenderer.invoke("open-figure", filePath),

  /** Open a file picker and ingest the chosen PDFs (incremental). */
  addPdfs: (): Promise<{ canceled: boolean; count?: number }> =>
    ipcRenderer.invoke("add-pdfs"),

  /** Subscribe to ingestion progress events. */
  onIngestEvent: (cb: (event: any) => void) =>
    ipcRenderer.on("ingest-event", (_e, ev) => cb(ev)),

  /** Read persisted settings (API keys + data dir). */
  getSettings: (): Promise<{ openaiKey: string; anthropicKey: string; openrouterKey: string; dataDir: string }> =>
    ipcRenderer.invoke("get-settings"),

  /** Persist API keys; the backend is restarted to pick them up. */
  setSettings: (s: { openaiKey: string; anthropicKey: string; openrouterKey: string }): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("set-settings", s),
});
