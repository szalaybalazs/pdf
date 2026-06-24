import React, { useEffect, useState } from "react";
import { store, closeSettings } from "../store";
import { api } from "../trpc";

const labelCls = "mb-1.5 mt-2.5 text-[12px] font-medium text-muted";
const inputCls = "w-full rounded-lg border border-border-strong bg-surface px-3 py-2.5 font-mono text-[13px] text-ink outline-none transition focus:border-tint focus:ring-[3px] focus:ring-tint/15";

export function Settings() {
  const [openai, setOpenai] = useState("");
  const [anthropic, setAnthropic] = useState("");
  const [openrouter, setOpenrouter] = useState("");
  const [dataDir, setDataDir] = useState("");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    api.getSettings().then((s) => {
      if (!alive) return;
      setOpenai(s.openaiKey || "");
      setAnthropic(s.anthropicKey || "");
      setOpenrouter(s.openrouterKey || "");
      setDataDir(s.dataDir || "");
    }).catch(() => { /* show empty form */ });
    return () => { alive = false; };
  }, []);

  const save = async () => {
    setSaving(true);
    try {
      await api.setSettings({
        openaiKey: openai.trim(), anthropicKey: anthropic.trim(), openrouterKey: openrouter.trim(),
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
      <div className="flex w-[460px] max-w-[calc(100vw-48px)] flex-col rounded-2xl border border-border-strong bg-bg p-6 shadow-[0_8px_30px_rgba(20,20,18,0.18)]">
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
