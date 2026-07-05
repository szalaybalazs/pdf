import React from "react";
import { store, activeThread, libraryLabel } from "../store";
import { api } from "../trpc";
import type { AssistantMsg } from "../types";
import { SEP } from "../platform";

function XIcon() {
  return (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round">
      <path d="M18 6 6 18"></path>
      <path d="m6 6 12 12"></path>
    </svg>
  );
}

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M14 2v6h6"></path>
    </svg>
  );
}

function CardRow({ label, value }: { label: string; value?: string }) {
  return (
    <div className="flex items-center gap-2 rounded-lg px-1 py-1.5 text-[13.5px] text-ink">
      <span className="flex h-[18px] w-[18px] items-center justify-center text-muted"><FileIcon /></span>
      <span>{label}</span>
      {value && <span className="ml-auto text-[12px] text-faint">{value}</span>}
    </div>
  );
}

function CalcStatus({ ok, verified }: { ok: boolean; verified?: boolean }) {
  const cls = !ok ? "bg-danger" : verified ? "bg-tint" : "bg-amber";
  const title = !ok ? "error" : verified ? "shown in answer" : "computed, but not written";
  return <span className={`inline-block size-1 rounded-full ${cls}`} title={title} />;
}

/** Right sidebar: references (cited pages) and verified calculations for the most
 *  recent answer in the active thread. */
export function Inspector({ onClose }: { onClose: () => void }) {
  const t = activeThread();
  // latest assistant message that produced an answer
  let latest: AssistantMsg | undefined;
  for (const m of t?.messages ?? []) {
    if (m.kind === "assistant" && (m.text || m.calculations?.length || m.sources?.length)) {
      latest = m as AssistantMsg;
    }
  }
  const sources = latest?.sources ?? [];
  const calcs = latest?.calculations ?? [];
  const empty = sources.length === 0 && calcs.length === 0;

  return (
    <aside className="absolute right-5 top-4 z-20 max-h-[calc(100vh-120px)] w-[300px] overflow-y-auto rounded-[18px] border border-border bg-bg/95 p-4 shadow-[0_12px_36px_rgba(20,20,18,0.14)] backdrop-blur-[2px]">
        <div className="mb-3 flex items-center justify-between">
          <div className="text-[14px] font-medium text-faint">Environment</div>
          <button
            className="flex h-[28px] w-[28px] items-center justify-center rounded-md text-faint transition hover:bg-surface-2 hover:text-muted"
            title="Close environment"
            aria-label="Close environment"
            onClick={onClose}
          >
            <XIcon />
          </button>
        </div>

          <div className="mb-4">
            <CardRow
              label="Library"
              value={libraryLabel(store.activeCollection)
                + (store.collections.find((c) => c.name === store.activeCollection)?.remote ? " · remote" : "")}
            />
            <CardRow label="Documents" value={String(store.docs.length)} />
            <CardRow label="References" value={String(sources.length)} />
            <CardRow label="Calculations" value={String(calcs.length)} />
          </div>

        {empty && (
          <div className="border-t border-border pt-4">
            <div className="mb-3 text-[14px] text-faint">Sources</div>
            <div className="text-[13.5px] leading-relaxed text-faint">No sources yet</div>
          </div>
        )}

        {sources.length > 0 && (
          <section className="mb-5 border-t border-border pt-4">
            <div className="mb-1.5 text-[14px] text-faint">
              References{SEP}{sources.length}
            </div>
            <ul className="flex flex-col gap-1">
              {sources.map((s, i) => (
                <li
                  key={i}
                  className="flex cursor-pointer items-start gap-2 rounded-md border border-border bg-bg px-2 py-1.5 text-[12px] text-ink transition hover:border-tint hover:bg-tint-soft"
                  title="Open this page"
                  onClick={() => void api.openFigure(s.image)}
                >
                  <span className="mt-0.5 shrink-0 text-faint"><FileIcon /></span>
                  <span className="min-w-0">
                    <span className="block overflow-hidden text-ellipsis whitespace-nowrap">{s.doc}</span>
                    <span className="text-faint">p.{s.page}</span>
                  </span>
                </li>
              ))}
            </ul>
          </section>
        )}

        {calcs.length > 0 && (
          <section className="border-t border-border pt-4">
            <div className="mb-1.5 text-[14px] text-faint">
              Verified calculations{SEP}{calcs.length}
            </div>
            <ul className="flex flex-col gap-1">
              {calcs.map((c, i) => {
                return (
                  <li key={i} className="rounded-md border border-border bg-bg px-2 py-1.5">
                    <div className="mb-0.5 flex items-center gap-1.5 text-[11px] text-faint">
                      <span className="font-mono">[{i + 1}]</span>
                      <CalcStatus ok={c.ok} verified={c.verified} />
                    </div>
                    <div className="break-words font-mono text-[12px] text-ink">
                      <code className="rounded bg-surface-2 px-1">{c.expression}</code>
                      {" = "}
                      <b>{c.ok ? (c.result || "") : (c.error || "error")}</b>
                    </div>
                  </li>
                );
              })}
            </ul>
            <div className="mt-2 text-[10.5px] leading-snug text-faint">
              Green shown in answer{SEP}amber computed only{SEP}red error
            </div>
          </section>
        )}
    </aside>
  );
}
