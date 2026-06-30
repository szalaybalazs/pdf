import React, { useEffect, useMemo, useRef, useState } from "react";
import type { AssistantMsg, ToolEvent, Segment, Calc } from "../types";
import { store, activeThread, regenerate, threadOff } from "../store";
import { api } from "../trpc";
import { platformText, SEP, LEADING_SEP } from "../platform";
import {
  renderMarkdown, linkifyCitationsHtml, annotateCalcsHtml, renderMermaidBlocks,
  buildSegments,
} from "../markdown";

// Human-readable generation time: "3.4s" under a minute, "1m 05s" beyond.
function fmtDuration(seconds: number): string {
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = Math.round(seconds % 60);
  return `${m}m ${String(s).padStart(2, "0")}s`;
}

function fmtNumber(value?: number): string {
  return typeof value === "number" ? value.toLocaleString("en-US") : "0";
}

function TraceRow({ ev, pending }: { ev: ToolEvent; pending?: boolean }) {
  const dbg = store.debug ? ev.debug : [];
  return (
    <>
      <div className={"trace-row" + (pending ? " trace-pending" : "")}>
        <span className="bullet" aria-hidden="true" />{" "}
        <span className="name">{ev.name}</span>{" "}
        <span className="args">{ev.args}</span>
        {!pending && <span className="dur">  {ev.duration.toFixed(2)}s</span>}
      </div>
      {ev.detail.map((d, i) => <div className="trace-detail" key={"d" + i}>{d}</div>)}
      {dbg.map((d, i) => <div className="trace-detail debug" key={"g" + i}>{LEADING_SEP}{d}</div>)}
    </>
  );
}

const PENDING: ToolEvent = { type: "tool", name: "working", args: "", detail: [], debug: [], duration: 0 };

const TOOL_META: Record<string, { icon: string; label: string }> = {
  calculate: { icon: "C", label: "calculate" },
  search_documents: { icon: "S", label: "search" },
  get_pages: { icon: "P", label: "get pages" },
};

function CalcStatus({ calc }: { calc: Calc }) {
  const cls = !calc.ok ? "bg-danger" : calc.verified ? "bg-tint" : "bg-amber";
  const title = !calc.ok ? "error" : calc.verified ? "result appears in the answer" : "computed, but not written in the answer";
  return <span className={`inline-block size-1 rounded-full ${cls}`} title={title} />;
}

/** One entry in the inline calculation / retrieval timeline. */
function TimelineItem({ ev, calc }: { ev: ToolEvent; calc?: Calc }) {
  const meta = TOOL_META[ev.name] ?? { icon: "T", label: ev.name };
  const detail = ev.detail[0] || "";
  let status: React.ReactNode = null;
  if (ev.name === "calculate" && calc) {
    status = <CalcStatus calc={calc} />;
  }
  return (
    <div className="tl-item">
      <span className="tl-dot">{meta.icon}</span>
      <div className="tl-body">
        <span className="tl-label">{meta.label}</span>{" "}
        {ev.args && <code className="tl-args">{ev.args}</code>}{" "}
        {detail && <span className="tl-detail">{detail}</span>} {status}
      </div>
    </div>
  );
}

