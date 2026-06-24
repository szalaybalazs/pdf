/**
 * Renderer entry point. Wires the preload `window.api` event streams into the
 * store, then mounts the React app.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { handleServeEvent, handleIngestEvent } from "./store";
import { api } from "./trpc";

// mermaid is loaded as a global <script> in index.html (offline vendor bundle)
const mermaid = (window as any).mermaid;
if (mermaid) mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });

// subscribe to backend streams
api.onServeEvent(handleServeEvent);
api.onIngestEvent(handleIngestEvent);
api.onServeLog((line) => console.log("[backend]", line));

// Backstop for the startup race: explicitly request status + persisted threads
// in case the initial "ready" fired before this listener was registered.
api.sendRequest({ type: "info" });
api.sendRequest({ type: "threads_dump" });

createRoot(document.getElementById("root")!).render(<App />);
