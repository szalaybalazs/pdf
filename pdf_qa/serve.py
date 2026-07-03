"""JSON-over-stdio backend for the Electron app.

Reads one JSON request per line on stdin and writes one JSON event per line on
stdout (each flushed immediately so the UI can show the tool-call trace live).
It reuses the exact same retrieval + multimodal pipeline as the CLI.

Requests (stdin):
    {"type":"query","reqId":"abc","question":"...","history":[...],"debug":true}
    {"type":"info"}            -> emits a single "ready" event with index stats
    {"type":"ping"}            -> emits {"type":"pong"}

Events (stdout):
    {"type":"ready","docs":[...],"chunks":N,"vision_model":"gpt-4o"}
    {"type":"tool","reqId","name","args","detail":[...],"debug":[...],"duration":s}
    {"type":"answer","reqId","text","sources":[{doc,page,image}],"usage":{...},"latency":s}
    {"type":"error","reqId","message"}

`history` items are {"role":"user"|"assistant","content":"..."} text turns, owned
by the UI (one list per thread), so the backend stays stateless across threads.

Concurrency: each `query` runs on its own daemon worker thread, so multiple chat
threads can stream answers in parallel. Requests are stateless and request-local
state (sources, dedup sets) lives in closures per call. Only two things are
genuinely shared — stdout and TEMP_STORES — and both are guarded by locks below.
"""
from __future__ import annotations

import json
import os
import sys
import threading
import time
from pathlib import Path

from . import config
from .errors import capture_exception, init_error_reporting
from .store import VectorStore
from .threads import ThreadStore


# A stable id for this backend process, stamped onto every emitted event so a
# message can be traced through the logs end-to-end.
SESSION_ID = ""
TEMP_STORES: dict[str, list[VectorStore]] = {}

# stdout is written from many query threads at once; serialize whole lines so
# events never interleave. TEMP_STORES is read by queries and mutated by the
# temp-index handlers, so guard those accesses too.
_emit_lock = threading.Lock()
_stores_lock = threading.Lock()


def emit(obj: dict) -> None:
    if SESSION_ID and "session_id" not in obj:
        obj = {"session_id": SESSION_ID, **obj}
    line = json.dumps(obj, ensure_ascii=False) + "\n"
    with _emit_lock:
        sys.stdout.write(line)
        sys.stdout.flush()


def _index_stats(store: VectorStore | None) -> dict:
    docs = sorted({c.doc for c in store.chunks}) if store else []
    models = [{"id": mid, "label": spec["label"], "provider": spec["provider"],
               "model": spec["model"],
               "via_openrouter": bool(config.USE_OPENROUTER and spec.get("openrouter") and not spec.get("direct"))}
              for mid, spec in config.MODELS.items()]
    return {"docs": docs, "chunks": len(store) if store else 0,
            "vision_model": config.VISION_MODEL, "embed_model": config.EMBED_MODEL,
            "models": models, "default_model": config.DEFAULT_MODEL}


def _thread_stores(store: VectorStore | None, req: dict) -> list[VectorStore]:
    tid = req.get("threadId")
    stores = [store] if store is not None else []
    if tid:
        with _stores_lock:
            stores.extend(TEMP_STORES.get(tid, []))
    return stores


def _docs_in(stores: list[VectorStore]) -> list[str]:
    return sorted({c.doc for s in stores for c in s.chunks})


def _search_stores(stores: list[VectorStore], qvec, top_k: int,
                   docs: list[str] | None = None):
    hits = []
    for s in stores:
        hits.extend(s.search(qvec, top_k, docs=docs))
    return sorted(hits, key=lambda h: h[1], reverse=True)[:top_k]


