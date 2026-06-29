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
  openaiKey: string; anthropicKey: string; openrouterKey: string; systemPrompt: string;
  localBaseUrl: string; localApiKey: string; localModel: string; dataDir?: string;
  localModels: LocalModelSettings[];
  analyticsEnabled: boolean;
}
export interface LocalModelSettings { baseUrl: string; apiKey: string; model: string; textOnly: boolean; }
export interface ModelMenuItem { id: string; label: string; provider?: string; model?: string; via_openrouter?: boolean; }

// Auto-update state pushed to the renderer (drives the sidebar "Restart to
// update" indicator). The download happens in the background; the renderer only
// reacts to these state transitions.
export type UpdateStatus = "available" | "downloading" | "downloaded" | "error";
export interface UpdateState {
  status: UpdateStatus;
  version?: string;
  percent?: number;
  message?: string;
}

export interface RouterDeps {
  bus: EventEmitter;                       // emits "serve-event" | "ingest-event" | "serve-log"
  drainServeBuffer: () => unknown[];       // serve events buffered before first subscriber
  markServeSubscribed: () => void;
  sendToBackend: (req: unknown) => void;
  getSettings: () => Promise<AppSettings>;
  setSettings: (s: { openaiKey: string; anthropicKey: string; openrouterKey: string; systemPrompt: string; localBaseUrl: string; localApiKey: string; localModel: string; localModels: LocalModelSettings[]; analyticsEnabled: boolean }) => Promise<{ ok: boolean }>;
  openFigure: (filePath: string) => Promise<string>;
  openDoc: (name: string) => Promise<string>;
  removeDoc: (name: string) => Promise<void>;
  addPdfs: () => Promise<{ canceled: boolean; count?: number }>;
  addTempPdfs: (input: { threadId: string; filePaths: string[] }) => Promise<{ ok: boolean; docs: string[] }>;
  exportPdf: (input: { html: string; title: string }) => Promise<string>;
  showDocMenu: (name: string) => Promise<void>;
  showThreadMenu: (input: { title: string; messages: unknown[] }) => Promise<void>;
  showModelMenu: (input: { models: ModelMenuItem[]; selectedModel: string }) => Promise<string | null>;
  getUpdateState: () => UpdateState | null;   // current update state for late subscribers
  installUpdate: () => boolean;               // quit + install; false = dev no-op
}

const t = initTRPC.create({ isServer: true });

const keys = z.object({
  openaiKey: z.string(),
  anthropicKey: z.string(),
  openrouterKey: z.string(),
  systemPrompt: z.string(),
  localBaseUrl: z.string(),
  localApiKey: z.string(),
  localModel: z.string(),
  localModels: z.array(z.object({
    baseUrl: z.string(),
    apiKey: z.string(),
    model: z.string(),
    textOnly: z.boolean().default(false),
  })).default([]),
  analyticsEnabled: z.boolean().default(true),
});

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
    addTempPdfs: t.procedure.input(z.object({
      threadId: z.string(),
      filePaths: z.array(z.string()),
    })).mutation(({ input }) => deps.addTempPdfs(input)),
    exportPdf: t.procedure.input(z.object({ html: z.string(), title: z.string() }))
      .mutation(({ input }) => deps.exportPdf(input)),
    showDocMenu: t.procedure.input(z.string()).mutation(async ({ input }) => { await deps.showDocMenu(input); return true; }),
    showThreadMenu: t.procedure.input(z.object({
      title: z.string(),
      messages: z.array(z.any()),
    })).mutation(async ({ input }) => { await deps.showThreadMenu(input); return true; }),
    showModelMenu: t.procedure.input(z.object({
      models: z.array(z.object({
        id: z.string(),
        label: z.string(),
        provider: z.string().optional(),
        model: z.string().optional(),
        via_openrouter: z.boolean().optional(),
      })),
      selectedModel: z.string(),
    })).mutation(({ input }) => deps.showModelMenu(input)),
    installUpdate: t.procedure.mutation(() => deps.installUpdate()),

    // --- streamed backend feeds --------------------------------------------
    updateEvents: t.procedure.subscription(() => observable<UpdateState>((emit) => {
      const current = deps.getUpdateState();
      if (current) emit.next(current);                  // replay latest state to a late subscriber
      const h = (ev: UpdateState) => emit.next(ev);
      deps.bus.on("update-event", h);
      return () => deps.bus.off("update-event", h);
    })),
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
