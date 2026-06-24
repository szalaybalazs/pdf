/**
 * Renderer entry point. Wires the preload `window.api` event streams into the
 * store, then mounts the React app.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { handleServeEvent, handleIngestEvent, handleUpdateEvent } from "./store";
import { api } from "./trpc";

// mermaid is loaded as a global <script> in index.html (offline vendor bundle)
const mermaid = (window as any).mermaid;
if (mermaid) mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });

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