def _rrf_fuse(rankings: list[list], pool_k: int) -> list:
    """Reciprocal Rank Fusion of several [(Chunk, score)] rankings into one.
    Each ranking contributes 1/(RRF_K + rank) to a chunk's fused score, so a
    chunk ranked highly by EITHER retriever floats up without either score scale
    needing to be calibrated against the other. Chunks are keyed by their stable
    `id`. Returns [(Chunk, fused_score)] best-first, truncated to pool_k."""
    fused: dict[str, float] = {}
    by_id: dict[str, object] = {}
    for ranking in rankings:
        for rank, (c, _s) in enumerate(ranking):
            fused[c.id] = fused.get(c.id, 0.0) + 1.0 / (config.RRF_K + rank + 1)
            by_id.setdefault(c.id, c)
    order = sorted(by_id.values(), key=lambda c: fused[c.id], reverse=True)
    return [(c, fused[c.id]) for c in order][:pool_k]


def _retrieve_pool(stores: list[VectorStore], question: str, qvec, pool_k: int,
                   doc_filter: list[str] | None) -> tuple[list, list, int]:
    """Retrieve a candidate pool of up to pool_k passages. Returns
    (pool, dense, n_sparse): `pool` is the hybrid-fused ranking (or the dense one
    when hybrid search is off), `dense` is the raw cosine ranking (kept so the
    caller can read the top cosine similarity as a confidence signal), and
    `n_sparse` is how many lexical hits contributed."""
    dense = _search_stores(stores, qvec, pool_k, docs=doc_filter)
    if not config.HYBRID_SEARCH:
        return dense, dense, 0
    sparse: list = []
    for s in stores:
        sparse.extend(s.bm25_search(question, pool_k, docs=doc_filter))
    sparse = sorted(sparse, key=lambda h: h[1], reverse=True)[:pool_k]
    return _rrf_fuse([dense, sparse], pool_k), dense, len(sparse)


def _rerank_order(question: str, pool: list, top_k: int) -> list:
    """Rerank a candidate pool down to top_k (fail-safe, no trace). Used by the
    mid-answer searcher, which emits its own trace row."""
    if not config.RERANK_ENABLED or len(pool) <= top_k:
        return pool[:top_k]
    from .llm import rerank_indices
    order = rerank_indices(question, [c.text for c, _ in pool], top_k)
    return [pool[i] for i in order] if order else pool[:top_k]


def _rerank_pool(question: str, pool: list, top_k: int, tool, debug: bool) -> list:
    """Rerank a candidate pool down to top_k and emit a 'rerank' trace row. Falls
    back to the pool's own similarity order on any reranker failure."""
    if not config.RERANK_ENABLED or len(pool) <= top_k:
        return pool[:top_k]
    from .llm import rerank_indices
    t0 = time.time()
    order = rerank_indices(question, [c.text for c, _ in pool], top_k)
    if not order:
        tool("rerank", f"model={config.RERANK_MODEL} — fallback",
             [f"reranker returned nothing; kept top {top_k} by similarity"], [], t0)
        return pool[:top_k]
    hits = [pool[i] for i in order]
    dbg = [f"pool#{i} -> {rank + 1}.  {pool[i][0].doc}  p.{pool[i][0].page}"
           for rank, i in enumerate(order)]
    tool("rerank", f"model={config.RERANK_MODEL}",
         [f"{len(pool)} candidate(s) -> {len(hits)} passage(s)"], dbg, t0)
    return hits


def handle_temp_index(req: dict) -> None:
    tid = req.get("threadId")
    prefix = req.get("prefix")
    if not tid or not prefix:
        emit({"type": "error", "message": "temp index missing threadId or prefix"})
        return
    store = VectorStore.load(Path(prefix))
    pages_dir = Path(prefix).parent / "pages"
    for c in store.chunks:
        if not os.path.isabs(c.image_path):
            c.image_path = str(pages_dir / c.image_path)
    with _stores_lock:
        TEMP_STORES.setdefault(tid, []).append(store)
    emit({"type": "temp_indexed", "threadId": tid,
          "docs": sorted({c.doc for c in store.chunks}),
          "chunks": len(store)})


def handle_temp_index_clone(req: dict) -> None:
    src = req.get("fromThreadId")
    dst = req.get("toThreadId")
    if not src or not dst:
        return
    with _stores_lock:
        if src in TEMP_STORES:
            TEMP_STORES[dst] = list(TEMP_STORES[src])


def handle_temp_index_clear(req: dict) -> None:
    tid = req.get("threadId")
    if tid:
        with _stores_lock:
            TEMP_STORES.pop(tid, None)


