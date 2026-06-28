import React, { useEffect, useState } from "react";
import { store, closeSettings } from "../store";
import { api } from "../trpc";

const labelCls = "mb-1.5 mt-2.5 text-[12px] font-medium text-muted";
const inputCls = "w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 font-mono text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15";
const textareaCls = "min-h-[120px] w-full resize-y rounded-lg border border-border-strong bg-surface px-3 py-2.5 text-[13px] leading-relaxed text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15";

export function Settings() {
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [systemPrompt, setSystemPrompt] = useState("");
  const [localBaseUrl, setLocalBaseUrl] = useState("");
  const [localApiKey, setLocalApiKey] = useState("");
  const [localModel, setLocalModel] = useState("");
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
      setLocalBaseUrl(s.localBaseUrl || "");
      setLocalApiKey(s.localApiKey || "");
      setLocalModel(s.localModel || "");
      setDataDir(s.dataDir || "");
    }).catch(() => { /* show empty form */ });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.setSettings({
        openaiKey: openai.trim(), anthropicKey: anthropic.trim(), openrouterKey: openrouter.trim(),
        systemPrompt: systemPrompt.trim(),
        localBaseUrl: localBaseUrl.trim(), localApiKey: localApiKey.trim(), localModel: localModel.trim(),
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
      className="fixed inset-0 z-[100] flex items-center justify-center bg-ink/30 backdrop-blur-[2px]"
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

        <label className={labelCls}>Base URL</label>
        <input className={inputCls} type="text" autoComplete="off" spellCheck={false}
          placeholder="http://localhost:11434/v1" value={localBaseUrl} onChange={(e) => setLocalBaseUrl(e.target.value)} />

        <label className={labelCls}>Model</label>
        <input className={inputCls} type="text" autoComplete="off" spellCheck={false}
          placeholder="qwen2.5-vl" value={localModel} onChange={(e) => setLocalModel(e.target.value)} />

        <label className={labelCls}>API key (optional)</label>
        <input className={inputCls} type="password" autoComplete="off" spellCheck={false}
          placeholder="local" value={localApiKey} onChange={(e) => setLocalApiKey(e.target.value)} />
        <div className="mt-1.5 text-[11.5px] leading-snug text-faint">
          Most local servers ignore the key. Embeddings still use the OpenAI key.
        </div>

        <div className="mt-4 text-[12px] text-faint">Keys are stored encrypted on this machine. Data directory:</div>
        <div className="mt-0.5 break-all font-mono text-[11px] text-muted">{dataDir}</div>

        <div className="mt-5 flex justify-end gap-2">
          <button
            className="rounded-lg border border-border-strong bg-bg px-4 py-2 text-[13px] font-medium text-ink transition hover:bg-surface-2"
            onClick={closeSettings}
          >Cancel</button>
          <button
            className="rounded-lg border border-ink bg-ink px-4 py-2 text-[13px] font-medium text-white transition hover:opacity-90 disabled:opacity-50"
            onClick={save} disabled={saving}
          >Save</button>
        </div>
      </div>
    </div>
  );
}
