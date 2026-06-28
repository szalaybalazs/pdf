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
  systemPrompt: string;
  // Local OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM, …).
  // Base URL + model id are not secrets (stored plaintext); the API key is
  // optional (most local servers ignore it) and encrypted like the others.
  localBaseUrl: string;
  localApiKey: string;
  localModel: string;
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
      systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : "",
      localBaseUrl: typeof obj.localBaseUrl === "string" ? obj.localBaseUrl : "",
      localApiKey: dec(obj.localApiKey),
      localModel: typeof obj.localModel === "string" ? obj.localModel : "",
    };
  } catch {
    return {
      openaiKey: "", anthropicKey: "", openrouterKey: "", systemPrompt: "",
      localBaseUrl: "", localApiKey: "", localModel: "",
    };
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
    systemPrompt: s.systemPrompt || "",
    localBaseUrl: s.localBaseUrl || "",
    localApiKey: encv(s.localApiKey || ""),
    localModel: s.localModel || "",
  };
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}
