import React, { useEffect, useState } from "react";
import { store, closeSettings } from "../store";
import { api } from "../trpc";

const labelCls = "mb-1.5 mt-2.5 text-[12px] font-medium text-muted";
const inputCls = "w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 font-mono text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15";
const textareaCls = "min-h-[120px] w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15";

interface LocalModelForm {
  baseUrl: string;
  apiKey: string;
  model: string;
  textOnly: boolean;
}
const DEFAULT_LOCAL_BASE_URL = "http://localhost:11434/v1";
const blankLocalModel = (): LocalModelForm => ({ baseUrl: DEFAULT_LOCAL_BASE_URL, apiKey: "", model: "", textOnly: false });

export function Settings() {
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [localModels, setLocalModels] = useState<LocalModelForm[]>([blankLocalModel()]);
  const [bedrockApiKey, setBedrockApiKey] = useState("");
  const [bedrockRegion, setBedrockRegion] = useState("");
  const [analyticsEnabled, setAnalyticsEnabled] = useState(true);
  const [dataDir, setDataDir] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getSettings().then((s) => {
      if (!alive) return;
      setOpenai(s.openaiKey || "");
      setAnthropic(s.anthropicKey || "");
      setOpenrouter(s.openrouterKey || "");
      setSystemPrompt(s.systemPrompt || "");
      const models: LocalModelForm[] = s.localModels?.length
        ? s.localModels.map((m) => ({
          baseUrl: m.baseUrl || "", apiKey: m.apiKey || "", model: m.model || "", textOnly: !!m.textOnly,
        }))
        : (s.localBaseUrl || s.localApiKey || s.localModel
          ? [{ baseUrl: s.localBaseUrl || "", apiKey: s.localApiKey || "", model: s.localModel || "", textOnly: false }]
          : [blankLocalModel()]);
      setLocalModels(models);
      setBedrockApiKey(s.bedrockApiKey || "");
      setBedrockRegion(s.bedrockRegion || "");
      setAnalyticsEnabled(s.analyticsEnabled !== false);
      setDataDir(s.dataDir || "");
    }).catch(() => { /* show empty form */ });
    return () => { alive = false; };
  }, []);

  const updateLocalModel = (index: number, patch: Partial<LocalModelForm>) => {
    setLocalModels((rows) => rows.map((row, i) => i === index ? { ...row, ...patch } : row));
  };
  const addLocalModel = () => {
    setLocalModels((rows) => [...rows, blankLocalModel()]);
  };
  const removeLocalModel = (index: number) => {
    setLocalModels((rows) => rows.filter((_, i) => i !== index));
  };

  const save = async () => {
    setSaving(true);
    try {
      const cleanedLocalModels = localModels
        .map((m) => ({ baseUrl: m.baseUrl.trim(), apiKey: m.apiKey.trim(), model: m.model.trim(), textOnly: m.textOnly }))
        .filter((m) => m.model);
      const firstLocal = cleanedLocalModels[0] || { baseUrl: "", apiKey: "", model: "", textOnly: false };
      await api.setSettings({
        openaiKey: openai.trim(), anthropicKey: anthropic.trim(), openrouterKey: openrouter.trim(),
        systemPrompt: systemPrompt.trim(),
        localBaseUrl: firstLocal.baseUrl, localApiKey: firstLocal.apiKey, localModel: firstLocal.model,
        localModels: cleanedLocalModels,
        bedrockApiKey: bedrockApiKey.trim(), bedrockRegion: bedrockRegion.trim(),
        analyticsEnabled,
      });
      store.statusErr = false;
      store.status = "reconnecting to backend…";   // next "ready" overwrites this
    } finally {
      setSaving(false);
      closeSettings();
    }
  };

  return (
    <div
      className="modal-scrim fixed inset-0 z-[100] flex items-center justify-center backdrop-blur-[2px]"
      onClick={(e) => { if (e.target === e.currentTarget) closeSettings(); }}
    >
      <div className="flex max-h-[calc(100vh-48px)] w-[520px] max-w-[calc(100vw-48px)] flex-col overflow-y-auto rounded-2xl border border-border-strong bg-bg p-6 shadow-[0_8px_30px_rgba(20,20,18,0.18)]">
        <div className="mb-3.5 text-[17px] font-semibold tracking-tight text-ink">Settings</div>

        <label className={labelCls}>OpenAI API key</label>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false}
          placeholder="sk-…" value={openai} onChange={(e) => setOpenai(e.target.value)} />

        <label className={labelCls}>Anthropic API key</label>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false}
          placeholder="sk-ant-…" value={anthropic} onChange={(e) => setAnthropic(e.target.value)} />

        <label className={labelCls}>OpenRouter API key</label>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false}
          placeholder="sk-or-…" value={openrouter} onChange={(e) => setOpenrouter(e.target.value)} />

        <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
          When set, chat &amp; vision route through OpenRouter (GPT and Claude). Embeddings still use the OpenAI key.
        </div>

        <label className={labelCls}>System prompt</label>
        <textarea className={textareaCls} autoComplete="off" spellCheck={true}
          placeholder="Additional instructions appended to the default system prompt"
          value={systemPrompt} onChange={(e) => setSystemPrompt(e.target.value)} />
        <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
          Optional. When set, this is appended after the built-in document-grounding instructions.
        </div>

        <div className="mt-5 mb-1 border-t border-border-strong pt-4 text-[13px] font-semibold tracking-tight text-ink">
          Custom / local LLM
        </div>
        <div className="mb-1 text-[11.5px] leading-snug text-faint">
          Point at any OpenAI-compatible server (Ollama, LM Studio, llama.cpp, vLLM…). Set both the base URL and
          model to add it to the model picker. Pick a vision + tool-calling model (e.g. qwen2.5-vl) for full features.
        </div>

        {localModels.map((local, i) => (
          <div className="mt-3 rounded-lg border border-border bg-surface p-3" key={i}>
            <div className="mb-2 flex items-center justify-between gap-3">
              <div className="text-[12px] font-semibold text-ink">Local model {i + 1}</div>
              <button
                className="rounded-md border border-border-strong bg-bg px-2 py-1 text-[12px] text-muted transition hover:bg-surface-2 hover:text-ink"
                onClick={() => removeLocalModel(i)}
              >Remove</button>
            </div>

            <label className={labelCls}>Base URL</label>
            <input className={inputCls} type="text" autoComplete="off" spellCheck={false}
              placeholder="http://localhost:11434/v1" value={local.baseUrl} onChange={(e) => updateLocalModel(i, { baseUrl: e.target.value })} />

            <label className={labelCls}>Model</label>
            <input className={inputCls} type="text" autoComplete="off" spellCheck={false}
              placeholder="qwen2.5-vl" value={local.model} onChange={(e) => updateLocalModel(i, { model: e.target.value })} />

            <label className={labelCls}>API key (optional)</label>
            <input className={inputCls} type="password" autoComplete="off" spellCheck={false}
              placeholder="local" value={local.apiKey} onChange={(e) => updateLocalModel(i, { apiKey: e.target.value })} />

            <label className="mt-2.5 flex items-center gap-2 text-[12px] text-ink">
              <input type="checkbox" checked={local.textOnly}
                onChange={(e) => updateLocalModel(i, { textOnly: e.target.checked })} />
              Text-only model (no image input)
            </label>
            <div className="mt-1 text-[11px] leading-snug text-faint">
              Check this for models without vision (e.g. GLM). Page images are skipped — it answers from the passage text alone.
            </div>
          </div>
        ))}

        <button
          className="mt-3 rounded-lg border border-border-strong bg-bg px-3 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2"
          onClick={addLocalModel}
        >Add local model</button>
        <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
          Most local servers ignore the key. Embeddings still use the OpenAI key.
        </div>

        <div className="mt-5 mb-1 border-t border-border-strong pt-4 text-[13px] font-semibold tracking-tight text-ink">
          AWS Bedrock
        </div>
        <div className="mb-1 text-[11.5px] leading-snug text-faint">
          Reach Claude, GLM &amp; GPT-5.5 through Bedrock's OpenAI-compatible gateway with one Bedrock API key.
          Generate a long-term API key in the Bedrock console. Embeddings still use the OpenAI key.
        </div>

        <label className={labelCls}>Bedrock API key</label>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false}
          placeholder="bedrock-…" value={bedrockApiKey} onChange={(e) => setBedrockApiKey(e.target.value)} />

        <label className={labelCls}>Region</label>
        <input className={inputCls} type="text" autoComplete="off" spellCheck={false}
          placeholder="us-east-1" value={bedrockRegion} onChange={(e) => setBedrockRegion(e.target.value)} />
        <div className="mt-1 text-[11.5px] leading-snug text-faint">
          Set a region where your chosen models are enabled (model access granted in the Bedrock console).
        </div>

        <div className="mt-5 mb-1 border-t border-border-strong pt-4 text-[13px] font-semibold tracking-tight text-ink">
          Privacy
        </div>
        <label className="mt-1 flex items-center gap-2 text-[12px] text-ink">
          <input type="checkbox" checked={analyticsEnabled}
            onChange={(e) => setAnalyticsEnabled(e.target.checked)} />
          Send anonymous usage data
        </label>
        <div className="mt-1 text-[11.5px] leading-snug text-faint">
          Helps improve the app. Counts only — never your documents, file names, questions, answers, or API keys.
        </div>

        <div className="mt-4 text-[12px] text-faint">Keys are stored encrypted on this machine. Data directory:</div>
        <div className="mt-0.5 break-all font-mono text-[11px] text-muted">{dataDir}</div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-border-strong bg-bg px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2"
            onClick={closeSettings}
          >Cancel</button>
          <button
            className="rounded-lg border border-tint bg-tint px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            onClick={save} disabled={saving}
          >Save</button>
        </div>
      </div>
    </div>
  );
}
