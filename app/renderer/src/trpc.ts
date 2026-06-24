/**
 * Renderer-side tRPC client (over electron-trpc's IPC link) plus a small `api`
 * shim that mirrors the call sites the rest of the renderer uses. One-shot calls
 * are mutations/queries; the backend's event feeds are tRPC subscriptions.
 */
import { createTRPCProxyClient } from "@trpc/client";
import { ipcLink } from "electron-trpc/renderer";
import type { AppRouter } from "../../src/trpc";

export const trpc = createTRPCProxyClient<AppRouter>({ links: [ipcLink()] });

export const api = {
  sendRequest(req: unknown): void {
    void trpc.sendRequest.mutate(req).catch((e) => console.error("[trpc] sendRequest", e));
  },
  openFigure: (p: string) => trpc.openFigure.mutate(p),
  openDoc: (name: string) => trpc.openDoc.mutate(name),
  removeDoc: (name: string) => trpc.removeDoc.mutate(name),
  addPdfs: () => trpc.addPdfs.mutate(),
  exportPdf: (html: string, title: string) => trpc.exportPdf.mutate({ html, title }),
  showDocMenu: (name: string) => trpc.showDocMenu.mutate(name),
  getSettings: () => trpc.getSettings.query(),
  setSettings: (s: { openaiKey: string; anthropicKey: string; openrouterKey: string; systemPrompt: string }) =>
    trpc.setSettings.mutate(s),
  onServeEvent: (cb: (e: any) => void) => { trpc.serveEvents.subscribe(undefined, { onData: cb }); },
  onIngestEvent: (cb: (e: any) => void) => { trpc.ingestEvents.subscribe(undefined, { onData: cb }); },
  onServeLog: (cb: (line: string) => void) => { trpc.serveLog.subscribe(undefined, { onData: cb }); },
};
