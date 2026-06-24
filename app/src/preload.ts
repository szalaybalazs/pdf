/**
 * Preload: exposes the electron-trpc bridge to the renderer. The renderer talks
 * to the main process exclusively through the typed tRPC client (see
 * renderer/src/trpc.ts); no other Node globals leak into the page.
 */
import { exposeElectronTRPC } from "electron-trpc/main";

process.once("loaded", () => {
  exposeElectronTRPC();
});
