/** Serialize a whole chat thread to a self-contained Markdown document —
 *  questions, answers, the pages each answer cited, and the tool-verified
 *  calculations. Pure and dependency-free so it can be unit-tested and reused by
 *  both the copy and the file-export paths. */
import type { Thread, Msg, AssistantMsg, Source, Calc } from "./types";

function sourcesLine(sources?: Source[]): string {
  if (!sources || !sources.length) return "";
  const seen = new Set<string>();
  const parts: string[] = [];
  for (const s of sources) {
    const key = `${s.doc}|${s.page}`;
    if (seen.has(key)) continue;
    seen.add(key);
    parts.push(`${s.doc.replace(/\.pdf$/i, "")} p.${s.page}`);
  }
  return parts.length ? `**Sources:** ${parts.join("; ")}` : "";
}

function calcsBlock(calcs?: Calc[]): string {
  if (!calcs || !calcs.length) return "";
  const lines = calcs.map((c) =>
    c.ok && c.result ? `- \`${c.expression}\` = ${c.result}`
                     : `- \`${c.expression}\` — error: ${c.error || "failed"}`);
  return `**Calculations:**\n${lines.join("\n")}`;
}

function answerMeta(m: AssistantMsg): string {
  const bits: string[] = [];
  if (m.model) bits.push(m.model);
  if (m.confidence) bits.push(`confidence: ${m.confidence}`);
  if (typeof m.latency === "number") bits.push(`${m.latency.toFixed(1)}s`);
  return bits.length ? `_${bits.join(" · ")}_` : "";
}

/** Full-thread Markdown. Blocks are joined with blank lines and separated by
 *  horizontal rules between exchanges, so it reads as a clean transcript. */
export function threadToMarkdown(t: Thread): string {
  const out: string[] = [`# ${t.title || "Conversation"}`];
  if (t.createdAt) out.push(`_Exported from pdf_qa — ${new Date(t.createdAt).toISOString().slice(0, 10)}_`);

  const msgs: Msg[] = t.messages || [];
  for (const m of msgs) {
    if (m.kind === "user") {
      out.push("---", `## Question\n\n${m.text.trim()}`);
    } else {
      const a = m as AssistantMsg;
      const body = (a.text || a.error || "_(no answer)_").trim();
      const extra = [sourcesLine(a.sources), calcsBlock(a.calculations), answerMeta(a)]
        .filter(Boolean).join("\n\n");
      out.push(`### Answer\n\n${body}${extra ? "\n\n" + extra : ""}`);
    }
  }
  return out.join("\n\n") + "\n";
}

/** A filesystem-safe default filename (no extension) for a thread export. */
export function threadFilename(t: Thread): string {
  return (t.title || "conversation").replace(/[\/:*?"<>|]+/g, "_").slice(0, 60).trim() || "conversation";
}
