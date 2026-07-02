/** Minimal, XSS-safe Markdown → HTML, plus KaTeX math, mermaid, and citation
 *  linking. Ported from the original vanilla renderer — escapes first, then
 *  formats, so untrusted model output can never inject markup. */
import type { Source, Calc, Segment, StreamItem } from "./types";

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}

/** Render a LaTeX string to HTML with KaTeX (best-effort; falls back to raw). */
function renderMath(latex: string, display: boolean): string {
  const katex = (window as any).katex;
  if (!katex) return `<code>${escapeHtml(latex)}</code>`;
  try {
    return katex.renderToString(latex, { displayMode: display, throwOnError: false, output: "html" });
  } catch {
    return `<code>${escapeHtml(latex)}</code>`;
  }
}

/** Inline formatting (code/bold/italic). Expects already HTML-escaped input. */
function inlineFormat(s: string): string {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*/g, "$1<em>$2</em>")
    .replace(/(^|[^_])_([^_\n]+)_/g, "$1<em>$2</em>");
}

/** A GitHub table delimiter row, e.g. "| --- | :--: |" (escaped form is identical). */
function isTableDelimiter(line: string): boolean {
  const t = line.trim();
  return t.includes("-") && /^\|?\s*:?-+:?\s*(\|\s*:?-+:?\s*)*\|?$/.test(t);
}

/** Split a table row into trimmed cells, tolerating optional outer pipes. */
function splitTableCells(line: string): string[] {
  return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
}

/** Render a parsed GitHub table (cells are already HTML-escaped lines). */
function renderTable(header: string[], rows: string[][]): string {
  const th = header.map((h) => `<th>${inlineFormat(h)}</th>`).join("");
  const body = rows.map((r) => {
    const cells = header.map((_h, i) => `<td>${inlineFormat(r[i] ?? "")}</td>`).join("");
    return `<tr>${cells}</tr>`;
  }).join("");
  return `<table><thead><tr>${th}</tr></thead><tbody>${body}</tbody></table>`;
}

export function renderMarkdown(src: string, allowMermaid = false): string {
  const codeBlocks: string[] = [];
  const mermaidBlocks: string[] = [];
  const mathBlocks: string[] = [];
  // pull out math first (before escaping/formatting) so LaTeX is untouched.
  src = src
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), true)); return `@@MATH${mathBlocks.length - 1}@@`; })
    .replace(/\$\$([\s\S]+?)\$\$/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), true)); return `@@MATH${mathBlocks.length - 1}@@`; })
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), false)); return `@@MATH${mathBlocks.length - 1}@@`; })
    .replace(/\$([^$\n]+?)\$/g, (_m, x) => { mathBlocks.push(renderMath(x.trim(), false)); return `@@MATH${mathBlocks.length - 1}@@`; });
  // pull out fenced blocks first so their contents aren't reformatted
  let text = src.replace(/```(\w*)\n?([\s\S]*?)```/g, (_m, lang, body) => {
    const code = body.replace(/\n$/, "");
    if (allowMermaid && lang === "mermaid") {
      mermaidBlocks.push(escapeHtml(code));
      return `@@MERMAID${mermaidBlocks.length - 1}@@`;
    }
    codeBlocks.push(escapeHtml(code));
    return `@@CODE${codeBlocks.length - 1}@@`;
  });
  text = escapeHtml(text);

  const lines = text.split("\n");
  const out: string[] = [];
  let listType: "ul" | "ol" | null = null;
  const closeList = () => { if (listType) { out.push(`</${listType}>`); listType = null; } };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trimEnd();
    let m: RegExpMatchArray | null;
    // GitHub table: a header row immediately followed by a delimiter row.
    if (line.includes("|") && li + 1 < lines.length && isTableDelimiter(lines[li + 1])) {
      closeList();
      const header = splitTableCells(line);
      const rows: string[][] = [];
      li += 2;                                   // consume header + delimiter
      while (li < lines.length && lines[li].trim() !== "" && lines[li].includes("|")) {
        rows.push(splitTableCells(lines[li]));
        li++;
      }
      li--;                                       // the for-loop will re-increment
      out.push(renderTable(header, rows));
    } else if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      closeList();
      const lvl = m[1].length;
      out.push(`<h${lvl}>${inlineFormat(m[2])}</h${lvl}>`);
    } else if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
      // horizontal rule (--- / *** / ___). Checked before the list branch so a
      // bare "---" isn't mistaken for a bullet; the table branch above only fires
      // on a delimiter that follows a header row with pipes, so it won't catch this.
      closeList();
      out.push("<hr>");
    } else if ((m = line.match(/^\s*[-*+]\s+(.*)$/))) {
      if (listType !== "ul") { closeList(); out.push("<ul>"); listType = "ul"; }
      out.push(`<li>${inlineFormat(m[1])}</li>`);
    } else if ((m = line.match(/^\s*\d+\.\s+(.*)$/))) {
      if (listType !== "ol") { closeList(); out.push("<ol>"); listType = "ol"; }
      out.push(`<li>${inlineFormat(m[1])}</li>`);
    } else if ((m = line.match(/^\s*>\s?(.*)$/))) {
      closeList();
      out.push(`<blockquote>${inlineFormat(m[1])}</blockquote>`);
    } else if (line.trim() === "") {
      closeList();
      out.push("");
    } else {
      closeList();
      out.push(`<p>${inlineFormat(line)}</p>`);
    }
  }
  closeList();

  let html = out.join("\n");
  html = html.replace(/@@CODE(\d+)@@/g, (_m, i) => `<pre><code>${codeBlocks[+i]}</code></pre>`);
  html = html.replace(/@@MERMAID(\d+)@@/g, (_m, i) =>
    `<div class="mermaid-pending" data-code="${mermaidBlocks[+i]}"></div>`);
  html = html.replace(/@@MATH(\d+)@@/g, (_m, i) => mathBlocks[+i]);
  return html;
}

