/**
 * Bundles the React renderer with esbuild → dist/renderer.js.
 * Run with --watch for incremental rebuilds during development.
 */
import * as esbuild from "esbuild";

const watch = process.argv.includes("--watch");

const options = {
  entryPoints: ["renderer/src/main.tsx"],
  bundle: true,
  outfile: "dist/renderer.js",
  format: "esm",
  jsx: "automatic",
  target: "es2020",
  sourcemap: true,
  // React/ReactDOM read process.env.NODE_ENV; define it so the browser bundle
  // doesn't reference an undefined `process` global at runtime.
  define: { "process.env.NODE_ENV": '"production"' },
  logLevel: "info",
};

if (watch) {
  const ctx = await esbuild.context(options);
  await ctx.watch();
  console.log("esbuild: watching renderer…");
} else {
  await esbuild.build(options);
}
