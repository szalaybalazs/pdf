import React, { useEffect, useLayoutEffect, useRef, useState } from "react";
import {
  store, activeThread, send, showModelMenu, enabledDocs,
  addTempPdfsToThread, threadDocs, libraryLabel,
} from "../store";
import { Assistant } from "./Assistant";
import { APP_NAME } from "../../../src/branding";
import { platformText, SEP } from "../platform";

function Messages() {
  const t = activeThread();
  const scrollerRef = useRef<HTMLElement>(null);
  const stickToBottom = useRef(true);
  const lastThreadId = useRef<string | undefined>();
  const scrollRaf = useRef<number | null>(null);

  const scrollToBottom = () => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTop = el.scrollHeight - el.clientHeight;
  };

  const scrollToBottomSoon = () => {
    if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
    scrollRaf.current = requestAnimationFrame(() => {
      scrollRaf.current = null;
      scrollToBottom();
    });
  };

  const scrollKey = (() => {
    if (!t) return "";
    const last = t.messages[t.messages.length - 1];
    if (!last) return t.id;
    if (last.kind === "user") return `${t.id}:${t.messages.length}:user:${last.text.length}`;
    const streamSize = (last.stream || []).reduce(
      (n, item) => n + (typeof item === "string" ? item.length : `${item.name}:${item.args}`.length),
      0,
    );
    return [
      t.id, t.messages.length, "assistant", streamSize, last.raw?.length || 0,
      last.text?.length || 0, last.trace.length, last.done, last.error || "",
    ].join(":");
  })();

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const threadChanged = lastThreadId.current !== t?.id;
    lastThreadId.current = t?.id;
    if (threadChanged || stickToBottom.current) {
      scrollToBottom();
      scrollToBottomSoon();
    }
  }, [scrollKey, t?.id]);

  useLayoutEffect(() => {
    const el = scrollerRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => {
      if (stickToBottom.current) scrollToBottomSoon();
    });
    observer.observe(el);
    for (const child of Array.from(el.children)) observer.observe(child);

    return () => {
      observer.disconnect();
      if (scrollRaf.current !== null) cancelAnimationFrame(scrollRaf.current);
    };
  }, [scrollKey]);

  const onScroll = () => {
    const el = scrollerRef.current;
    if (!el) return;
    stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
  };

  const scrollerStyle = {
    overflowAnchor: "none",
  } as React.CSSProperties;

  if (!t || t.messages.length === 0) {
    return (
      <section ref={scrollerRef} onScroll={onScroll} style={scrollerStyle} className="min-h-0 flex-1 overflow-y-auto px-0 py-8">
      </section>
    );
  }

  return (
    <section ref={scrollerRef} onScroll={onScroll} style={scrollerStyle} className="min-h-0 flex-1 overflow-y-auto px-0 py-8">
      {(() => {
        // Insert a subtle divider whenever the library OR the answering model
        // changes mid-thread, so a shift in the model's context is impossible to
        // miss. Library is keyed off m.library (present on both message kinds, so
        // it lands before the new-library question); model off the assistant's
        // actual m.model (so it lands before the answer that used it). The first
        // of each doesn't get a divider.
        let prevLib: string | undefined;
        let prevModel: string | undefined;
        const divider = (text: string, key: string) => (
          <div className="mx-auto my-4 flex max-w-[920px] items-center gap-3 px-8 text-[11.5px] text-faint" key={key}>
            <div className="h-px flex-1 bg-border" />
            <span className="whitespace-nowrap">{text}</span>
            <div className="h-px flex-1 bg-border" />
          </div>
        );
        return t.messages.map((m, i) => {
          const dividers: React.ReactNode[] = [];
          const lib = m.library;
          if (lib && prevLib !== undefined && lib !== prevLib) {
            dividers.push(divider(`switched to ${libraryLabel(lib)}`, `libdiv-${i}`));
          }
          if (lib !== undefined) prevLib = lib;
          if (m.kind === "assistant" && m.model) {
            if (prevModel !== undefined && m.model !== prevModel) {
              dividers.push(divider(`switched to ${platformText(m.model)}`, `moddiv-${i}`));
            }
            prevModel = m.model;
          }
          const body = m.kind === "user" ? (
            <div className="mx-auto mb-6 flex max-w-[920px] flex-col items-end px-8" key={i}>
              <div className="max-w-[82%] whitespace-pre-wrap rounded-[20px] bg-surface-2 px-4 py-2.5 text-[15px] leading-relaxed text-ink shadow-[0_1px_1px_rgba(20,20,18,0.03)]">{m.text}</div>
            </div>
          ) : (
            <Assistant m={m} key={m.reqId || i} />
          );
          return dividers.length ? <React.Fragment key={`f-${i}`}>{dividers}{body}</React.Fragment> : body;
        });
      })()}
    </section>
  );
}

