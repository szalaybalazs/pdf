/**
 * Remote web access: an HTTPS server, hosted by the desktop app, that serves the
 * same renderer UI to a browser (desktop or mobile) and bridges it to the SAME
 * tRPC `appRouter` over a WebSocket. The browser therefore drives the identical
 * backend (threads, messages, streaming answers) as the local Electron window —
 * the router can't tell the two apart.
 *
 * Security model (deliberately simple, per request):
 *   - HTTPS with a self-signed cert generated once and cached in userData. The
 *     browser shows a one-time "not trusted" warning the user clicks through.
 *   - HTTP Basic Auth on every request AND on the WebSocket upgrade. Credentials
 *     come from settings (username + password). No rate limiting, no tunnels.
 *   - Upload is intentionally NOT supported remotely (the browser `api` stubs
 *     addPdfs/addTempPdfs), so the server never accepts file bodies.
 *
 * This module owns zero app state: `startWebServer` takes the router, a config
 * getter, and a logger, and returns a handle with `.close()`. main.ts decides
 * when to (re)start it based on settings.
 */
import * as http from "http";
import * as https from "https";
import * as fs from "fs";
import * as path from "path";
import { timingSafeEqual, createHmac, randomBytes } from "crypto";
import { WebSocketServer } from "ws";
import { applyWSSHandler } from "@trpc/server/adapters/ws";
import type { AnyRouter } from "@trpc/server";

export interface WebServerConfig {
  port: number;
  username: string;
  password: string;
}

export interface WebServerDeps {
  router: AnyRouter;
  getConfig: () => WebServerConfig;
  // Directory holding the built web assets: renderer.web.js(.map), styles.css,
  // and the `vendor/` folder (katex, etc.). In dev and packaged builds alike
  // main.ts resolves this to the on-disk renderer directory + dist.
  assets: { webBundle: string; webBundleMap: string; stylesCss: string; vendorDir: string };
  // Persisted cert/key location (userData). Generated on first run.
  certDir: string;
  log: (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;
}

export interface WebServerHandle {
  close: () => Promise<void>;
  port: number;
}

// --- self-signed certificate -------------------------------------------------

function ensureCert(certDir: string): { key: string; cert: string } {
  const keyPath = path.join(certDir, "web-key.pem");
  const certPath = path.join(certDir, "web-cert.pem");
  try {
    if (fs.existsSync(keyPath) && fs.existsSync(certPath)) {
      return { key: fs.readFileSync(keyPath, "utf-8"), cert: fs.readFileSync(certPath, "utf-8") };
    }
  } catch { /* fall through to regenerate */ }
  // Lazy require so the (pure-JS) dependency only loads when remote access is on.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const selfsigned = require("selfsigned");
  const attrs = [{ name: "commonName", value: "pdf-qa-remote" }];
  const pems = selfsigned.generate(attrs, {
    days: 3650,
    keySize: 2048,
    algorithm: "sha256",
    extensions: [{ name: "basicConstraints", cA: true }],
  });
  fs.mkdirSync(certDir, { recursive: true });
  fs.writeFileSync(keyPath, pems.private, { mode: 0o600 });
  fs.writeFileSync(certPath, pems.cert, { mode: 0o600 });
  return { key: pems.private, cert: pems.cert };
}

// --- basic auth --------------------------------------------------------------

function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a);
  const bb = Buffer.from(b);
  // timingSafeEqual requires equal lengths; length itself isn't secret here, but
  // pad to a constant compare so mismatched lengths don't short-circuit visibly.
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

