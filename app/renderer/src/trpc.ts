/**
 * Renderer-side tRPC client (over electron-trpc's IPC link) plus a small `api`
 * shim that mirrors the call sites the rest of the renderer uses. One-shot calls
 * are mutations/queries; the backend's event feeds are tRPC subscriptions.
 */
import { createTRPCProxyClient } from "@trpc/client";
import { ipcLink } from "electron-trpc/renderer";
import type { AppRouter, UpdateState } from "../../src/trpc";

export type { UpdateState } from "../../src/trpc";

export const trpc = createTRPCProxyClient<AppRouter>({ links: [ipcLink()] });

export const api = {
  sendRequest(req: unknown): void {
    void trpc.sendRequest.mutate(req).catch((e) => console.error("[trpc] sendRequest", e));
  },
  openFigure: (p: string) => trpc.openFigure.mutate(p),
  openDoc: (name: string) => trpc.openDoc.mutate(name),
  removeDoc: (name: string) => trpc.removeDoc.mutate(name),
  addPdfs: () => trpc.addPdfs.mutate(),
  addTempPdfs: (threadId: string, filePaths: string[]) => trpc.addTempPdfs.mutate({ threadId, filePaths }),
  exportPdf: (html: string, title: string) => trpc.exportPdf.mutate({ html, title }),
  showDocMenu: (name: string) => trpc.showDocMenu.mutate(name),
  showThreadMenu: (title: string, messages: unknown[], markdown: string, filename: string) =>
    trpc.showThreadMenu.mutate({ title, messages, markdown, filename }),
  showModelMenu: (models: { id: string; label: string; provider?: string; model?: string; via_openrouter?: boolean }[], selectedModel: string) =>
    trpc.showModelMenu.mutate({ models, selectedModel }),
  getSettings: () => trpc.getSettings.query(),
  setSettings: (s: {
    openaiKey: string; anthropicKey: string; openrouterKey: string; systemPrompt: string;
    localBaseUrl: string; localApiKey: string; localModel: string;
    localModels: { baseUrl: string; apiKey: string; model: string; textOnly: boolean }[];
    bedrockApiKey: string; bedrockRegion: string;
    analyticsEnabled: boolean;
  }) =>
    trpc.setSettings.mutate(s),
  onServeEvent: (cb: (e: any) => void) => { trpc.serveEvents.subscribe(undefined, { onData: cb }); },
  onIngestEvent: (cb: (e: any) => void) => { trpc.ingestEvents.subscribe(undefined, { onData: cb }); },
  onServeLog: (cb: (line: string) => void) => { trpc.serveLog.subscribe(undefined, { onData: cb }); },
  onUpdateEvent: (cb: (s: UpdateState) => void) => { trpc.updateEvents.subscribe(undefined, { onData: cb }); },
  installUpdate: () => trpc.installUpdate.mutate(),
  // Fire-and-forget engagement analytics. Pass counts/enums only — never content
  // (thread titles, search queries, document names). Main allowlists event names.
  track: (event: string, props?: Record<string, string | number | boolean>) => {
    void trpc.track.mutate({ event, props }).catch(() => { /* analytics must never surface */ });
  },
};

declare global {
  interface Window {
    pdfQaFiles?: {
      pathForFile: (file: File) => string;
    };
    pdfQaApp?: {
      platform: NodeJS.Platform;
    };
  }
}
