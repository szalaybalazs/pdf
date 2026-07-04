/** Shared types: the backend protocol (mirrors pdf_qa/serve.py) and the
 *  renderer's in-memory chat model. */

// ---- backend protocol ------------------------------------------------------
export interface Source { doc: string; page: number; image: string; snippet?: string;
  page_label?: string;  // printed page ("106"/"xiv"); shown in citations, matched on click
}
export interface HighlightedEvent { type: "highlighted"; reqId?: string; path: string | null; }
export interface ToolEvent {
  type: "tool"; reqId?: string; name: string; args: string;
  detail: string[]; debug: string[]; duration: number;
}
export interface Usage { prompt?: number; completion?: number; total?: number; reasoning?: number; }
export interface Calc { expression: string; ok: boolean; result?: string; error?: string; verified?: boolean; }
export type Confidence = "low" | "medium" | "high";
export interface AnswerEvent {
  type: "answer"; reqId?: string; text: string; thinking?: string; sources: Source[];
  usage: Usage; calculations?: Calc[]; model?: string; latency?: number;  // seconds to generate
  confidence?: Confidence;  // retrieval confidence from top match similarity
  top_score?: number;       // best cosine similarity (0..1) behind `confidence`
}
export interface DeltaEvent { type: "delta"; reqId?: string; text: string; }
export interface ModelOption { id: string; label: string; provider?: string; model?: string; via_openrouter?: boolean; }
export interface ReadyEvent {
  type: "ready"; docs: string[]; chunks: number; vision_model: string; embed_model: string;
  models?: ModelOption[]; default_model?: string; collection?: string;
}
export interface Collection { name: string; docs: number; active: boolean; }
export interface CollectionsEvent { type: "collections"; collections: Collection[]; active: string; }
export interface BackendError { type: "error"; reqId?: string; message: string; }
export interface ThreadsEvent { type: "threads"; threads: Thread[]; }
export interface ThreadTitleEvent { type: "thread_title"; id: string; title: string; }
export interface ThreadResult { id: string; title: string; score: number; }
export interface ThreadResultsEvent { type: "thread_results"; q: string; results: ThreadResult[]; }
export type ServeEvent =
  | ToolEvent | AnswerEvent | ReadyEvent | BackendError | DeltaEvent
  | ThreadsEvent | ThreadTitleEvent | ThreadResultsEvent | HighlightedEvent
  | { type: string; reqId?: string };

// ---- in-memory chat model --------------------------------------------------
// The message body is an ORDERED stream of text deltas and in-answer tool calls
// (calculate / search_documents / get_pages), preserved as they arrived so the
// UI can show thinking blocks and the calculation timeline inline, in position.
export type StreamItem = string | ToolEvent;
export type Segment =
  | { kind: "text"; text: string }
  | { kind: "thinking"; text: string; streaming?: boolean }
  | { kind: "tool"; event: ToolEvent };

export interface AssistantMsg {
  kind: "assistant"; reqId: string; trace: ToolEvent[];
  stream?: StreamItem[];  // ordered text + in-answer tool calls (for inline render)
  raw?: string;          // accumulated streamed text (may contain <thinking>)
  thinking?: string;     // parsed reasoning (legacy; inline segments preferred)
  text?: string; sources?: Source[]; usage?: Usage; calculations?: Calc[];
  confidence?: Confidence;  // retrieval confidence (low/medium/high)
  topScore?: number;        // best cosine similarity behind `confidence`
  latency?: number;      // seconds the backend took to generate this reply
  model?: string;        // concrete answerer model that produced this reply
  sessionId?: string;    // backend session id that produced this reply (debugging)
  streaming?: boolean;   // currently receiving deltas
  error?: string; done: boolean;
}
export interface UserMsg { kind: "user"; text: string; }
export type Msg = UserMsg | AssistantMsg;

export interface Thread {
  id: string; title: string; messages: Msg[];
  history: { role: "user" | "assistant"; content: string }[];
  createdAt?: number;
  updatedAt?: number;
  disabledDocs?: string[];
  tempDocs?: string[];
  branchedFromThreadId?: string;
  branchedFromReqId?: string;
  busy: boolean;
}

// Renderer <-> main communication now goes through the typed tRPC client
// (renderer/src/trpc.ts), so there is no `window.api` bridge to declare here.
