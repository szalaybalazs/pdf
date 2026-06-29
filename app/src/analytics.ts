/**
 * Privacy-respecting product analytics via Aptabase.
 *
 * All tracking runs in the main process. Every event is built here from
 * app-level signals — counts, providers, latencies, booleans — and NEVER from
 * document content, filenames, file paths, questions, answers, or API keys.
 * Aptabase collects no PII and no IP-based identifiers; it derives an anonymous
 * per-install id on its own, so we add nothing that could identify a user.
 *
 * The user can opt out at any time (Settings → "Send anonymous usage data").
 * When disabled we simply stop emitting events — Aptabase is still initialised
 * once at startup, so toggling back on takes effect immediately, no restart.
 */
import { initialize, trackEvent } from "@aptabase/electron/main";

// Aptabase app key. NOT a secret — Aptabase keys are designed to ship inside
// client apps — so it's baked in here for packaged builds. The region in the
// key ("A-EU-…" / "A-US-…" / "A-SH-…" for self-hosted) selects the endpoint.
// Env vars override it for dev / alternate environments. When blank → no-op.
//
// This module is only ever imported by the main process, so `process` is safe
// here (unlike the renderer-shared branding.ts).
const APTABASE_APP_KEY = process.env.APTABASE_APP_KEY || "A-EU-6684394940";

// Only needed for a self-hosted Aptabase instance (used with an "A-SH-…" key).
const APTABASE_HOST = process.env.APTABASE_HOST || "";

type Props = Record<string, string | number | boolean>;
type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

let enabled = false;     // mirrors the user's opt-out setting
let started = false;     // Aptabase.initialize() has run
let log: Logger = () => {};

/**
 * Initialise Aptabase. MUST be called BEFORE the app `ready` event — the SDK
 * registers a privileged protocol scheme and bails out (disabling tracking) if
 * the app is already ready. It then awaits `whenReady` internally to finish
 * setup, buffering any events sent in the meantime. Safe to call without a key
 * (no-op). Never throws — analytics must not be able to break startup.
 *
 * The opt-out flag is applied separately via setAnalyticsEnabled() once settings
 * are readable, so this can run at the earliest possible moment.
 */
export function initAnalytics(opts: { log?: Logger } = {}): void {
  if (opts.log) log = opts.log;
  if (started) return;
  if (!APTABASE_APP_KEY) {
    log("info", "analytics: no APTABASE_APP_KEY set; tracking disabled");
    return;
  }
  try {
    void initialize(APTABASE_APP_KEY, APTABASE_HOST ? { host: APTABASE_HOST } : undefined);
    started = true;
    log("info", `analytics: initialised${APTABASE_HOST ? ` (host=${APTABASE_HOST})` : ""}`);
  } catch (e) {
    log("warn", "analytics: initialise failed", (e as Error).message);
  }
}

/** Reflect a settings change without restarting (opt-in / opt-out). */
export function setAnalyticsEnabled(v: boolean): void {
  if (enabled === v) return;
  enabled = v;
  log("info", `analytics: ${v ? "enabled" : "disabled"} by user`);
}

/** Fire-and-forget a single event. No-op unless initialised and opted in. */
export function track(event: string, props?: Props): void {
  if (!enabled || !started) return;
  trackEvent(event, props).catch((e) =>
    log("warn", `analytics: trackEvent(${event}) failed`, (e as Error).message));
}
