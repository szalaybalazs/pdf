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
  localModels: LocalModelSettings[];
  // AWS Bedrock via its OpenAI-compatible gateway. The API key (a bearer token)
  // is encrypted like the others; the region is not a secret (plaintext).
  bedrockApiKey: string;
  bedrockRegion: string;
  // Anonymous usage analytics (Aptabase). Opt-out: defaults to true (enabled),
  // but never sends document content, filenames, questions, answers, or keys.
  analyticsEnabled: boolean;
  // Remote web access: an HTTPS server hosted by this app that serves the same
  // UI to a browser (desktop or mobile), gated by HTTP Basic Auth. The password
  // is a secret (encrypted at rest); the rest are plaintext.
  remoteEnabled: boolean;
  remotePort: number;
  remoteUsername: string;
  remotePassword: string;
}

export interface LocalModelSettings {
  baseUrl: string;
  apiKey: string;
  model: string;
  // Text-only model (no vision input): the answerer skips page images and uses
  // the text-only system prompt. Defaults to false (vision on).
  textOnly: boolean;
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
    const localModels = Array.isArray(obj.localModels)
      ? obj.localModels.map((m: any) => ({
        baseUrl: typeof m?.baseUrl === "string" ? m.baseUrl : "",
        apiKey: dec(m?.apiKey),
        model: typeof m?.model === "string" ? m.model : "",
        textOnly: !!m?.textOnly,
      })).filter((m: LocalModelSettings) => m.baseUrl || m.apiKey || m.model)
      : [];
    if (!localModels.length && (obj.localBaseUrl || obj.localApiKey || obj.localModel)) {
      localModels.push({
        baseUrl: typeof obj.localBaseUrl === "string" ? obj.localBaseUrl : "",
        apiKey: dec(obj.localApiKey),
        model: typeof obj.localModel === "string" ? obj.localModel : "",
        textOnly: false,
      });
    }
    const firstLocal = localModels[0] || { baseUrl: "", apiKey: "", model: "", textOnly: false };
    return {
      openaiKey: dec(obj.openaiKey),
      anthropicKey: dec(obj.anthropicKey),
      openrouterKey: dec(obj.openrouterKey),
      systemPrompt: typeof obj.systemPrompt === "string" ? obj.systemPrompt : "",
      localBaseUrl: firstLocal.baseUrl,
      localApiKey: firstLocal.apiKey,
      localModel: firstLocal.model,
      localModels,
      bedrockApiKey: dec(obj.bedrockApiKey),
      bedrockRegion: typeof obj.bedrockRegion === "string" ? obj.bedrockRegion : "",
      // default ON; only an explicit `false` opts out
      analyticsEnabled: obj.analyticsEnabled !== false,
      remoteEnabled: !!obj.remoteEnabled,
      remotePort: Number.isFinite(obj.remotePort) ? obj.remotePort : 8443,
      remoteUsername: typeof obj.remoteUsername === "string" ? obj.remoteUsername : "admin",
      remotePassword: dec(obj.remotePassword),
    };
  } catch {
    return {
      openaiKey: "", anthropicKey: "", openrouterKey: "", systemPrompt: "",
      localBaseUrl: "", localApiKey: "", localModel: "", localModels: [],
      bedrockApiKey: "", bedrockRegion: "",
      analyticsEnabled: true,
      remoteEnabled: false, remotePort: 8443, remoteUsername: "admin", remotePassword: "",
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
    localBaseUrl: s.localModels?.[0]?.baseUrl || s.localBaseUrl || "",
    localApiKey: encv(s.localModels?.[0]?.apiKey || s.localApiKey || ""),
    localModel: s.localModels?.[0]?.model || s.localModel || "",
    localModels: (s.localModels || []).map((m) => ({
      baseUrl: m.baseUrl || "",
      apiKey: encv(m.apiKey || ""),
      model: m.model || "",
      textOnly: !!m.textOnly,
    })),
    bedrockApiKey: encv(s.bedrockApiKey || ""),
    bedrockRegion: s.bedrockRegion || "",
    analyticsEnabled: s.analyticsEnabled !== false,
    remoteEnabled: !!s.remoteEnabled,
    remotePort: Number.isFinite(s.remotePort) ? s.remotePort : 8443,
    remoteUsername: s.remoteUsername || "admin",
    remotePassword: encv(s.remotePassword || ""),
  };
  fs.writeFileSync(settingsPath(), JSON.stringify(obj, null, 2), { mode: 0o600 });
}