def _confidence_level(top_sim: float) -> str:
    """Bucket the best cosine similarity into a retrieval-confidence level. Low
    means the corpus probably doesn't cover the question — surfaced to the user
    as a chip and fed to the model as a grounding hint."""
    if top_sim >= config.CONFIDENCE_HIGH:
        return "high"
    if top_sim >= config.CONFIDENCE_LOW:
        return "medium"
    return "low"


def handle_query(store: VectorStore | None, req: dict) -> None:
    from .llm import (answer_stream, embed_query, split_thinking,
                      extract_inline_tool_calls, LOW_CONFIDENCE_NOTE)

    rid = req.get("reqId")
    question = req["question"]
    history = req.get("history") or []
    debug = bool(req.get("debug"))
    model_id = req.get("model")
    stores = _thread_stores(store, req)
    if not stores:
        emit({"type": "error", "reqId": rid,
              "message": "No index found. Add PDFs to build the index first."})
        return
    all_docs = _docs_in(stores)
    requested_docs = req.get("docs")
    doc_filter = None
    if isinstance(requested_docs, list):
        requested = [d for d in requested_docs if isinstance(d, str)]
        doc_filter = [d for d in all_docs if d in set(requested)]
        if not doc_filter:
            emit({"type": "error", "reqId": rid,
                  "message": "No documents are enabled for this chat."})
            return
    model_spec = config.resolve_model(model_id)
    # Local/CLI providers never route through OpenRouter (their slug is empty), so
    # show their native model id even when OpenRouter is globally enabled.
    _local = model_spec["provider"] in ("local", "cli")
    model_name = (model_spec["openrouter"] if (config.USE_OPENROUTER and not _local)
                  else model_spec["model"]) or model_spec["model"] or model_spec["provider"]

    def tool(name, args, detail, debug_lines, t0):
        emit({"type": "tool", "reqId": rid, "name": name, "args": args,
              "detail": detail, "debug": debug_lines if debug else [],
              "duration": round(time.time() - t0, 3)})

    # 1) embed
    t0 = time.time()
    qvec = embed_query(question)
    tool("embed_query", f"model={config.EMBED_MODEL}",
         [f"1 vector · dim {len(qvec)}"], [], t0)

    # 2) search — pull a wider candidate pool (dense cosine + BM25 lexical, fused
    # with RRF when hybrid search is on) so the reranker has room to work, then
    # (2b) rerank that pool down to TOP_K.
    t0 = time.time()
    pool_k = max(config.TOP_K, config.RERANK_CANDIDATES) if config.RERANK_ENABLED else config.TOP_K
    pool, dense, n_sparse = _retrieve_pool(stores, question, qvec, pool_k, doc_filter)
    top_sim = dense[0][1] if dense else 0.0   # best cosine — retrieval-confidence signal
    dbg = [f"{s:0.4f}  {c.doc}  p.{c.page}  {' '.join(c.text.split())[:60]}"
           for c, s in pool[:config.TOP_K]]
    scope = f"{len(doc_filter)} doc(s)" if doc_filter is not None else "all docs"
    mode = (f"hybrid(dense+bm25, rrf_k={config.RRF_K}, {n_sparse} lexical)"
            if config.HYBRID_SEARCH else "dense")
    tool("search", f"top_k={config.TOP_K}, pool={len(pool)}, {mode}, scope={scope}",
         [f"{len(pool)} candidate(s) from {len({c.doc for c, _ in pool})} doc(s)"], dbg, t0)

    # 2b) rerank the candidate pool to the final TOP_K passages
    hits = _rerank_pool(question, pool, config.TOP_K, tool, debug)
    docs = {c.doc for c, _ in hits}

    # Retrieval confidence: a weak best match means the documents probably don't
    # cover the question. Feed that to the model as a grounding hint (so it leans
    # toward an honest "not enough data") and report it to the UI as a chip.
    confidence = _confidence_level(top_sim)
    conf_note = LOW_CONFIDENCE_NOTE if confidence == "low" else ""

    # 3) collect distinct page images.
    # Force page reading only on the FIRST message of a thread. On follow-ups the
    # model already has the earlier conversation, so we don't attach page images up
    # front (cheaper, faster) — it can still pull any page on demand via the
    # search_documents / get_pages tools.
    is_followup = bool(history)
    t0 = time.time()
    contexts = [{"doc": c.doc, "page": c.page, "text": c.text} for c, _ in hits]
    images, seen, sources = [], set(), []
    if not is_followup:
        for c, _ in hits:
            img = config.resolve_image(c.image_path)   # stored paths are PAGES_DIR-relative
            if img not in seen:
                seen.add(img)
                images.append(img)
                sources.append({"doc": c.doc, "page": c.page, "image": img})
            if len(images) >= config.MAX_IMAGES:
                break
        dbg = [f"{os.path.basename(p)}  ({_img_dims(p)})" for p in images]
        tool("collect_pages", f"max={config.MAX_IMAGES}",
             [f"{s['doc']} p.{s['page']}" for s in sources], dbg, t0)
    else:
        tool("collect_pages", "follow-up — no forced page reads",
             ["pages fetched on demand via search_documents / get_pages"], [], t0)

    # searcher: lets the model fetch MORE pages mid-answer. New page images are
    # deduped against what's already been sent; new sources accumulate into the
    # same `sources` list so the answer's figures/citations stay complete.
    def searcher(q: str, k: int) -> dict:
        ts = time.time()
        qv = embed_query(q)
        pool_k = max(k, config.RERANK_CANDIDATES) if config.RERANK_ENABLED else k
        pool, _dense, _ns = _retrieve_pool(stores, q, qv, pool_k, doc_filter)
        hits = _rerank_order(q, pool, k)
        new_ctx, new_imgs, new_src = [], [], []
        for c, _ in hits:
            new_ctx.append({"doc": c.doc, "page": c.page, "text": c.text})
            img = config.resolve_image(c.image_path)
            if img not in seen:
                seen.add(img)
                new_imgs.append(img)
                s = {"doc": c.doc, "page": c.page, "image": img}
                sources.append(s)
                new_src.append(s)
        tool("search_documents", q,
             [f"{len(new_ctx)} passage(s), {len(new_imgs)} new page(s)"],
             [f"{s['doc']} p.{s['page']}" for s in new_src], ts)
        return {"contexts": new_ctx, "images": new_imgs}

    # pager: fetch SPECIFIC pages by number (+ adjacent context). Resolves the page
    # image straight from disk, so it works even for figure-only pages that have no
    # text chunk — something semantic search can't reach.
    known_docs = doc_filter if doc_filter is not None else all_docs

    def _resolve_doc(name: str):
        name = (name or "").strip()
        if name in known_docs:
            return name
        low = name.lower()
        for d in known_docs:
            if d.lower() == low:
                return d
        st = os.path.splitext(name)[0].lower()
        for d in known_docs:
            if os.path.splitext(d)[0].lower() == st:
                return d
        for d in known_docs:
            if low and low in d.lower():
                return d
        return None

    def pager(doc_req: str, pages: list, context: int) -> dict:
        ts = time.time()
        doc = _resolve_doc(doc_req)
        if not doc:
            return {"contexts": [], "images": [],
                    "note": f"No document named '{doc_req}'. Available documents: "
                            f"{', '.join(known_docs) or '(none)'}."}
        wanted = sorted({p + d for p in pages for d in range(-context, context + 1) if p + d >= 1})[:12]
        sample = next((c for s in stores for c in s.chunks if c.doc == doc), None)
        subdir = os.path.dirname(sample.image_path) if sample else os.path.splitext(doc)[0].replace(" ", "_")
        by_page: dict = {}
        for s in stores:
            for c in s.chunks:
                if c.doc == doc and c.page in wanted:
                    by_page.setdefault(c.page, []).append((c.chunk_index, c.text))
        new_ctx, new_imgs, new_src = [], [], []
        for pg in wanted:
            img = config.resolve_image(f"{subdir}/p{pg:04d}.png")
            if not os.path.exists(img):
                continue   # page number out of range / never rendered
            chunks = sorted(by_page.get(pg, []))
            text = "\n".join(t for _, t in chunks) if chunks else \
                "(no extractable text on this page — read it from the page image)"
            new_ctx.append({"doc": doc, "page": pg, "text": text})
            if img not in seen:
                seen.add(img)
                new_imgs.append(img)
                s = {"doc": doc, "page": pg, "image": img}
                sources.append(s)
                new_src.append(s)
        tool("get_pages", f"{doc} pp.{','.join(str(p) for p in wanted)}",
             [f"{doc} p.{c['page']}" for c in new_ctx] or ["no matching pages"],
             [f"p{pg:04d}.png" for pg in wanted], ts)
        note = None if new_ctx else \
            f"{doc} has no pages {pages} (with context {context}); they may be out of range."
        return {"contexts": new_ctx, "images": new_imgs, "note": note}

    # 4) multimodal answer — streamed token by token, with calculate + search + get_pages
    t0 = time.time()
    final = None
    for ev in answer_stream(question, contexts, images, history=history,
                            model=model_id, searcher=searcher, pager=pager, note=conf_note):
        if ev["type"] == "delta":
            emit({"type": "delta", "reqId": rid, "text": ev["text"]})
        elif ev["type"] == "tool_call":  # a calculate()/search()/get_pages() call
            if ev.get("name") in ("search_documents", "get_pages"):
                continue  # already emitted a richer trace row inside searcher()/pager()
            mark = "=" if ev["ok"] else "error:"
            emit({"type": "tool", "reqId": rid, "name": ev.get("name", "calculate"),
                  "args": ev["args"], "detail": [f"{mark} {ev['result']}"],
                  "debug": [], "duration": 0})
        else:
            final = ev
    u = (final or {}).get("usage", {})
    dbg = ([f"tokens: {u.get('prompt')} prompt + {u.get('completion')} completion "
            f"= {u.get('total')}"] if u else [])
    tool(model_name, f"model={model_name}",
         [f"{final['n_images']} image(s) sent"], dbg, t0)

    thinking, ans = split_thinking(final["text"])
    if not ans.strip():
        # No visible answer. This happens when a reasoning model (GLM) spends its
        # whole token budget on hidden reasoning and is cut off before writing
        # prose — the reasoning streams live but never lands in final["text"], so
        # `thinking` here is usually empty too. The answerer now forces a final,
        # reasoning-free turn to recover; if even that produced nothing, say so
        # plainly instead of returning a blank answer (just the calc appendix).
        ans = (
            "The selected model finished without writing a final answer — it likely "
            "spent its full token budget on hidden reasoning. Please send the "
            "question again, or pick a different model."
        )
    # Some models emit tool calls inline as text (<tool_call>{...}</tool_call>)
    # instead of via the API. Strip those from the answer and execute any
    # calculate payloads so they still show up in the verified-calc panel.
    ans, inline_calcs = extract_inline_tool_calls(ans)
    # verification (#3): the engine computed each value; flag any that the answer
    # text doesn't actually reflect, so a mis-transcribed number is visible.
    calcs = list(final.get("calculations", [])) + inline_calcs
    for c in calcs:
        c["verified"] = bool(c.get("ok") and c.get("result") and str(c["result"]) in ans)
    # Always reference every calculation in the output: any the model didn't write
    # into its prose are listed in a Calculations appendix (numbered to match the
    # [n] markers), then re-verified so they read as referenced. This guarantees a
    # complete, checkable calc trail even when a model (e.g. a local one) computes
    # values but omits them from the answer.
    ans = _append_calc_appendix(ans, calcs)
    for c in calcs:
        c["verified"] = bool(c.get("ok") and c.get("result") and str(c["result"]) in ans)
    emit({"type": "answer", "reqId": rid, "text": ans, "thinking": thinking,
          "sources": sources, "usage": u, "calculations": calcs, "model": model_name,
          "confidence": confidence, "top_score": round(top_sim, 3),
          "latency": (final or {}).get("latency")})


