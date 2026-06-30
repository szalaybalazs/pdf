/**
 * Crash & error reporting via Sentry.
 *
 * Captures uncaught exceptions, unhandled promise rejections and native crashes
 * from the Electron main + renderer processes. The Python backend reports into
 * the SAME Sentry project independently (see pdf_qa/errors.py); the env vars it
 * needs are produced by backendSentryEnv() below.
 *
 * Application logs are also streamed to Sentry Logs (the live web log view) and
 * the most recent lines are attached to every error event for context. main's
 * log() funnels its own logs PLUS the backend's stdout events and stderr, so
 * forwarding from recordLog() below covers both processes in one place; the
 * Python backend's own *errors* attach their own recent stderr (pdf_qa/errors.py).
 *
 * Like analytics, all of this is gated on the user's "Send anonymous usage data"
 * opt-out (Settings). Sentry is initialised once at startup regardless, and the
 * opt-out is enforced in `beforeSend` / `beforeSendLog` / `beforeBreadcrumb`:
 * when disabled we drop every event and log, so toggling it back on takes effect
 * immediately, no restart.
 *
 * The DSN is NOT a secret — Sentry DSNs are designed to ship inside client apps
 * — so it is baked in for packaged builds, with an env override for dev. When
 * blank the SDK is never initialised, so everything here is a clean no-op.
 *
 * This module is only ever imported by the main process, so `process`/`app` are
 * safe here (unlike the renderer-shared branding.ts).
 */
import * as Sentry from "@sentry/electron/main";
import { app } from "electron";

// Sentry project DSN. Not a secret — DSNs are designed to ship inside client
// apps — so it's baked in for packaged builds; SENTRY_DSN overrides for dev.
// EU-hosted project (ingest.de.sentry.io), matching the EU Aptabase region.
// Blank → reporting disabled (no-op).
const SENTRY_DSN = process.env.SENTRY_DSN
  || "https://f3c95e7087a5c3ec0f009291e74b28a8@o4511653538562048.ingest.de.sentry.io/4511653557829712";

// release/environment are shared by main, renderer (inherited over IPC) and the
// Python backend, so crashes from all three line up against the same release —
// matching the version users actually auto-updated to.
const RELEASE = `pdf-qa@${app.getVersion()}`;
const ENVIRONMENT = app.isPackaged ? "production" : "development";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

let enabled = false;     // mirrors the user's opt-out setting
let started = false;     // Sentry.init() has run
let log: Logger = () => {};

// Recent log lines kept in memory and attached to error events for context.
// Bounded so a long session can't grow it without limit.
const MAX_LOG_LINES = 200;
const ATTACH_MAX_CHARS = 16000;   // cap the attached tail (must stay < maxValueLength)
const recentLogs: string[] = [];

// Best-effort redaction of secrets that must never leave the machine, applied to
// every log line before it is buffered, streamed or attached. File names/paths
// are intentionally NOT stripped — they're needed to make logs useful, and the
// Settings copy discloses that diagnostic logs may include them.
const SECRET_RE =
  /\b(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{12,})/g;
function redact(s: string): string {
  return s.replace(SECRET_RE, "[redacted]");
}

/**
 * Strip identifying data and attach recent logs before an event leaves the
 * machine. `sendDefaultPii: false` already drops IP/cookies; we additionally
 * clear the machine hostname (`server_name`) and bolt the recent-log tail onto
 * `extra` so each issue carries the lead-up to the failure.
 */
function scrub<T extends Sentry.Event>(event: T): T {
  delete event.server_name;
  if (recentLogs.length) {
    const tail = recentLogs.join("\n").slice(-ATTACH_MAX_CHARS);
    event.extra = { recent_logs: tail, ...event.extra };
  }
  return event;
}

/**
 * Record one application log line: buffer it for error context and stream it to
 * Sentry Logs. Called from main's log() for every main + backend message, so it
 * is the single forwarding point. Cheap no-op until Sentry has initialised.
 */