function Composer({ centered = false }: { centered?: boolean }) {
  const [value, setValue] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  const t = activeThread();
  const busy = !!t?.busy;
  const tok = store.tokens;
  const enabledDocCount = enabledDocs(t).length;
  const docCount = threadDocs(t).length;
  const noDocsEnabled = docCount > 0 && enabledDocCount === 0;
  const selectedModel = store.models.find((m) => m.id === store.selectedModel);
  const selectedModelLabel = selectedModel ? platformText(selectedModel.label) : "";

  const autosize = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 180) + "px";
  };
  useEffect(autosize, [value]);

  const submit = () => {
    const q = value.trim();
    if (!q || busy || noDocsEnabled) return;
    send(q);
    setValue("");
  };

  return (
    <footer className={centered ? "w-full px-6" : "shrink-0 bg-bg px-7 pb-5 pt-2"}>
      <div className="flex flex-col items-center">
        <div className="composer-shell flex min-h-[96px] w-full max-w-[920px] flex-col rounded-[24px] border px-4.5 pb-2.5 pt-3.5 transition focus-within:border-border-strong">
          <div className="flex flex-1 items-start">
            <textarea
              ref={ref} rows={1} placeholder="Ask anything"
              className="max-h-[160px] min-h-[42px] flex-1 resize-none border-none bg-transparent py-0 text-[15px] leading-normal text-ink outline-none placeholder:text-faint"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); submit(); } }}
              disabled={noDocsEnabled}
            />
          </div>

          <div className="mt-2 flex min-h-[30px] flex-wrap items-center gap-3">
            <button
              className="max-w-full cursor-pointer truncate px-0 py-0.5 text-left font-mono text-[12px] text-muted outline-none transition hover:text-ink focus:text-ink disabled:cursor-default disabled:opacity-60"
              title="Answer model"
              disabled={!store.models.length}
              onClick={() => { void showModelMenu(); }}
            >
              {selectedModelLabel || "Model"}
            </button>
            <span className="flex-1" />
            {tok.total > 0 && (
              <span className="font-mono text-[11px] text-faint" title="Tokens used this session">
                {tok.total.toLocaleString()} tok ({tok.prompt.toLocaleString()} in / {tok.completion.toLocaleString()} out){SEP}{tok.queries} q
              </span>
            )}
            {docCount > 0 && (
              <span className={`font-mono text-[11px] ${noDocsEnabled ? "text-danger" : "text-faint"}`} title="Documents searched by this chat">
                {enabledDocCount}/{docCount} docs
              </span>
            )}
            <button
              className="ml-1 flex h-[32px] w-[32px] shrink-0 items-center justify-center rounded-full bg-muted text-bg transition hover:opacity-85 active:scale-95 disabled:cursor-not-allowed disabled:bg-surface disabled:text-faint"
              onClick={submit} disabled={busy || noDocsEnabled || !value.trim()} title={noDocsEnabled ? "Enable at least one document" : "Send"}
            >
              {busy ? (
                <span className="h-[15px] w-[15px] animate-spin rounded-full border-2 border-white/35 border-t-white" />
              ) : (
                <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <line x1="12" y1="19" x2="12" y2="5"></line><polyline points="5 12 12 5 19 12"></polyline>
                </svg>
              )}
            </button>
          </div>
        </div>
      </div>
    </footer>
  );
}

export function Chat() {
  const [dragging, setDragging] = useState(false);
  const dragDepth = useRef(0);
  const t = activeThread();
  const empty = !t || t.messages.length === 0;

  const filesFromDrop = (dt: DataTransfer): string[] => {
    const paths: string[] = [];
    for (const file of Array.from(dt.files || [])) {
      const p = window.pdfQaFiles?.pathForFile(file);
      if (p && /\.pdf$/i.test(p)) paths.push(p);
    }
    return paths;
  };

  return (
    <main
      className="main-chrome relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden"
      onDragEnter={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        dragDepth.current += 1;
        setDragging(true);
      }}
      onDragOver={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = "copy";
      }}
      onDragLeave={(e) => {
        if (!Array.from(e.dataTransfer.types).includes("Files")) return;
        e.preventDefault();
        dragDepth.current = Math.max(0, dragDepth.current - 1);
        if (dragDepth.current === 0) setDragging(false);
      }}
      onDrop={(e) => {
        e.preventDefault();
        dragDepth.current = 0;
        setDragging(false);
        void addTempPdfsToThread(filesFromDrop(e.dataTransfer));
      }}
    >
      {empty ? (
        <div className="flex min-h-0 flex-1 flex-col items-center justify-center pb-[13vh]">
          <div className="mb-7 px-6 text-center text-[24px] font-medium text-ink">
            What would you like to know?
          </div>
          <Composer centered />
        </div>
      ) : (
        <>
          <Messages />
          <Composer />
        </>
      )}
      {dragging && (
        <div className="pointer-events-none absolute inset-3 z-30 flex items-center justify-center rounded-lg border border-dashed border-tint bg-tint-soft/80 text-[14px] font-medium text-tint-strong shadow-[0_12px_36px_rgba(20,20,18,0.10)]">
          Drop PDFs to search in this chat
        </div>
      )}
    </main>
  );
}