// mermaid is a ~3 MB dependency that's only needed when an answer actually
// contains a diagram. Loading it up front adds seconds to startup (download +
// parse before the first paint), so we inject its vendor bundle lazily the
// first time a mermaid block needs rendering, caching the load promise.
let mermaidLoad: Promise<any> | null = null;
function loadMermaid(): Promise<any> {
  if (mermaidLoad) return mermaidLoad;
  mermaidLoad = new Promise<any>((resolve, reject) => {
    if ((window as any).mermaid) return resolve((window as any).mermaid);
    const s = document.createElement("script");
    s.src = "./vendor/mermaid.min.js";
    s.onload = () => {
      const mermaid = (window as any).mermaid;
      if (mermaid) mermaid.initialize({ startOnLoad: false, theme: "neutral", securityLevel: "strict" });
      resolve(mermaid);
    };
    s.onerror = () => reject(new Error("failed to load mermaid"));
    document.head.appendChild(s);
  }).catch(() => null);
  return mermaidLoad;
}

/** After messages are in the DOM, turn pending mermaid blocks into rendered SVG. */
let mermaidSeq = 0;
export async function renderMermaidBlocks(root: HTMLElement): Promise<void> {
  const nodes = Array.from(root.querySelectorAll(".mermaid-pending")) as HTMLElement[];
  if (nodes.length === 0) return;
  const mermaid = await loadMermaid();
  for (const node of nodes) {
    const code = node.getAttribute("data-code") || "";
    node.removeAttribute("data-code");
    node.classList.remove("mermaid-pending");
    if (!mermaid) { node.innerHTML = `<pre><code>${escapeHtml(code)}</code></pre>`; continue; }
    try {
      const { svg } = await mermaid.render("mmd" + mermaidSeq++, code);
      node.innerHTML = svg;
      node.classList.add("mermaid-rendered");
    } catch {
      node.innerHTML = `<pre class="mermaid-err"><code>${escapeHtml(code)}</code></pre>`;
    }
  }
}

/** Remove inline tool-call markup some models emit as text instead of via the
 *  API, e.g. "<tool_call>{"expression":"6.36-6.3"}</tool_call>". These are never
 *  user-facing; the backend separately parses/executes them. Also drops a
 *  trailing unclosed <tool_call> while streaming so it never flashes mid-answer. */
export function stripToolCalls(text: string): string {
  return text
    .replace(/<tool_call>[\s\S]*?<\/tool_call>/g, "")
    .replace(/<tool_call>[\s\S]*$/, "")
    .replace(/\n{3,}/g, "\n\n");
}

/** Parse a run of streamed text into ordered text / thinking segments, in place.
 *  Inline <tool_call> markup is stripped from text. A trailing unclosed
 *  <thinking> (mid-stream) becomes an open, still-streaming thinking segment. */