export function recordLog(level: "info" | "warn" | "error", line: string): void {
  if (!started) return;
  const clean = redact(line);
  recentLogs.push(clean);
  if (recentLogs.length > MAX_LOG_LINES) recentLogs.shift();
  if (!enabled) return;   // streaming honours the opt-out (beforeSendLog also gates)
  try {
    const source = /^backend\b/.test(line) ? "backend" : "main";
    Sentry.logger[level](clean, { source });
  } catch {
    /* never let logging throw */
  }
}

/**
 * Initialise Sentry. Safe to call before the app `ready` event (and we do, so
 * the earliest startup crashes are caught). Never throws — error reporting must
 * not be able to break startup. No-op without a DSN.
 *
 * The opt-out flag is applied separately via setErrorReportingEnabled() once
 * settings are readable, so this can run at the earliest possible moment.
 */
export function initErrorReporting(opts: { log?: Logger } = {}): void {
  if (opts.log) log = opts.log;
  if (started) return;
  if (!SENTRY_DSN) {
    log("info", "errors: no SENTRY_DSN set; crash reporting disabled");
    return;
  }
  try {
    Sentry.init({
      dsn: SENTRY_DSN,
      release: RELEASE,
      environment: ENVIRONMENT,
      sendDefaultPii: false,
      // Stream application logs to Sentry Logs (live web log view). Lines are
      // emitted via recordLog() -> Sentry.logger.* from main's log() funnel.
      enableLogs: true,
      // Raise the value cap so the attached recent_logs tail isn't truncated.
      maxValueLength: 20000,
      // Drop the MainProcessSession integration. Release-health sessions are sent
      // as envelopes that bypass beforeSend, so leaving it on would leak a ping
      // for opted-out users; removing it keeps the opt-out airtight (errors +
      // native crashes still flow, all through beforeSend below). The renderer
      // SDK already excludes BrowserSession by default, so no sessions are sent
      // from either process. Re-add for crash-free-session metrics if wanted.
      integrations: (defaults) => defaults.filter((i) => i.name !== "MainProcessSession"),
      // Enforce the opt-out at send time — and for renderer events too: those
      // are forwarded to the main process and re-captured here, so this runs for
      // them as well. The SDK stays initialised either way, so flipping the
      // setting takes effect with no restart.
      beforeSend: (event) => (enabled ? scrub(event) : null),
      beforeSendLog: (logItem) => (enabled ? logItem : null),
      beforeBreadcrumb: (b) => (enabled ? b : null),
    });
    started = true;
    log("info", `errors: Sentry initialised (env=${ENVIRONMENT}, release=${RELEASE})`);
  } catch (e) {
    log("warn", "errors: Sentry init failed", (e as Error).message);
  }
}

/** Reflect a settings change without restarting (opt-in / opt-out). */
export function setErrorReportingEnabled(v: boolean): void {
  if (enabled === v) return;
  enabled = v;
  log("info", `errors: reporting ${v ? "enabled" : "disabled"} by user`);
}

/** Report a handled exception we'd otherwise swallow. No-op unless opted in. */
export function captureException(e: unknown, extra?: Record<string, unknown>): void {
  if (!enabled || !started) return;
  try {
    Sentry.captureException(e, extra ? { extra } : undefined);
  } catch {
    /* never let reporting throw */
  }
}

/**
 * Env vars handed to the Python backend so it reports into the same Sentry
 * project, tagged with the same release/environment. Returns {} when there is
 * no DSN or the user has opted out — so the backend stays silent in exactly the
 * cases the desktop side does. The backend is respawned on settings change, so
 * this is re-evaluated on every (re)start and needs no live toggle of its own.
 */
export function backendSentryEnv(reportingEnabled: boolean): Record<string, string> {
  if (!SENTRY_DSN || !reportingEnabled) return {};
  return {
    PDF_QA_SENTRY_DSN: SENTRY_DSN,
    PDF_QA_SENTRY_RELEASE: RELEASE,
    PDF_QA_SENTRY_ENV: ENVIRONMENT,
  };
}
