/**
 * Browser-side twin of `trpc.ts`, used only by the remote web build. It exposes
 * the identical `api` surface so the React app (App.tsx, store.ts, components)
 * runs unchanged — the only difference is the transport: a WebSocket to the
 * desktop app's `wss://<host>/trpc` endpoint instead of electron-trpc's IPC.
 *
 * The WebSocket handshake reuses the HTTP Basic Auth credentials the browser
 * already cached when it loaded the page (same origin, same realm), so there is
 * no separate token exchange.
 *
 * Host-only actions have no meaning in a browser and are stubbed here:
 *   - upload (addPdfs/addTempPdfs) is intentionally unavailable remotely;
 *   - native OS menus become a small in-page picker (model) or no-ops;
 *   - "open in OS viewer" becomes opening the image/PDF in a new tab.
 */
import { createTRPCProxyClient, createWSClient, wsLink } from "@trpc/client";
import type { AppRouter, UpdateState } from "../../src/trpc";

export type { UpdateState } from "../../src/trpc";

const wsUrl = `${location.protocol === "https:" ? "wss" : "ws"}://${location.host}/trpc`;
const wsClient = createWSClient({
  url: wsUrl,
  // Re-request the snapshot (index stats + persisted threads) on every
  // (re)connection, not just once at load. Tunnels (Cloudflare) drop idle
  // WebSockets after ~100s; wsLink auto-resumes subscriptions on reconnect but
  // NOT these one-shot requests, so without this the thread list goes stale
  // after the first drop. Subscriptions are queued ahead of these in the same
  // reconnect batch, so their listeners attach before the backend replies.
  onOpen: () => {
    try {
      trpc.sendRequest.mutate({ type: "info" });
      trpc.sendRequest.mutate({ type: "threads_dump" });
    } catch { /* client not ready yet */ }
  },
});

export const trpc = createTRPCProxyClient<AppRouter>({ links: [wsLink({ client: wsClient })] });

// --- in-page model picker (replaces the native Electron menu) ----------------

interface ModelItem { id: string; label: string; provider?: string; model?: string; via_openrouter?: boolean }

function pickModel(models: ModelItem[], selected: string): Promise<string | null> {
  return new Promise((resolve) => {
    const scrim = document.createElement("div");
    scrim.className = "modal-scrim fixed inset-0 z-[200] flex items-center justify-center backdrop-blur-[2px]";
    const panel = document.createElement("div");
    panel.className = "flex max-h-[70vh] w-[320px] max-w-[calc(100vw-32px)] flex-col overflow-y-auto rounded-2xl border border-border-strong bg-bg p-2 shadow-[0_8px_30px_rgba(20,20,18,0.18)]";
    const done = (id: string | null) => { scrim.remove(); resolve(id); };
    for (const m of models) {
      const btn = document.createElement("button");
      const isSel = m.id === selected;
      btn.className = "flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-[13px] text-ink transition hover:bg-surface-2" + (isSel ? " font-semibold" : "");
      btn.textContent = (isSel ? "✓ " : "") + m.label;
      btn.onclick = () => done(m.id);
      panel.appendChild(btn);
    }
    scrim.appendChild(panel);
    scrim.onclick = (e) => { if (e.target === scrim) done(null); };
    document.body.appendChild(scrim);
  });
}

function openImageInTab(dataUrl: string): void {
  if (!dataUrl) return;
  const w = window.open("", "_blank");
  if (w) w.document.write(`<img src="${dataUrl}" style="max-width:100%" />`);
}

function printHtmlInTab(html: string, title: string): void {
  const w = window.open("", "_blank");
  if (!w) return;
  w.document.write(`<!doctype html><title>${title}</title>${html}`);
  w.document.close();
  w.focus();
  w.print();
}

export const api = {
  sendRequest(req: unknown): void {
    void trpc.sendRequest.mutate(req).catch((e) => console.error("[trpc] sendRequest", e));
  },
  // Host-only: opening in the OS viewer makes no sense remotely. Fall back to
  // reading the page image and showing it in a new browser tab.
  openFigure: async (p: string) => { openImageInTab(await trpc.readImage.query(p).catch(() => "")); return ""; },
  openDoc: async (_name: string) => { console.warn("[remote] openDoc unavailable"); return ""; },
  removeDoc: (name: string) => trpc.removeDoc.mutate(name),
  // Upload is intentionally disabled on remote clients.
  addPdfs: async () => ({ canceled: true as const }),
  addTempPdfs: async (_threadId: string, _filePaths: string[]) => ({ ok: false as const, docs: [] as string[] }),
  exportPdf: async (html: string, title: string) => { printHtmlInTab(html, title); return ""; },
  showDocMenu: async (_name: string) => { /* native menu — no remote equivalent */ },
  showThreadMenu: async (_title: string, _messages: unknown[], _markdown: string, _filename: string) => { /* native menu */ },
  showModelMenu: (models: ModelItem[], selectedModel: string) => pickModel(models, selectedModel),
  setCollection: (name: string) => trpc.setCollection.mutate(name),
  listCollections: () => trpc.listCollections.query(),
  createCollection: (name: string, language = "") => trpc.createCollection.mutate({ name, language }),
  deleteCollection: (name: string) => trpc.deleteCollection.mutate(name),
  renameCollection: (name: string, newName: string) => trpc.renameCollection.mutate({ name, newName }),
  setCollectionLanguage: (name: string, language: string) => trpc.setCollectionLanguage.mutate({ name, language }),
  addRemoteLibrary: (input: { name: string; url: string; secret: string; remoteName?: string }) => trpc.addRemoteLibrary.mutate(input),
  removeRemoteLibrary: (name: string) => trpc.removeRemoteLibrary.mutate(name),
  renameRemoteLibrary: (name: string, newName: string) => trpc.renameRemoteLibrary.mutate({ name, newName }),
  testRemote: (input: { url: string; secret: string }) => trpc.testRemote.mutate(input),
  readImage: (filePath: string): Promise<string> => trpc.readImage.query(filePath),
  getSettings: () => trpc.getSettings.query(),
  setSettings: (s: {
    openaiKey: string; anthropicKey: string; openrouterKey: string; systemPrompt: string;
    localBaseUrl: string; localApiKey: string; localModel: string;
    localModels: { baseUrl: string; apiKey: string; model: string; textOnly: boolean }[];
    bedrockApiKey: string; bedrockRegion: string;
    analyticsEnabled: boolean;
    remoteEnabled: boolean; remotePort: number; remoteUsername: string; remotePassword: string;
  }) => trpc.setSettings.mutate(s),
  onServeEvent: (cb: (e: any) => void) => { trpc.serveEvents.subscribe(undefined, { onData: cb }); },
  onIngestEvent: (cb: (e: any) => void) => { trpc.ingestEvents.subscribe(undefined, { onData: cb }); },
  onServeLog: (cb: (line: string) => void) => { trpc.serveLog.subscribe(undefined, { onData: cb }); },
  onUpdateEvent: (cb: (s: UpdateState) => void) => { trpc.updateEvents.subscribe(undefined, { onData: cb }); },
  installUpdate: async () => { /* updates are a desktop concern */ },
  track: (event: string, props?: Record<string, string | number | boolean>) => {
    void trpc.track.mutate({ event, props }).catch(() => { /* analytics must never surface */ });
  },
};

declare global {
  interface Window {
    pdfQaFiles?: { pathForFile: (file: File) => string };
    pdfQaApp?: { platform: NodeJS.Platform };
  }
}
