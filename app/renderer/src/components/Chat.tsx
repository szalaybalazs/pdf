import React, { useEffect, useRef, useState } from "react";
import { store, activeThread, send, setDebug, setModel } from "../store";
import { Assistant } from "./Assistant";

function Messages() {
  const t = activeThread();
  const endRef = useRef<HTMLDivElement>(null);

  useEffect(() => { endRef.current?.scrollIntoView({ block: "end" }); });

  if (!t || t.messages.length === 0) {
    return (
      <section className="flex-1 overflow-y-auto px-0 pb-[150px] pt-10">
        <div className="mx-auto mt-[20vh] flex flex-col items-center px-6">
          <div className="text-[26px] font-semibold tracking-tight text-ink">What can I help with?</div>
          <div className="mt-3 max-w-[440px] text-center text-[14px] leading-relaxed text-faint">
            Ask a question about your indexed PDFs. Figures in answers are underlined — click to open the page.
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="flex-1 overflow-y-auto px-0 pb-[150px] pt-10">
      {t.messages.map((m, i) =>
        m.kind === "user" ? (
          <div className="mx-auto mb-7 flex max-w-[760px] flex-col items-end px-7" key={i}>
            <div className="max-w-[82%] whitespace-pre-wrap rounded-[18px] border border-border bg-surface-2 px-4 py-2.5 text-[15px] leading-relaxed text-ink">{m.text}</div>
          </div>
        ) : (
          <Assistant m={m} key={m.reqId || i} />
        )
      )}
      <div ref={endRef} />
    </section>
  );
}

function Composer() {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = activeThread();
  const busy = !!t?.busy;
  const tok = store.tokens;

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  };
  useEffect(autosize, [value]);

  const submit = () => {
    const q = value.trim();
    if (!q || busy) return;
    send(q);
    setValue("");
  };

  return (
    <footer className="absolute bottom-0 left-0 right-0 flex flex-col items-center bg-[linear-gradient(0deg,var(--color-bg)_42%,transparent)] px-7 pb-4">
      <div className="flex w-full max-w-[760px] items-end gap-2.5 rounded-[22px] border border-border-strong bg-bg py-2 pl-[18px] pr-2 shadow-[0_1px_2px_rgba(20,20,18,0.04)] transition focus-within:border-tint focus-within:shadow-[0_8px_30px_rgba(20,20,18,0.10)] focus-within:ring-[3px] focus-within:ring-tint/15">
        <textarea
          ref={ref} rows={1} placeholder="Message pdf_qa…"
          className="max-h-[180px] flex-1 resize-none border-none bg-transparent py-2.5 text-[15px] leading-normal text-ink outline-none placeholder:text-faint"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
        />
        <button
          className="flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-full bg-ink text-white transition hover:opacity-85 active:scale-95 disabled:cursor-not-allowed disabled:opacity-25"
          onClick={submit} disabled={busy || !value.trim()} title="Send"
        >
          {busy ? (
            <span className="h-[15px] w-[15px] animate-spin rounded-full border-2 border-white/35 border-t-white" />
          ) : (
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>
            </svg>
          )}
        </button>
      </div>

      {/* controls under the input: model · debug · session tokens */}
      <div className="mt-2 flex w-full max-w-[760px] flex-wrap items-center gap-3">
        <select
          className="cursor-pointer rounded-md border border-border-strong bg-surface px-2.5 py-1 font-mono text-[12px] text-ink outline-none transition hover:border-muted focus:border-tint"
          title="Answer model" value={store.selectedModel} onChange={(e) => setModel(e.target.value)}
        >
          {store.models.map((m) => <option key={m.id} value={m.id}>{m.label}</option>)}
        </select>
        <label className="flex cursor-pointer select-none items-center gap-1.5 font-mono text-[12px] text-muted">
          <input type="checkbox" className="accent-tint" checked={store.debug} onChange={(e) => setDebug(e.target.checked)} /> debug
        </label>
        {tok.total > 0 && (
          <span className="ml-auto font-mono text-[11.5px] text-faint" title="Tokens used this session">
            {tok.total.toLocaleString()} tok ({tok.prompt.toLocaleString()} in / {tok.completion.toLocaleString()} out) · {tok.queries} q
          </span>
        )}
      </div>

      <div className="mt-2 text-center text-[12px] text-faint">pdf_qa can make mistakes. Consider verifying important information.</div>
    </footer>
  );
}

export function Chat() {
  return (
    <main className="relative flex min-w-0 flex-1 flex-col">
      <Messages />
      <Composer />
    </main>
  );
}
