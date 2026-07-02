/**
 * Renderer entry point. Wires the preload `window.api` event streams into the
 * store, then mounts the React app.
 */
// Initialise crash reporting first so it can catch errors during the rest of
// module evaluation and React mount. Config (DSN, release, environment, the
// opt-out gate) is inherited from the main process over IPC, so the empty
// options object is intentional — and events travel via the preload bridge,
// never a direct network call from this CSP-restricted page.
import * as Sentry from "@sentry/electron/renderer";
Sentry.init({
  // Drop console breadcrumbs: this page mirrors backend log lines via
  // console.log("[backend]", …), which can contain PDF file names. Everything
  // else (DSN, release, environment, the opt-out gate in the main process'
  // beforeSend) is inherited over IPC.
  beforeBreadcrumb: (b) => (b.category === "console" ? null : b),
});

import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { handleServeEvent, handleIngestEvent, handleUpdateEvent } from "./store";
import { api } from "./trpc";

// mermaid (~3 MB) is loaded lazily the first time a diagram needs rendering
// (see markdown.ts) so it doesn't delay startup / first paint.

// subscribe to backend streams
api.onServeEvent(handleServeEvent);
api.onIngestEvent(handleIngestEvent);
api.onServeLog((line) => console.log("[backend]", line));
api.onUpdateEvent(handleUpdateEvent);

// Dev/QA helper: preview the auto-update sidebar states without a real update.
// Open DevTools (View → Toggle Developer Tools) and run, e.g.:
//   __fakeUpdate("downloading", "9.9.9", 42)   // spinner row
//   __fakeUpdate("downloaded", "9.9.9")        // green "Restart to update" button
//   __fakeUpdate(null)                          // clear the banner
// Real update events from the main process overwrite whatever this sets. The
// install action is a no-op in an unpackaged dev build, so clicking is safe.
(window as any).__fakeUpdate = (
  status: "available" | "downloading" | "downloaded" | "error" | null,
  version = "9.9.9",
  percent = 50,
) => handleUpdateEvent(status === null ? null : { status, version, percent });

// Backstop for the startup race: explicitly request status + persisted threads
// in case the initial "ready" fired before this listener was registered.
api.sendRequest({ type: "info" });
api.sendRequest({ type: "threads_dump" });

createRoot(document.getElementById("root")!).render(<App />);
