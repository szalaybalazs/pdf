"""Retrieval evaluation harness.

Measures whether a retrieval change actually helps, on a golden set of questions
whose answer page(s) are known. Reports recall@k, hit@k and MRR, and can A/B the
two big levers — dense-vs-hybrid and rerank on/off — side by side so "seems
better" becomes a number.

    python -m pdf_qa.eval                      # evaluate the current config
    python -m pdf_qa.eval --compare            # 2x2 table: dense/hybrid x rerank
    python -m pdf_qa.eval --golden my.json -k 5

The golden file is {"questions": [{"question": ..., "expected": [{"doc","page"}]}]}.
Pages are PDF page indices (1-based), matching store metadata.
"""
from __future__ import annotations

import argparse
import json
from pathlib import Path

from . import config, llm
from .serve import _rrf_fuse
from .store import VectorStore

DEFAULT_GOLDEN = Path(__file__).resolve().parent.parent / "eval" / "golden.json"


def load_golden(path: Path) -> list[dict]:
    data = json.loads(Path(path).read_text(encoding="utf-8"))
    items = data.get("questions") if isinstance(data, dict) else data
    out: list[dict] = []
    for it in items or []:
        q = (it.get("question") or "").strip()
        if not q:
            continue
        exp: set[tuple[str, int]] = set()
        for e in it.get("expected", []):
            if isinstance(e, dict) and e.get("doc") and e.get("page") is not None:
                exp.add((e["doc"], int(e["page"])))
        # Shorthand: a top-level `doc` plus a `pages` list.
        if not exp and it.get("doc") and it.get("pages"):
            for pg in it["pages"]:
                exp.add((it["doc"], int(pg)))
        if exp:
            out.append({"question": q, "expected": exp})
    return out


def retrieve(store: VectorStore, question: str, qvec, k: int,
             rerank: bool, hybrid: bool, pool_k: int) -> list:
    """One retrieval pass with explicit levers (independent of the config flags so
    A/B runs don't mutate global state). Mirrors the serve.py pipeline: dense +
    optional BM25 (RRF-fused) into a pool, optional listwise rerank down to k."""
    dense = store.search(qvec, pool_k)
    if hybrid:
        sparse = sorted(store.bm25_search(question, pool_k), key=lambda h: h[1], reverse=True)[:pool_k]
        pool = _rrf_fuse([dense, sparse], pool_k)
    else:
        pool = dense
    if rerank and len(pool) > k:
        order = llm.rerank_indices(question, [c.text for c, _ in pool], k)
        if order:
            pool = [pool[i] for i in order]
    return pool[:k]


def score_one(hits: list, expected: set, k: int) -> dict:
    got = [(c.doc, c.page) for c, _ in hits[:k]]
    got_set = set(got)
    hit = any(g in expected for g in got)
    recall = len(got_set & expected) / len(expected) if expected else 0.0
    mrr = 0.0
    for i, g in enumerate(got):
        if g in expected:
            mrr = 1.0 / (i + 1)
            break
    return {"hit": 1.0 if hit else 0.0, "recall": recall, "mrr": mrr}


def evaluate(store: VectorStore, golden: list[dict], k: int,
             rerank: bool, hybrid: bool, pool_k: int, qvecs: dict) -> dict:
    agg = {"hit": 0.0, "recall": 0.0, "mrr": 0.0}
    rows = []
    for item in golden:
        q = item["question"]
        hits = retrieve(store, q, qvecs[q], k, rerank, hybrid, pool_k)
        s = score_one(hits, item["expected"], k)
        for key in agg:
            agg[key] += s[key]
        rows.append((q, s, hits))
    n = len(golden) or 1
    return {"hit": agg["hit"] / n, "recall": agg["recall"] / n, "mrr": agg["mrr"] / n,
            "n": len(golden), "rows": rows}


def _print_detail(res: dict, k: int) -> None:
    for q, s, hits in res["rows"]:
        top = ", ".join(f"{c.doc[:14]} p.{c.page}" for c, _ in hits[:3])
        flag = "✓" if s["hit"] else "✗"
        print(f"  {flag} r@{k}={s['recall']:.2f} mrr={s['mrr']:.2f}  {q[:52]:52}  [{top}]")


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Evaluate retrieval quality on a golden set.")
    ap.add_argument("--golden", type=Path, default=DEFAULT_GOLDEN, help="golden set JSON")
    ap.add_argument("-k", type=int, default=config.TOP_K, help=f"top-k to score (default {config.TOP_K})")
    ap.add_argument("--pool", type=int, default=None, help="candidate pool size (default RERANK_CANDIDATES)")
    ap.add_argument("--no-rerank", action="store_true", help="disable reranking")
    ap.add_argument("--no-hybrid", action="store_true", help="disable BM25/hybrid fusion")
    ap.add_argument("--compare", action="store_true", help="A/B all four dense/hybrid x rerank configs")
    ap.add_argument("--detail", action="store_true", help="print per-question rows")
    args = ap.parse_args(argv)

    golden = load_golden(args.golden)
    if not golden:
        print(f"No usable questions in {args.golden}", file=__import__("sys").stderr)
        return 1
    store = VectorStore.load(config.STORE_PATH)
    pool_k = args.pool if args.pool is not None else max(args.k, config.RERANK_CANDIDATES)

    # Embed each question once and reuse across configs (embeddings are the shared,
    # costly part; the levers only change ranking, not the query vector).
    qvecs = {item["question"]: llm.embed_query(item["question"]) for item in golden}
    print(f"Golden set: {len(golden)} question(s) · k={args.k} · pool={pool_k} · {len(store)} chunks\n")

    if args.compare:
        configs = [("dense", False, False), ("dense+rerank", True, False),
                   ("hybrid", False, True), ("hybrid+rerank", True, True)]
        print(f"{'config':16} {'hit@k':>7} {'recall@k':>9} {'MRR':>7}")
        print("-" * 42)
        for label, rr, hy in configs:
            res = evaluate(store, golden, args.k, rr, hy, pool_k, qvecs)
            print(f"{label:16} {res['hit']:7.3f} {res['recall']:9.3f} {res['mrr']:7.3f}")
        return 0

    rerank = not args.no_rerank and config.RERANK_ENABLED
    hybrid = not args.no_hybrid and config.HYBRID_SEARCH
    res = evaluate(store, golden, args.k, rerank, hybrid, pool_k, qvecs)
    print(f"config: {'hybrid' if hybrid else 'dense'}{' + rerank' if rerank else ''}")
    print(f"  hit@{args.k}    {res['hit']:.3f}")
    print(f"  recall@{args.k} {res['recall']:.3f}")
    print(f"  MRR       {res['mrr']:.3f}")
    if args.detail:
        print()
        _print_detail(res, args.k)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
