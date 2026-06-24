/**
 * Persisted app settings (API keys), stored in the Electron userData directory.
 *
 * Keys are encrypted at rest with Electron's safeStorage (OS keychain-backed)
 * when available. On platforms where encryption is unavailable (some headless
 * Linux setups) they fall back to plaintext, flagged by `enc: false` so reads
 * know not to attempt decryption.
 */
import { app, safeStorage } from "electron";
import * as fs from "fs";
import * as path from "path";

export interface Settings {
  openaiKey: string;
  anthropicKey: string;
  openrouterKey: string;
}

function settingsPath(): string {
  return path.join(app.getPath("userData"), "settings.json");
}

export function readSettings(): Settings {
  try {
    const obj = JSON.parse(fs.readFileSync(settingsPath(), "utf-8"));
    const encrypted = !!obj.enc && safeStorage.isEncryptionAvailable();
    const dec = (v: unknown): string => {
      if (!v || typeof v !== "string") return "";
      if (!encrypted) return v;
      try { return safeStorage.decryptString(Buffer.from(v, "base64")); }
      catch { return ""; }
    };
    return {
      openaiKey: dec(obj.openaiKey),
      anthropicKey: dec(obj.anthropicKey),
      openrouterKey: dec(obj.openrouterKey),
    };
  } catch {
    return { openaiKey: "", anthropicKey: "", openrouterKey: "" };
  }
}

export function writeSettings(s: Settings): void {
  const enc = safeStorage.isEncryptionAvailable();
  const encv = (v: string): string =>
    !v ? "" : (enc ? safeStorage.encryptString(v).toString("base64") : v);
  const obj = {
    enc,
    openaiKey: encv(s.openaiKey || ""),
    anthropicKey: encv(s.anthropicKey || ""),
    openrouterKey: encv(s.openrouterKey || ""),
  };
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}