function parseThinkingParts(text: string): Segment[] {
  const segs: Segment[] = [];
  const pushText = (s: string) => {
    const cleaned = stripToolCalls(s);
    if (cleaned.trim()) segs.push({ kind: "text", text: cleaned });
  };
  let i = 0;
  while (i < text.length) {
    const open = text.indexOf("<thinking>", i);
    if (open === -1) { pushText(text.slice(i)); break; }
    pushText(text.slice(i, open));
    const close = text.indexOf("</thinking>", open + 10);
    if (close === -1) {
      const t = text.slice(open + 10);
      if (t.trim()) segs.push({ kind: "thinking", text: t.trim(), streaming: true });
      break;
    }
    const t = text.slice(open + 10, close);
    if (t.trim()) segs.push({ kind: "thinking", text: t.trim() });
    i = close + 11;
  }
  return segs;
}

/** Build the ordered render segments for a message body from its raw stream
 *  (text deltas interleaved with in-answer tool calls). Thinking blocks and the
 *  tool-call timeline therefore appear inline, in the position they occurred. */
export function buildSegments(stream: StreamItem[] | undefined): Segment[] {
  if (!stream || !stream.length) return [];
  const segs: Segment[] = [];
  let buf = "";
  const flush = () => { if (buf) { segs.push(...parseThinkingParts(buf)); buf = ""; } };
  for (const item of stream) {
    if (typeof item === "string") buf += item;
    else { flush(); segs.push({ kind: "tool", event: item }); }
  }
  flush();
  return segs;
}

/** Split text into [thinking, answer]. Removes EVERY <thinking>...</thinking>
 *  block wherever it appears (start/middle/end, multiple), strips inline
 *  <tool_call> markup, and treats a trailing unclosed <thinking> (mid-stream) as
 *  thinking so neither ever leaks into the answer. */
export function splitThinking(text: string): [string, string] {
  const parts: string[] = [];
  let answer = text.replace(/<thinking>([\s\S]*?)<\/thinking>/g, (_m, t) => { parts.push(t); return " "; });
  const open = answer.match(/<thinking>([\s\S]*)$/);
  if (open) { parts.push(open[1]); answer = answer.slice(0, open.index); }
  const thinking = parts.map((p) => p.trim()).filter(Boolean).join("\n\n").trim();
  return [thinking, stripToolCalls(answer).trim()];
}

/** Turn "(Doc... p.12)" citations into clickable links to the page image. */
export function linkifyCitationsHtml(html: string, sources: Source[]): string {
  return html.replace(/\(([^()]*?p\.?\s?(\d+))\)/g, (whole, _inner, pageStr) => {
    const page = parseInt(pageStr, 10);
    const src = sources.find((s) => s.page === page);
    if (!src) return whole;
    return `<a class="fig" data-img="${escapeHtml(src.image)}">${whole}</a>`;
  });
}

/** Highlight each tool-computed result where it appears in the answer, tagging it
 *  with the calculation's index [n] (matching the calculations panel) and a
 *  tooltip of the expression. This ties every number in the prose back to the
 *  exact calculation that produced it. Operates on text nodes only (never inside
 *  tags), wrapping the first occurrence of each result once. */
export function annotateCalcsHtml(html: string, calcs?: Calc[], used: Set<number> = new Set()): string {
  if (!calcs || !calcs.length) return html;
  const segments = html.split(/(<[^>]+>)/);   // odd indices are tags
  for (let s = 0; s < segments.length; s++) {
    if (segments[s].startsWith("<")) continue;
    calcs.forEach((c, i) => {
      if (used.has(i) || !c.ok || !c.result) return;
      const needle = c.result;
      const at = segments[s].indexOf(needle);
      if (at === -1) return;
      used.add(i);
      const cls = c.verified ? "calc-mark verified" : "calc-mark unverified";
      const title = escapeHtml(`[${i + 1}] ${c.expression} = ${c.result}`);
      const mark = `<span class="${cls}" title="${title}">${escapeHtml(needle)}` +
        `<sup class="calc-idx">${i + 1}</sup></span>`;
      segments[s] = segments[s].slice(0, at) + mark + segments[s].slice(at + needle.length);
    });
  }
  return segments.join("");
}
