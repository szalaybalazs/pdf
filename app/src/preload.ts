/**
 * Preload: exposes the electron-trpc bridge to the renderer. The renderer talks
 * to the main process exclusively through the typed tRPC client (see
 * renderer/src/trpc.ts); no other Node globals leak into the page.
 */
// Sets up the IPC bridge the renderer's Sentry SDK uses to forward events to
// the main process (which owns the actual network transport). With
// contextIsolation on, this import in the preload is required for renderer-side
// reporting to work — and it keeps all egress in the main process, so the
// renderer's strict CSP needs no `connect-src` exception.
import "@sentry/electron/preload";
import { contextBridge, webUtils } from "electron";
import { exposeElectronTRPC } from "electron-trpc/main";

process.once("loaded", () => {
  exposeElectronTRPC();
  contextBridge.exposeInMainWorld("pdfQaFiles", {
    pathForFile: (file: File) => webUtils.getPathForFile(file),
  });
  contextBridge.exposeInMainWorld("pdfQaApp", {
    platform: process.platform,
  });
});