def _warm_imports() -> None:
    """Force first-time imports on the main thread, before any query workers
    start. handle_query/handle_threads import `.llm` lazily, and openai loads its
    `resources.chat`/`resources.embeddings` submodules on first client access — two
    worker threads hitting those first-time imports at once deadlock on the import
    lock ('deadlock detected by _ModuleLock(...openai.resources.chat)'). Importing
    them once here, single-threaded, makes the later imports cheap no-ops."""
    from . import llm  # noqa: F401  — pulls in openai, PIL, numpy
    try:
        import openai.resources.chat.completions  # noqa: F401
        import openai.resources.embeddings  # noqa: F401
    except Exception:  # best-effort warmup; real calls will surface any error
        pass


def _run_query(store: VectorStore | None, req: dict) -> None:
    """Worker-thread entry point: run one query to completion, reporting any
    failure as an error event so a single bad request never takes the loop down."""
    try:
        handle_query(store, req)
    except Exception as e:  # report, keep serving
        capture_exception(e)
        emit({"type": "error", "reqId": req.get("reqId"), "message": str(e)})


def _dispatch_query(store: VectorStore | None, req: dict) -> None:
    """Hand a query off to its own daemon thread and return immediately, so the
    stdin loop can keep reading and other threads can stream in parallel. `store`
    is captured here so a later reload/doc_remove can't swap the index mid-answer."""
    threading.Thread(target=_run_query, args=(store, req),
                     name=f"query-{req.get('reqId') or '?'}", daemon=True).start()


