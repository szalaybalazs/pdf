import React, { useEffect } from "react";
import { store, closeViewer, viewerGoto } from "../store";

/** In-app page viewer: shows the cited page (with the passage highlighted when
 *  available) and lets you flip through pages without leaving the app. */
export function Viewer(): React.ReactElement | null {
  const v = store.viewer;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!store.viewer) return;
      if (e.key === "Escape") closeViewer();
      else if (e.key === "ArrowLeft") viewerGoto(-1);
      else if (e.key === "ArrowRight") viewerGoto(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  if (!v) return null;
  const title = `${v.doc.replace(/\.pdf$/i, "")} · p.${v.label}`;

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col items-center justify-center bg-black/70 p-6"
      onClick={closeViewer}
    >
      <div
        className="flex max-h-full w-full max-w-[900px] flex-col overflow-hidden rounded-lg border border-border bg-surface"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-border px-3 py-2">
          <span className="truncate text-[13px] text-muted" title={title}>{title}</span>
          <div className="flex items-center gap-1">
            <button className="msg-action" title="Previous page (←)" onClick={() => viewerGoto(-1)}>‹ Prev</button>
            <button className="msg-action" title="Next page (→)" onClick={() => viewerGoto(1)}>Next ›</button>
            <button className="msg-action" title="Close (Esc)" onClick={closeViewer}>Close</button>
          </div>
        </div>
        <div className="flex min-h-[200px] flex-1 items-center justify-center overflow-auto bg-bg p-3">
          {v.loading && !v.imageUrl
            ? <span className="text-[13px] text-faint">Loading page…</span>
            : v.imageUrl
              ? <img src={v.imageUrl} alt={title} className="max-h-full max-w-full object-contain"
                     style={{ opacity: v.loading ? 0.6 : 1 }} />
              : <span className="text-[13px] text-faint">Page unavailable.</span>}
        </div>
      </div>
    </div>
  );
}