export function Assistant({ m }: { m: AssistantMsg }) {
  const contentRef = useRef<HTMLDivElement>(null);
  const [copied, setCopied] = useState(false);

  // NOTE: the store mutates `m.stream` in place during streaming (it appends to
  // the last array element or pushes), so its reference never changes. Memoizing
  // on `[m.stream]` alone would return stale segments for the whole stream. Key
  // the memo on values that DO change per delta: `m.raw` (reassigned to a new
  // string on each text delta) and `m.stream.length` (grows on each inline-tool
  // push). Without this, the answer only repaints when it finishes.
  const segments: Segment[] = useMemo(
    () => (m.stream && m.stream.length ? buildSegments(m.stream)
      : m.text ? [{ kind: "text", text: m.text }] : []),
    [m.stream, m.stream?.length, m.raw, m.text],
  );

  // look up a calculation by expression so timeline calc rows can show status.
  const calcByExpr = useMemo(() => {
    const map = new Map<string, Calc>();
    for (const c of m.calculations || []) if (!map.has(c.expression)) map.set(c.expression, c);
    return map;
  }, [m.calculations]);

  // render mermaid diagrams once the segment HTML is in the DOM
  useEffect(() => {
    if (contentRef.current) void renderMermaidBlocks(contentRef.current);
  }, [m.raw, m.done, segments.length]);

  const copyMarkdown = async () => {
    try {
      await navigator.clipboard.writeText(m.text || "");
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard unavailable */ }
  };
  const downloadPdf = () => {
    // Export the clean answer prose (not the thinking / timeline chrome).
    const html = annotateCalcsHtml(
      linkifyCitationsHtml(renderMarkdown(m.text || "", true), m.sources || []),
      m.calculations,
    );
    // Name the PDF after the thread; fall back to the answer's first line.
    const threadTitle = activeThread()?.title?.trim();
    const title = (threadTitle && threadTitle !== "New thread")
      ? threadTitle
      : (m.text || "answer").replace(/[#*`>\n]/g, " ").trim().slice(0, 50);
    void api.exportPdf(html, title);
  };

  // figure clicks (event delegation): open the page image in the OS viewer
  const onFigClick = (e: React.MouseEvent) => {
    const el = (e.target as HTMLElement).closest("[data-img]") as HTMLElement | null;
    const img = el?.getAttribute("data-img");
    if (img) void api.openFigure(img);
  };

  // annotate calc results across ALL text segments with a shared "used" set so
  // each [n] marker appears once across the whole message.
  const usedCalcs = new Set<number>();
  const renderText = (text: string) =>
    annotateCalcsHtml(
      linkifyCitationsHtml(renderMarkdown(text, m.done === true), m.sources || []),
      m.calculations, usedCalcs,
    );

  const hasBody = segments.length > 0;
  const lastIsText = segments.length > 0 && segments[segments.length - 1].kind === "text";

  return (
    <div className="mx-auto mb-7 max-w-[760px] px-7" onClick={onFigClick}>
      {/* pipeline trace (embed / search / collect / model) */}
      {(m.trace.length > 0 || (!m.done && !hasBody)) && (
        <div className="trace">
          {m.trace.length > 0
            ? m.trace.map((e, i) => <TraceRow ev={e} key={i} />)
            : <TraceRow ev={{ ...PENDING, name: "thinking" }} pending />}
          {m.trace.length > 0 && !m.done && !hasBody && <TraceRow ev={PENDING} pending />}
        </div>
      )}

      {m.error ? (
        <div className="err-text">{m.error}</div>
      ) : hasBody ? (
        <>
          <div ref={contentRef}>
            {segments.map((seg, i) => {
              if (seg.kind === "thinking") {
                return (
                  <details className="thinking" key={i} open={!!seg.streaming}>
                    <summary>Thinking</summary>
                    <div className="think-body">
                      {seg.text}{seg.streaming && <span className="cursor">▋</span>}
                    </div>
                  </details>
                );
              }
              if (seg.kind === "tool") {
                return <TimelineItem ev={seg.event} calc={calcByExpr.get(seg.event.args)} key={i} />;
              }
              return (
                <div className="answer" key={i}>
                  <div dangerouslySetInnerHTML={{ __html: renderText(seg.text) }} />
                </div>
              );
            })}
            {m.streaming && lastIsText && <span className="cursor">▋</span>}
          </div>

          {m.done && (
            <div className="msg-actions">
              <button className="msg-action" onClick={copyMarkdown} title="Copy as Markdown">
                {copied ? "Copied" : "Copy"}
              </button>
              <button className="msg-action" onClick={downloadPdf} title="Download as PDF">PDF</button>
              <button className="msg-action" onClick={() => regenerate(m.reqId)} title="Regenerate this answer">Regenerate</button>
              <button className="msg-action" onClick={() => threadOff(m.reqId)} title="Branch a new thread from here">Thread off</button>
            </div>
          )}

          {((m.usage && m.usage.total) || m.latency) && (
            <div className="usage">
              {m.usage && m.usage.total
                ? <>{fmtNumber(m.usage.prompt)} in + {fmtNumber(m.usage.completion)} out = {fmtNumber(m.usage.total)} tokens
                    {m.usage.reasoning ? `${SEP}${fmtNumber(m.usage.reasoning)} reasoning tokens` : ""}{SEP}</>
                : null}
              {m.latency ? `${fmtDuration(m.latency)}${SEP}` : ""}{platformText(m.model || store.visionModel)}
              {m.sessionId ? `${SEP}sid:${m.sessionId}` : ""}
            </div>
          )}
        </>
      ) : null}
    </div>
  );
}