def _append_calc_appendix(ans: str, calcs: list) -> str:
    """Append a 'Calculations' section listing any calc not already cited in the
    answer prose, numbered by its index so the renderer's [n] markers line up.
    Returns ans unchanged when nothing is missing."""
    missing = [i for i, c in enumerate(calcs) if not c.get("verified")]
    if not missing:
        return ans
    lines = ["", "---", "**Calculations**", ""]
    for i in missing:
        c = calcs[i]
        if c.get("ok") and c.get("result"):
            lines.append(f"{i + 1}. `{c['expression']}` = {c['result']}")
        else:
            lines.append(f"{i + 1}. `{c['expression']}` — error: {c.get('error') or 'failed'}")
    return ans.rstrip() + "\n" + "\n".join(lines)


def _img_dims(path: str) -> str:
    try:
        from PIL import Image
        with Image.open(path) as im:
            return f"{im.size[0]}x{im.size[1]}"
    except Exception:
        return "?"


# --- thread persistence + search -------------------------------------------

def _thread_embed_text(question: str, answer: str, title: str) -> str:
    return f"{title}\n\n{question}\n\n{answer}"[:4000]


def handle_threads(tstore: ThreadStore, req: dict) -> None:
    """Handle thread CRUD / search / title requests. Errors are reported but
    never crash the server loop."""
    from .llm import embed_query, summarize_title

    kind = req["type"]
    if kind == "threads_dump":
        emit({"type": "threads", "threads": tstore.dump()})
    elif kind == "thread_upsert":
        thread = req.get("thread")
        if isinstance(thread, dict):
            tstore.upsert(thread)
    elif kind == "thread_delete":
        if req.get("id"):
            tstore.delete(req["id"])
    elif kind == "thread_search":
        q = (req.get("q") or "").strip()
        results = tstore.search(embed_query(q), int(req.get("k", 20))) if q else []
        emit({"type": "thread_results", "q": q, "results": results})
    elif kind == "title_suggest":
        tid = req.get("id")
        question = req.get("question") or ""
        answer = req.get("answer") or ""
        if not tid:
            return
        title = summarize_title(question, answer)
        if not title:
            return
        tstore.set_title(tid, title)
        try:
            tstore.set_embedding(tid, embed_query(_thread_embed_text(question, answer, title)))
        except Exception:  # embedding is best-effort; title still updates
            pass
        emit({"type": "thread_title", "id": tid, "title": title})


