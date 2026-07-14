/**
 * Bundles the React renderer with esbuild.
 *   - dist/renderer.js      → the Electron window build (electron-trpc IPC).
 *   - dist/renderer.web.js  → the remote web build (WebSocket transport), served
 *                             by the app's HTTPS server. It aliases every
 *                             `./trpc` / `../trpc` import to `trpc.web.ts` so the
 *                             same components run against the browser transport.
 * Run with --watch for incremental rebuilds during development.
 */
import * as esbuild from "esbuild";
import * as path from "path";
import { fileURLToPath } from "url";

const watch = process.argv.includes("--watch");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const trpcWeb = path.resolve(__dirname, "renderer/src/trpc.web.ts");

// Redirect the electron `./trpc` module to its browser twin for the web build.
// Scoped to the exact relative specifiers the renderer uses (`./trpc`,
// `../trpc`) so the type-only `../../src/trpc` import inside trpc.web.ts (which
// esbuild erases) is never touched.
const trpcWebAlias = {
  name: "trpc-web-alias",
  setup(build) {
    build.onResolve({ filter: /^\.{1,2}\/trpc$/ }, () => ({ path: trpcWeb }));
  },
};

const common = {
  bundle: true,
  format: "esm",
  jsx: "automatic",
  target: "es2020",
  sourcemap: true,
  // React/ReactDOM read process.env.NODE_ENV; define it so the browser bundle
  // doesn't reference an undefined `process` global at runtime.
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
};

const electronOptions = {
  ...common,
  entryPoints: ["renderer/src/main.tsx"],
  outfile: "dist/renderer.js",
};

const webOptions = {
  ...common,
  entryPoints: ["renderer/src/main.web.tsx"],
  outfile: "dist/renderer.web.js",
  plugins: [trpcWebAlias],
};

if (watch) {
  const c1 = await esbuild.context(electronOptions);
  const c2 = await esbuild.context(webOptions);
  await Promise.all([c1.watch(), c2.watch()]);
  console.log("esbuild: watching renderer (electron + web)…");
} else {
  await Promise.all([esbuild.build(electronOptions), esbuild.build(webOptions)]);
}
