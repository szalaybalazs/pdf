/**
 * tRPC router for renderer <-> main communication (over electron-trpc's IPC
 * transport). Mutations/queries cover one-shot actions; subscriptions stream
 * the backend's event feeds (serve events, ingest progress, raw logs).
 *
 * The router is created from a `RouterDeps` bundle so all Electron-specific
 * side effects live in main.ts and this module stays a thin, typed surface.
 */
import { initTRPC } from "@trpc/server";
import { observable } from "@trpc/server/observable";
import { z } from "zod";
import type { EventEmitter } from "events";

export interface AppSettings {
  openaiKey: string; anthropicKey: string; openrouterKey: string; dataDir?: string;
}

export interface RouterDeps {
  bus: EventEmitter;                       // emits "serve-event" | "ingest-event" | "serve-log"
  drainServeBuffer: () => unknown[];       // serve events buffered before first subscriber
  markServeSubscribed: () => void;
  sendToBackend: (req: unknown) => void;
  getSettings: () => Promise<AppSettings>;
  setSettings: (s: { openaiKey: string; anthropicKey: string; openrouterKey: string }) => Promise<{ ok: boolean }>;
  openFigure: (filePath: string) => Promise<string>;
  openDoc: (name: string) => Promise<string>;
  removeDoc: (name: string) => Promise<void>;
  addPdfs: () => Promise<{ canceled: boolean; count?: number }>;
  exportPdf: (input: { html: string; title: string }) => Promise<string>;
  showDocMenu: (name: string) => Promise<void>;
}

const t = initTRPC.create({ isServer: true });

const keys = z.object({ openaiKey: z.string(), anthropicKey: z.string(), openrouterKey: z.string() });

export function createAppRouter(deps: RouterDeps) {
  return t.router({
    // --- one-shot actions ---------------------------------------------------
    sendRequest: t.procedure.input(z.any()).mutation(({ input }) => { deps.sendToBackend(input); return true; }),
    getSettings: t.procedure.query(() => deps.getSettings()),
    setSettings: t.procedure.input(keys).mutation(({ input }) => deps.setSettings(input)),
    openFigure: t.procedure.input(z.string()).mutation(({ input }) => deps.openFigure(input)),
    openDoc: t.procedure.input(z.string()).mutation(({ input }) => deps.openDoc(input)),
    removeDoc: t.procedure.input(z.string()).mutation(async ({ input }) => { await deps.removeDoc(input); return true; }),
    addPdfs: t.procedure.mutation(() => deps.addPdfs()),
    exportPdf: t.procedure.input(z.object({ html: z.string(), title: z.string() }))
      .mutation(({ input }) => deps.exportPdf(input)),
    showDocMenu: t.procedure.input(z.string()).mutation(async ({ input }) => { await deps.showDocMenu(input); return true; }),

    // --- streamed backend feeds --------------------------------------------
    serveEvents: t.procedure.subscription(() => observable<any>((emit) => {
      deps.markServeSubscribed();
      for (const ev of deps.drainServeBuffer()) emit.next(ev);   // replay anything emitted pre-subscribe
      const h = (ev: unknown) => emit.next(ev);
      deps.bus.on("serve-event", h);
      return () => deps.bus.off("serve-event", h);
    })),
    ingestEvents: t.procedure.subscription(() => observable<any>((emit) => {
      const h = (ev: unknown) => emit.next(ev);
      deps.bus.on("ingest-event", h);
      return () => deps.bus.off("ingest-event", h);
    })),
    serveLog: t.procedure.subscription(() => observable<string>((emit) => {
      const h = (line: string) => emit.next(line);
      deps.bus.on("serve-log", h);
      return () => deps.bus.off("serve-log", h);
    })),
  });
}

export type AppRouter = ReturnType<typeof createAppRouter>;