def main(argv=None) -> int:
    # Idempotent: also called from backend_entry.py for packaged builds, but in
    # dev the app launches `python -m pdf_qa.serve` directly, so init here too.
    init_error_reporting()

    global SESSION_ID
    import uuid
    SESSION_ID = uuid.uuid4().hex[:12]
    print(f"pdf_qa backend session_id={SESSION_ID}", file=sys.stderr, flush=True)

    # Report OCR availability at startup so packaging/bundling issues are obvious
    # in the logs (main.ts mirrors backend stderr into <userData>/main.log).
    from . import ocr
    if ocr.available():
        print(f"pdf_qa OCR: tesseract available at {ocr.binary_path()}", file=sys.stderr, flush=True)
    else:
        # Fail loudly: a missing engine silently degrades retrieval on scanned
        # PDFs, so make it impossible to miss in the logs. The "OCR UNAVAILABLE"
        # marker is what main.ts elevates to error level.
        bar = "!" * 64
        for line in (
            bar,
            "pdf_qa OCR UNAVAILABLE — tesseract binary not found.",
            "Scanned / no-text-layer PDF pages will have NO searchable text.",
            "Packaged build: the bundled engine (Resources/backend/tesseract/) is",
            "missing or broken — check scripts/vendor-tesseract.sh ran at build time.",
            "Dev: install tesseract (brew/apt) or set PDF_QA_TESSERACT=/path/to/tesseract.",
            bar,
        ):
            print(line, file=sys.stderr, flush=True)

    tstore = ThreadStore(config.DB_PATH)
    try:
        store = VectorStore.load(config.STORE_PATH)
    except FileNotFoundError:
        store = None  # no PDF index yet — threads/settings still work; queries error

    _warm_imports()

    emit({"type": "ready", **_index_stats(store)})

    for raw in sys.stdin:
        raw = raw.strip()
        if not raw:
            continue
        try:
            req = json.loads(raw)
        except json.JSONDecodeError:
            emit({"type": "error", "message": f"bad JSON: {raw[:80]}"})
            continue

        kind = req.get("type")
        if kind == "ping":
            emit({"type": "pong"})
        elif kind == "info":
            emit({"type": "ready", **_index_stats(store)})
        elif kind == "reload":
            try:
                store = VectorStore.load(config.STORE_PATH)
                emit({"type": "ready", **_index_stats(store)})
            except Exception as e:  # noqa: BLE001
                capture_exception(e)
                emit({"type": "error", "message": f"reload failed: {e}"})
        elif kind == "doc_remove":
            doc = req.get("doc")
            if store is None:
                emit({"type": "error", "reqId": req.get("reqId"), "message": "No index loaded."})
                continue
            try:
                removed = store.remove_doc(doc)
                store.save()
                # drop the document's rendered page images too
                import shutil
                from pathlib import Path
                pages = config.PAGES_DIR / Path(doc).stem.replace(" ", "_")
                if pages.exists():
                    shutil.rmtree(pages, ignore_errors=True)
                emit({"type": "doc_removed", "doc": doc, "removed": removed})
                emit({"type": "ready", **_index_stats(store)})
            except Exception as e:  # noqa: BLE001
                capture_exception(e)
                emit({"type": "error", "reqId": req.get("reqId"), "message": f"remove failed: {e}"})
        elif kind == "temp_index_add":
            try:
                handle_temp_index(req)
            except Exception as e:  # noqa: BLE001
                capture_exception(e)
                emit({"type": "error", "reqId": req.get("reqId"), "message": f"temp index failed: {e}"})
        elif kind == "temp_index_clone":
            handle_temp_index_clone(req)
        elif kind == "temp_index_clear":
            handle_temp_index_clear(req)
        elif kind == "query":
            if store is None and not TEMP_STORES.get(req.get("threadId")):
                emit({"type": "error", "reqId": req.get("reqId"),
                      "message": "No index found. Add PDFs to build the index first."})
                continue
            # Run on a worker thread so the loop stays free to read more
            # requests — multiple threads stream answers concurrently.
            _dispatch_query(store, req)
        elif kind in ("threads_dump", "thread_upsert", "thread_delete",
                      "thread_search", "title_suggest"):
            try:
                handle_threads(tstore, req)
            except Exception as e:  # report, keep serving
                capture_exception(e)
                emit({"type": "error", "reqId": req.get("reqId"), "message": str(e)})
        else:
            emit({"type": "error", "message": f"unknown request type: {kind}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
