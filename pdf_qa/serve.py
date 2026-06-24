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
    {"type":"answer","reqId","text","sources":[{doc,page,image}],"usage":{...}}
    {"type":"error","reqId","message"}

`history` items are {"role":"user"|"assistant","content":"..."} text turns, owned
by the UI (one list per thread), so the backend stays stateless across threads.
"""
from __future__ import annotations

import json
import os
import sys
import time

from . import config
from .store import VectorStore


def emit(obj: dict) -> None:
    sys.stdout.write(json.dumps(obj, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _index_stats(store: VectorStore) -> dict:
    docs = sorted({c.doc for c in store.chunks})
    models = [{"id": mid, "label": spec["label"]} for mid, spec in config.MODELS.items()]
    return {"docs": docs, "chunks": len(store), "vision_model": config.VISION_MODEL,
            "embed_model": config.EMBED_MODEL,
            "models": models, "default_model": config.DEFAULT_MODEL}


def handle_query(store: VectorStore, req: dict) -> None:
    from .llm import answer_stream, embed_query, split_thinking

    rid = req.get("reqId")
    question = req["question"]
    history = req.get("history") or []
    debug = bool(req.get("debug"))
    model_id = req.get("model")
    model_spec = config.resolve_model(model_id)
    model_name = model_spec["model"]

    def tool(name, args, detail, debug_lines, t0):
        emit({"type": "tool", "reqId": rid, "name": name, "args": args,
              "detail": detail, "debug": debug_lines if debug else [],
              "duration": round(time.time() - t0, 3)})

    # 1) embed
    t0 = time.time()
    qvec = embed_query(question)
    tool("embed_query", f"model={config.EMBED_MODEL}",
         [f"1 vector · dim {len(qvec)}"], [], t0)

    # 2) search
    t0 = time.time()
    hits = store.search(qvec, config.TOP_K)
    docs = {c.doc for c, _ in hits}
    dbg = [f"{s:0.3f}  {c.doc}  p.{c.page}  {' '.join(c.text.split())[:60]}"
           for c, s in hits]
    tool("search", f"top_k={config.TOP_K}",
         [f"{len(hits)} chunks from {len(docs)} doc(s)"], dbg, t0)

    # 3) collect distinct page images
    t0 = time.time()
    contexts = [{"doc": c.doc, "page": c.page, "text": c.text} for c, _ in hits]
    images, seen, sources = [], set(), []
    for c, _ in hits:
        if c.image_path not in seen:
            seen.add(c.image_path)
            images.append(c.image_path)
            sources.append({"doc": c.doc, "page": c.page, "image": c.image_path})
        if len(images) >= config.MAX_IMAGES:
            break
    dbg = [f"{os.path.basename(p)}  ({_img_dims(p)})" for p in images]
    tool("collect_pages", f"max={config.MAX_IMAGES}",
         [f"{s['doc']} p.{s['page']}" for s in sources], dbg, t0)

    # 4) multimodal answer — streamed token by token, with the calculate tool loop
    t0 = time.time()
    final = None
    for ev in answer_stream(question, contexts, images, history=history, model=model_id):
        if ev["type"] == "delta":
            emit({"type": "delta", "reqId": rid, "text": ev["text"]})
        elif ev["type"] == "tool_call":  # a calculate() call — show it in the trace
            mark = "=" if ev["ok"] else "error:"
            emit({"type": "tool", "reqId": rid, "name": "calculate",
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
    # verification (#3): the engine computed each value; flag any that the answer
    # text doesn't actually reflect, so a mis-transcribed number is visible.
    calcs = final.get("calculations", [])
    for c in calcs:
        c["verified"] = bool(c.get("ok") and c.get("result") and str(c["result"]) in ans)
    emit({"type": "answer", "reqId": rid, "text": ans, "thinking": thinking,
          "sources": sources, "usage": u, "calculations": calcs, "model": model_name})


def _img_dims(path: str) -> str:
    try:
        from PIL import Image
        with Image.open(path) as im:
            return f"{im.size[0]}x{im.size[1]}"
    except Exception:
        return "?"


def main(argv=None) -> int:
    try:
        store = VectorStore.load(config.STORE_PATH)
    except FileNotFoundError:
        emit({"type": "error", "message": "No index found. Run ingest first."})
        return 1

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
                emit({"type": "error", "message": f"reload failed: {e}"})
        elif kind == "query":
            try:
                handle_query(store, req)
            except Exception as e:  # report, keep serving
                emit({"type": "error", "reqId": req.get("reqId"), "message": str(e)})
        else:
            emit({"type": "error", "message": f"unknown request type: {kind}"})
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