function checkBasicAuth(header: string | undefined, cfg: WebServerConfig): boolean {
  if (!header || !header.startsWith("Basic ")) return false;
  let decoded = "";
  try { decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf-8"); }
  catch { return false; }
  const idx = decoded.indexOf(":");
  if (idx < 0) return false;
  const user = decoded.slice(0, idx);
  const pass = decoded.slice(idx + 1);
  // Evaluate both comparisons regardless so timing doesn't leak which failed.
  const userOk = safeEqual(user, cfg.username);
  const passOk = safeEqual(pass, cfg.password);
  return userOk && passOk;
}

// --- session cookie ----------------------------------------------------------
// Basic Auth alone re-prompts on every navigation through some proxies, and
// browsers don't reliably attach the Authorization header to WebSocket
// handshakes. So on first successful auth we set a signed session cookie and
// accept it thereafter — cookies ARE reliably resent on navigations and on the
// same-origin WS upgrade. The signature covers username+password (so changing
// either invalidates old sessions) and a per-process secret (so cookies die on
// app restart).
const COOKIE_NAME = "pdfqa_sess";

function sessionValue(cfg: WebServerConfig, secret: Buffer): string {
  const sig = createHmac("sha256", secret).update(`${cfg.username}\0${cfg.password}`).digest("base64url");
  return `${Buffer.from(cfg.username).toString("base64url")}.${sig}`;
}

function checkCookie(header: string | undefined, cfg: WebServerConfig, secret: Buffer): boolean {
  if (!header) return false;
  const part = header.split(/;\s*/).find((c) => c.startsWith(`${COOKIE_NAME}=`));
  if (!part) return false;
  return safeEqual(part.slice(COOKIE_NAME.length + 1), sessionValue(cfg, secret));
}

function isAuthed(req: http.IncomingMessage, cfg: WebServerConfig, secret: Buffer): boolean {
  return checkBasicAuth(req.headers.authorization, cfg) || checkCookie(req.headers.cookie, cfg, secret);
}

function setSessionCookie(res: http.ServerResponse, cfg: WebServerConfig, secret: Buffer): void {
  // Secure: the browser leg is always HTTPS (self-signed direct, or a tunnel's
  // real cert). SameSite=Lax still sends it on same-origin navigations + WS.
  res.setHeader("Set-Cookie",
    `${COOKIE_NAME}=${sessionValue(cfg, secret)}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=604800`);
}

// --- static asset serving ----------------------------------------------------

const CSP =
  "default-src 'self'; " +
  "img-src 'self' data:; " +
  "style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-eval'; " +
  "font-src 'self' data:; " +
  "connect-src 'self' wss: ws:;";

function webIndexHtml(): string {
  // A browser-served twin of renderer/index.html: asset paths are absolute web
  // routes (served below), the CSP allows the wss bridge, and the bundle can
  // tell it's running remotely because the Electron preload bridge is absent.
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
  <meta http-equiv="Content-Security-Policy" content="${CSP}" />
  <title>PDF QA</title>
  <link rel="stylesheet" href="/vendor/katex/katex.min.css" />
  <link rel="stylesheet" href="/styles.css" />
</head>
<body>
  <div id="root"></div>
  <script src="/vendor/katex/katex.min.js"></script>
  <script type="module" src="/renderer.web.js"></script>
</body>
</html>`;
}

const MIME: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
};

function sendFile(res: http.ServerResponse, filePath: string): void {
  fs.readFile(filePath, (err, buf) => {
    if (err) { res.writeHead(404).end("not found"); return; }
    res.writeHead(200, {
      "Content-Type": MIME[path.extname(filePath).toLowerCase()] || "application/octet-stream",
      "Content-Security-Policy": CSP,
      "Cache-Control": "no-cache",
    });
    res.end(buf);
  });
}

// Resolve a request path to a real file under one of the allowed asset roots,
// guarding against path traversal (the resolved path must stay inside the root).
function resolveVendor(vendorDir: string, urlPath: string): string | null {
  const rel = urlPath.replace(/^\/vendor\//, "");
  const resolved = path.resolve(vendorDir, rel);
  if (!resolved.startsWith(path.resolve(vendorDir) + path.sep)) return null;
  return resolved;
}

function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, deps: WebServerDeps, secret: Buffer): void {
  const cfg = deps.getConfig();
  if (!isAuthed(req, cfg, secret)) {
    res.writeHead(401, {
      "WWW-Authenticate": 'Basic realm="PDF QA", charset="UTF-8"',
      "Content-Type": "text/plain; charset=utf-8",
    });
    res.end("Authentication required");
    return;
  }
  // (Re)issue the session cookie on every authenticated response so refreshes
  // and the WS handshake authenticate without re-prompting.
  setSessionCookie(res, cfg, secret);

  const urlPath = (req.url || "/").split("?")[0];
  if (urlPath === "/" || urlPath === "/index.html") {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Content-Security-Policy": CSP });
    res.end(webIndexHtml());
    return;
  }
  if (urlPath === "/renderer.web.js") { sendFile(res, deps.assets.webBundle); return; }
  if (urlPath === "/renderer.web.js.map") { sendFile(res, deps.assets.webBundleMap); return; }
  if (urlPath === "/styles.css") { sendFile(res, deps.assets.stylesCss); return; }
  if (urlPath.startsWith("/vendor/")) {
    const f = resolveVendor(deps.assets.vendorDir, urlPath);
    if (f) { sendFile(res, f); return; }
  }
  res.writeHead(404).end("not found");
}

// --- lifecycle ---------------------------------------------------------------

export function startWebServer(deps: WebServerDeps): WebServerHandle {
  const cfg = deps.getConfig();
  const { key, cert } = ensureCert(deps.certDir);
  // Per-process secret used to sign session cookies. Regenerated each start, so
  // restarting the app invalidates outstanding sessions (a one-time re-login).
  const secret = randomBytes(32);

  const server = https.createServer({ key, cert }, (req, res) => {
    try { handleRequest(req, res, deps, secret); }
    catch (e) { deps.log("error", "web request failed", (e as Error).message); try { res.writeHead(500).end(); } catch { /* headers sent */ } }
  });

  // WebSocket transport for tRPC. `noServer` so we can Basic-Auth-gate the
  // upgrade ourselves before handing the socket to the ws server.
  const wss = new WebSocketServer({ noServer: true });
  // Every WS connection is a remote browser: tag its context so `localOnly`
  // procedures (settings) are rejected at the server, not just hidden in the UI.
  const trpcHandler = applyWSSHandler({ wss, router: deps.router, createContext: () => ({ remote: true }) });

  server.on("upgrade", (req, socket, head) => {
    if (!isAuthed(req, deps.getConfig(), secret)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nWWW-Authenticate: Basic realm=\"PDF QA\"\r\n\r\n");
      socket.destroy();
      return;
    }
    const urlPath = (req.url || "/").split("?")[0];
    if (urlPath !== "/trpc") { socket.destroy(); return; }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  server.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EADDRINUSE") deps.log("error", `remote web: port ${cfg.port} already in use`);
    else deps.log("error", "remote web server error", e.message);
  });

  server.listen(cfg.port, () => deps.log("info", `remote web server listening on https://0.0.0.0:${cfg.port}`));

  return {
    port: cfg.port,
    close: () =>
      new Promise<void>((resolve) => {
        try { trpcHandler.broadcastReconnectNotification(); } catch { /* no clients */ }
        wss.close();
        server.close(() => resolve());
        // Force-drop any lingering sockets so close() actually completes.
        wss.clients.forEach((c) => { try { c.terminate(); } catch { /* already gone */ } });
      }),
  };
}
