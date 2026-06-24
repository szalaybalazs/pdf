import React from "react";
import { store, activeThread } from "../store";
import { api } from "../trpc";
import type { AssistantMsg } from "../types";

function FileIcon() {
  return (
    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
      <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"></path>
      <path d="M14 2v6h6"></path>
    </svg>
  );
}

function CalcStatus({ ok, verified }: { ok: boolean; verified?: boolean }) {
  const cls = !ok ? "bg-danger" : verified ? "bg-tint" : "bg-amber";
  const title = !ok ? "error" : verified ? "shown in answer" : "computed, but not written";
  return <span className={`inline-block size-1 rounded-full ${cls}`} title={title} />;
}

/** Right sidebar: references (cited pages) and verified calculations for the most
 *  recent answer in the active thread. */
export function Inspector() {
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
    <aside className="flex w-[280px] min-w-[280px] flex-col overflow-y-auto border-l border-border bg-surface p-3">
      <div className="mb-2 text-[10.5px] font-semibold uppercase text-faint">Inspector</div>

      {empty && (
        <div className="mt-1 text-[12.5px] leading-relaxed text-faint">
          References and verified calculations from the latest answer appear here.
        </div>
      )}

      {sources.length > 0 && (
        <section className="mb-5">
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase text-faint">
            References · {sources.length}
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
        <section>
          <div className="mb-1.5 text-[10.5px] font-semibold uppercase text-faint">
            Verified calculations · {calcs.length}
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
            Green shown in answer · amber computed only · red error
          </div>
        </section>
      )}
    </aside>
  );
}
