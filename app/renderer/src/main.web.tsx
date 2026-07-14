/**
 * Renderer entry point for the remote web build. Identical to main.tsx except it
 * drops the Electron-only Sentry SDK (there's no preload bridge in a browser)
 * and relies on the build aliasing `./trpc` to `trpc.web` for the WebSocket
 * transport. The React app it mounts is byte-for-byte the same components.
 */
import React from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";
import { handleServeEvent, handleIngestEvent, handleUpdateEvent } from "./store";
import { api } from "./trpc";

// subscribe to backend streams (over the WebSocket bridge)
api.onServeEvent(handleServeEvent);
api.onIngestEvent(handleIngestEvent);
api.onServeLog((line) => console.log("[backend]", line));
api.onUpdateEvent(handleUpdateEvent);

// The snapshot request (info + threads_dump) is issued from the WebSocket
// client's onOpen (see trpc.web.ts) so it re-syncs on every (re)connection, not
// just once here — tunnels drop idle sockets and reconnect.

createRoot(document.getElementById("root")!).render(<App />);
