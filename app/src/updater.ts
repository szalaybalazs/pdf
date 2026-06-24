/**
 * Auto-update wiring (electron-updater).
 *
 * On launch — once the window exists — the app asks the S3 update feed whether a
 * newer build is published (the `publish` block in electron-builder.yml writes
 * latest.yml / latest-mac.yml next to the installers). If so it downloads in the
 * background and, when ready, offers to restart-and-install via a native dialog.
 *
 * Updates only run in a packaged, signed build: `app.isPackaged` is false under
 * `electron .` during development, and electron-updater would otherwise throw on
 * the missing dev-app-update.yml. All update activity is appended to the same
 * main.log the rest of the app uses (passed in as `log`).
 */
import { app, dialog, BrowserWindow } from "electron";
import { autoUpdater } from "electron-updater";
import { APP_NAME } from "./branding";

type Logger = (level: "info" | "warn" | "error", msg: string, extra?: unknown) => void;

let wired = false;
let getAppWindow: (() => BrowserWindow | null) | null = null;
let appLog: Logger | null = null;
let checking = false;

async function showUpdateMessage(opts: Electron.MessageBoxOptions): Promise<void> {
  const win = getAppWindow?.() ?? BrowserWindow.getFocusedWindow();
  if (win) await dialog.showMessageBox(win, opts);
  else await dialog.showMessageBox(opts);
}

export async function checkForUpdates(manual = false): Promise<void> {
  const log = appLog ?? (() => undefined);

  if (!app.isPackaged) {
    log("info", "auto-update: check skipped (not packaged)");
    if (manual) {
      await showUpdateMessage({
        type: "info",
        buttons: ["OK"],
        title: APP_NAME,
        message: "Update checks are only available in packaged builds.",
        detail: "Run an installed, signed build to check the published update feed.",
      });
    }
    return;
  }

  if (checking) {
    if (manual) {
      await showUpdateMessage({
        type: "info",
        buttons: ["OK"],
        title: APP_NAME,
        message: "Already checking for updates.",
      });
    }
    return;
  }

  checking = true;
  let settledByEvent = false;

  const cleanup = () => {
    autoUpdater.off("update-not-available", onNotAvailable);
    autoUpdater.off("update-available", onAvailable);
    autoUpdater.off("error", onError);
  };
  const settle = () => {
    settledByEvent = true;
    checking = false;
    cleanup();
  };
  const onNotAvailable = async () => {
    settle();
    if (manual) {
      await showUpdateMessage({
        type: "info",
        buttons: ["OK"],
        title: APP_NAME,
        message: `${APP_NAME} is up to date.`,
      });
    }
  };
  const onAvailable = async (info: { version?: string }) => {
    settle();
    if (manual) {
      await showUpdateMessage({
        type: "info",
        buttons: ["OK"],
        title: APP_NAME,
        message: `Version ${info?.version ?? ""} is available.`,
        detail: "The update is downloading in the background. You will be prompted when it is ready to install.",
      });
    }
  };
  const onError = async (err: Error) => {
    settle();
    if (manual) {
      await showUpdateMessage({
        type: "error",
        buttons: ["OK"],
        title: APP_NAME,
        message: "Could not check for updates.",
        detail: err?.message ?? String(err),
      });
    }
  };

  if (manual) {
    autoUpdater.once("update-not-available", onNotAvailable);
    autoUpdater.once("update-available", onAvailable);
    autoUpdater.once("error", onError);
  }

  try {
    await autoUpdater.checkForUpdates();
  } catch (err) {
    if (!settledByEvent) {
      checking = false;
      cleanup();
      log(manual ? "error" : "warn", "auto-update: check failed", (err as Error)?.message ?? String(err));
      if (manual) {
        await showUpdateMessage({
          type: "error",
          buttons: ["OK"],
          title: APP_NAME,
          message: "Could not check for updates.",
          detail: (err as Error)?.message ?? String(err),
        });
      }
    }
  } finally {
    if (!settledByEvent) {
      checking = false;
      cleanup();
    }
  }
}

export function initAutoUpdater(getWindow: () => BrowserWindow | null, log: Logger): void {
  getAppWindow = getWindow;
  appLog = log;

  if (!app.isPackaged) {
    log("info", "auto-update: skipped (not packaged)");
    return;
  }
  if (wired) return;
  wired = true;

  // We present our own restart prompt, so don't let electron-updater auto-install
  // on quit without asking; do fetch the package automatically once found.
  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;

  // Route electron-updater's own logging into our log file.
  autoUpdater.logger = {
    info: (m: unknown) => log("info", `auto-update: ${String(m)}`),
    warn: (m: unknown) => log("warn", `auto-update: ${String(m)}`),
    error: (m: unknown) => log("error", `auto-update: ${String(m)}`),
    debug: (m: unknown) => log("info", `auto-update[debug]: ${String(m)}`),
  } as unknown as typeof autoUpdater.logger;

  autoUpdater.on("checking-for-update", () => log("info", "auto-update: checking for update"));
  autoUpdater.on("update-not-available", () => log("info", "auto-update: up to date"));
  autoUpdater.on("update-available", (info) =>
    log("info", `auto-update: update available ${info?.version ?? "?"} — downloading`));
  autoUpdater.on("download-progress", (p) =>
    log("info", `auto-update: downloading ${Math.round(p?.percent ?? 0)}%`));
  autoUpdater.on("error", (err) =>
    log("error", "auto-update: error", err?.message ?? String(err)));

  autoUpdater.on("update-downloaded", async (info) => {
    log("info", `auto-update: downloaded ${info?.version ?? "?"} — prompting to install`);
    const win = getWindow();
    const opts = {
      type: "info" as const,
      buttons: ["Restart now", "Later"],
      defaultId: 0,
      cancelId: 1,
      title: APP_NAME,
      message: `Version ${info?.version ?? ""} has been downloaded.`,
      detail: "Restart the app to apply the update. It will also install automatically next time you quit.",
    };
    const res = win
      ? await dialog.showMessageBox(win, opts)
      : await dialog.showMessageBox(opts);
    if (res.response === 0) {
      // isSilent=false (show progress on Windows), isForceRunAfter=true (relaunch).
      autoUpdater.quitAndInstall(false, true);
    }
  });

  // Don't block startup — check shortly after the window is up.
  setTimeout(() => {
    void checkForUpdates(false);
  }, 3000);
}
