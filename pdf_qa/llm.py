"""Thin wrappers around the OpenAI API: text embeddings + multimodal answering."""
from __future__ import annotations

import base64
from io import BytesIO
from pathlib import Path

import numpy as np
from PIL import Image

from . import config


def _client():
    from openai import OpenAI
    if not config.OPENAI_API_KEY:
        raise RuntimeError(
            "OPENAI_API_KEY is not set. Put it in a .env file or export it before running."
        )
    return OpenAI(api_key=config.OPENAI_API_KEY)


def _anthropic_client():
    from anthropic import Anthropic
    if not config.ANTHROPIC_API_KEY:
        raise RuntimeError(
            "ANTHROPIC_API_KEY is not set. Put it in a .env file or export it before "
            "running, or pick the OpenAI model in the UI."
        )
    return Anthropic(api_key=config.ANTHROPIC_API_KEY)


def _local_client(spec: dict | None = None):
    from openai import OpenAI
    base_url = (spec or {}).get("base_url") or config.LOCAL_BASE_URL
    api_key = (spec or {}).get("api_key") or config.LOCAL_API_KEY or "local"
    if not base_url:
        raise RuntimeError(
            "LOCAL_BASE_URL is not set. Point it at your local server (e.g. "
            "http://localhost:11434/v1 for Ollama) and set LOCAL_MODEL, or pick a "
            "different model in the UI."
        )
    return OpenAI(api_key=api_key, base_url=base_url)


def _bedrock_client():
    """OpenAI-SDK client pointed at the Bedrock OpenAI-compatible "bedrock-mantle"
    Chat Completions gateway (GLM, DeepSeek). The Bedrock API key (bearer token)
    is used as the OpenAI key, with a region-specific base URL."""
    from openai import OpenAI
    if not config.BEDROCK_API_KEY:
        raise RuntimeError(
            "No Bedrock API key. Add it in Settings (AWS Bedrock) or set "
            "AWS_BEARER_TOKEN_BEDROCK, or pick a different model in the UI."
        )
    return OpenAI(api_key=config.BEDROCK_API_KEY, base_url=config.bedrock_base_url())


def _bedrock_runtime_client():
    """boto3 bedrock-runtime client for the Converse API (Claude, which isn't on
    the OpenAI-compatible mantle gateway). The Bedrock API key authenticates via
    the AWS_BEARER_TOKEN_BEDROCK env var; if it's unset, boto3 falls back to the
    standard AWS credential chain (profile / SigV4)."""
    import os
    try:
        import boto3
    except ImportError as e:   # pragma: no cover
        raise RuntimeError(
            "boto3 is required for Bedrock Claude (Converse). Install it: "
            "pip install boto3 (it ships in packaged builds)."
        ) from e
    if config.BEDROCK_API_KEY:
        os.environ["AWS_BEARER_TOKEN_BEDROCK"] = config.BEDROCK_API_KEY
    return boto3.client("bedrock-runtime", region_name=config.BEDROCK_REGION)


def _openrouter_client():
    from openai import OpenAI
    if not config.OPENROUTER_API_KEY:
        raise RuntimeError(
            "OPENROUTER_API_KEY is not set. Add it in Settings or .env, or set "
            "USE_OPENROUTER=false to use the providers directly."
        )
    return OpenAI(api_key=config.OPENROUTER_API_KEY, base_url=config.OPENROUTER_BASE_URL,
                  default_headers={"HTTP-Referer": "https://github.com/pdf_qa",
                                   "X-Title": "pdf_qa"})


def _chat_client(spec: dict | None = None):
    """OpenAI-compatible client for chat/vision/title calls. A "local" spec points
    at LOCAL_BASE_URL; a "bedrock" spec at the bedrock-mantle gateway; otherwise
    routes through OpenRouter when enabled, else the direct OpenAI API. (Embeddings
    use _embed_client(): the direct OpenAI client when OPENAI_API_KEY is set, else
    an OpenRouter fallback — local servers and Bedrock never serve embeddings.)"""
    if spec and spec.get("provider") == "local":
        return _local_client(spec)
    if spec and spec.get("provider") == "bedrock":
        return _bedrock_client()
    if spec and spec.get("direct"):
        return _client()   # force direct OpenAI even when OpenRouter is globally on
    if config.USE_OPENROUTER:
        return _openrouter_client()
    return _client()


def _chat_model_id(spec: dict) -> str:
    """The model id to send on chat calls: OpenRouter slug when routing through
    OpenRouter, else the provider-native id."""
    return spec["openrouter"] if config.USE_OPENROUTER else spec["model"]


def _embed_client():
    """(client, model_id) for embeddings. Prefers the direct OpenAI key; when it's
    unset, falls back to OpenRouter's OpenAI-compatible /embeddings endpoint, which
    serves text-embedding-3-small under an `openai/…` slug. The index and queries
    must use the SAME embedder, so don't switch keys between ingest and search."""
    if config.OPENAI_API_KEY:
        return _client(), config.EMBED_MODEL
    if config.OPENROUTER_API_KEY:
        return _openrouter_client(), config.EMBED_OPENROUTER_MODEL
    raise RuntimeError(
        "No embedding key set. Set OPENAI_API_KEY (preferred), or OPENROUTER_API_KEY "
        "to embed via OpenRouter. Embeddings are required to build and search the index."
    )


def embed_texts(texts: list[str]) -> np.ndarray:
    """Embed a list of texts, batching to stay within request limits.

    Batches are independent network calls, so when there's more than one and
    EMBED_WORKERS > 1 they're sent concurrently (the OpenAI/httpx client is
    safe to share across threads). Results are reassembled in input order, so
    the returned matrix lines up with `texts` exactly as the serial path did.
    """
    client, model = _embed_client()
    batches = [texts[i : i + config.EMBED_BATCH]
               for i in range(0, len(texts), config.EMBED_BATCH)]
    if not batches:
        return np.zeros((0, 0), dtype=np.float32)

    def _run(batch: list[str]) -> list[list[float]]:
        resp = client.embeddings.create(model=model, input=batch)
        return [d.embedding for d in resp.data]

    workers = min(config.EMBED_WORKERS, len(batches))
    if workers <= 1 or len(batches) == 1:
        results = [_run(b) for b in batches]
    else:
        from concurrent.futures import ThreadPoolExecutor
        with ThreadPoolExecutor(max_workers=workers) as ex:
            results = list(ex.map(_run, batches))   # map preserves input order

    out: list[list[float]] = [vec for batch_vecs in results for vec in batch_vecs]
    return np.asarray(out, dtype=np.float32)


def embed_query(text: str) -> np.ndarray:
    return embed_texts([text])[0]


_TITLE_SYSTEM = (
    "You write a very short title for a chat conversation. Reply with 3 to 6 words, "
    "Title Case, describing the topic. No quotes, no trailing punctuation, no prefix "
    "like 'Title:'. Just the title."
)


def _title_client():
    """(client, model_id) for the cheap thread-title call. Routes through OpenRouter
    when it's enabled, OR as a fallback when no OPENAI_API_KEY is set but an
    OpenRouter key is — otherwise the direct OpenAI API (matching embeddings)."""
    if config.USE_OPENROUTER or (not config.OPENAI_API_KEY and config.OPENROUTER_API_KEY):
        return _openrouter_client(), f"openai/{config.SUMMARY_MODEL}"
    return _client(), config.SUMMARY_MODEL


def summarize_title(question: str, answer: str) -> str:
    """Summarise the first exchange into a short thread title using the small,
    cheap SUMMARY_MODEL. Best-effort: returns "" on any failure so the caller can
    fall back to a placeholder."""
    client, model = _title_client()
    # The title is generated as soon as the first question is sent, so `answer`
    # is usually empty — title from the question alone, and only include the
    # assistant turn when one was actually provided.
    convo = f"User: {question.strip()[:800]}"
    if answer.strip():
        convo += f"\n\nAssistant: {answer.strip()[:800]}"
    try:
        kw: dict = {"model": model, "max_tokens": 20,
                    "messages": [{"role": "system", "content": _TITLE_SYSTEM},
                                 {"role": "user", "content": convo}]}
        if not _omits_temperature(model):
            kw["temperature"] = 0.2
        resp = client.chat.completions.create(**kw)
        title = (resp.choices[0].message.content or "").strip().strip('"').strip()
        return title[:60]
    except Exception:
        return ""


_RERANK_SYSTEM = (
    "You are a passage reranker for a document Q&A system. Given a user question "
    "and a numbered list of candidate passages, decide which passages are most "
    "relevant to ANSWERING that question. Reply with ONLY a JSON array of the "
    "passage numbers, most relevant first, and nothing else — no prose, no code "
    "fences. Include only genuinely relevant passages and omit clearly irrelevant "
    "ones. Example reply: [3, 0, 7, 2]"
)


def _rerank_client():
    """(client, model_id) for the cheap listwise reranker. Routes through
    OpenRouter when enabled or as a fallback when only an OpenRouter key is set,
    otherwise the direct OpenAI API — same policy as the title call."""
    if config.USE_OPENROUTER or (not config.OPENAI_API_KEY and config.OPENROUTER_API_KEY):
        return _openrouter_client(), f"openai/{config.RERANK_MODEL}"
    return _client(), config.RERANK_MODEL


def _parse_index_list(raw: str, n: int) -> list[int]:
    """Pull the first JSON array of ints from a reranker reply and keep the ones
    that are valid, in-range, and not duplicated. Tolerant of code fences and
    trailing prose."""
    import json
    import re
    m = re.search(r"\[[^\]]*\]", raw, re.S)
    if not m:
        return []
    try:
        arr = json.loads(m.group(0))
    except Exception:
        return []
    out: list[int] = []
    seen: set[int] = set()
    for x in arr if isinstance(arr, list) else []:
        try:
            i = int(x)
        except (TypeError, ValueError):
            continue
        if 0 <= i < n and i not in seen:
            seen.add(i)
            out.append(i)
    return out


def rerank_indices(query: str, passages: list[str], top_k: int) -> list[int] | None:
    """Listwise-rerank `passages` against `query`, returning up to `top_k` passage
    indices best-first, or None to signal "fall back to the input order".

    The model only ranks; it never invents indices. Any index the model omits is
    appended in original order so no candidate is silently dropped before the cap.
    Best-effort: returns None on any failure so the caller keeps the first-stage
    order and answering is never blocked by the reranker."""
    if len(passages) <= 1:
        return None
    numbered = "\n\n".join(f"[{i}] {p[:600]}" for i, p in enumerate(passages))
    client, model = _rerank_client()
    kw: dict = {
        "model": model, "max_tokens": 200,
        "messages": [
            {"role": "system", "content": _RERANK_SYSTEM},
            {"role": "user", "content":
                f"Question: {query}\n\nCandidate passages:\n{numbered}\n\n"
                f"Return the JSON array of the most relevant passage numbers "
                f"(up to {top_k}), best first."},
        ],
    }
    if not _omits_temperature(model):
        kw["temperature"] = 0
    try:
        resp = client.chat.completions.create(**kw)
    except Exception:
        return None
    order = _parse_index_list((resp.choices[0].message.content or ""), len(passages))
    if not order:
        return None
    # Append any passages the reranker didn't mention, in original order, so the
    # fallback tail is deterministic rather than lost.
    seen = set(order)
    order += [i for i in range(len(passages)) if i not in seen]
    return order[:top_k]


def _image_jpeg_b64(path: str, max_dim: int) -> str:
    """Load a page PNG, downscale to max_dim, return base64-encoded JPEG bytes."""
    img = Image.open(path).convert("RGB")
    if max(img.size) > max_dim:
        scale = max_dim / max(img.size)
        img = img.resize((int(img.width * scale), int(img.height * scale)))
    buf = BytesIO()
    img.save(buf, format="JPEG", quality=85)
    return base64.b64encode(buf.getvalue()).decode()


def _image_data_url(path: str, max_dim: int) -> str:
    """Same image as a base64 data URL (OpenAI image_url format)."""
    return f"data:image/jpeg;base64,{_image_jpeg_b64(path, max_dim)}"


SYSTEM_PROMPT = (
    "You are a precise technical assistant for engineering documents (textbooks and "
    "datasheets). You are given (1) extracted text passages and (2) images of the "
    "actual document pages those passages came from.\n"
    "GROUNDING — THIS IS ABSOLUTE:\n"
    "• Answer ONLY from the provided documents (their text and page images). Do not use "
    "outside/background knowledge, do not guess, do not assume, and NEVER make anything "
    "up. Every fact, value, equation and figure you cite must come from the documents.\n"
    "• You MAY read directly from a chart, schematic, table or equation in a page image "
    "(trace curves, read axis values) and you MAY apply an equation, method or worked "
    "example THAT THE DOCUMENTS PROVIDE to the user's specific numbers — that is "
    "derivation from the source, not guessing. But you may NOT invent values, assume "
    "unstated parameters, or substitute knowledge the documents don't contain.\n"
    "• If you are not sure you have all the relevant pages, FETCH MORE before concluding "
    "anything: use `search_documents` to find related pages by meaning, and use "
    "`get_pages` to pull a SPECIFIC page by number when a passage points to one (e.g. "
    "'see Fig. 4.2, p.106' or 'Table 3.2 on p.112') or when you need the page just "
    "before/after the one you're reading. Use them as many times as needed.\n"
    "• If, after searching, the documents do NOT contain the needed data or a method to "
    "derive it, DO NOT guess. Say plainly: \"Not enough data available in the documents\" "
    "(or similar), state exactly what is missing, and ask the user the specific question(s) "
    "or for the specific input that would let you proceed. It is correct and expected to "
    "ask for clarification rather than assume. This determination MUST appear in your FINAL "
    "ANSWER to the user — the text AFTER the </thinking> tag — never only inside <thinking>. "
    "Anything you conclude only in your reasoning is invisible to the user and does not "
    "count; if the data is insufficient, the user must read that in the answer itself.\n"
    "• If a parameter the user gave is ambiguous or a question is unclear, ask a "
    "clarifying question instead of guessing what they meant.\n"
    "• Cite sources inline as (filename p.N) for every claim.\n"
    "CALCULATIONS:\n"
    "• Use the `calculate` tool whenever the answer requires arithmetic or a derived "
    "number — additions, subtractions, multiplications, divisions, powers, roots, logs, "
    "unit conversions, percentages, averages, ratios, interpolation between graph points, "
    "everything. If a number in your answer is the result of ANY computation, it MUST "
    "come from a `calculate` call. NEVER do arithmetic in your head, and never write a "
    "computed number that you did not get from the tool.\n"
    "• Prefer MORE tool calls over fewer: break a multi-step calculation into one "
    "`calculate` call per step rather than computing several operations at once, so each "
    "intermediate value is independently tool-verified. When in doubt, call the tool.\n"
    "• Do NOT show equations, formulas, or symbolic setup unless you actually perform a "
    "corresponding calculation with `calculate`. When you do calculate, show only the "
    "formula(s) needed for that calculation, substitute the actual numbers, and write "
    "the exact value the tool returned (with units). If the answer does not require a "
    "calculation, answer in prose without equations.\n"
    "• ALWAYS VERIFY every result: confirm the units are right and the magnitude is "
    "sensible, and wherever possible plug the value back into the relation (via another "
    "`calculate` call) to confirm it holds. State the verification explicitly.\n"
    "• Present every number EXACTLY as the tool returned it so it can be checked. A "
    "computed number that did not pass through the tool is an error.\n"
    "FIGURES: You can reference figures, charts, schematics and tables you see in the "
    "page images. When you use one, name it by its label and page — e.g. 'Fig. 4.2 "
    "(Morgan_Jones_Valve_Amplifiers p.106)' — say what you read from it (curve values, "
    "axis readings, component values), and always include the (filename p.N) citation so "
    "the reference links back to the page.\n"
    "Format answers in Markdown. Write equations in LaTeX using \\( \\) for inline and "
    "\\[ \\] for display math."
)


# Text-only variant for models without vision input (GLM, text-only local models).
# Same grounding/calculation/citation rules, but it answers from the extracted
# passage text alone — no page images — so the figure-reading guidance is dropped.
TEXT_SYSTEM_PROMPT = (
    "You are a precise technical assistant for engineering documents (textbooks and "
    "datasheets). You are given extracted text passages from the actual document pages.\n"
    "GROUNDING — THIS IS ABSOLUTE:\n"
    "• Answer ONLY from the provided document passages. Do not use outside/background "
    "knowledge, do not guess, do not assume, and NEVER make anything up. Every fact, "
    "value and equation you cite must come from the passages.\n"
    "• You MAY apply an equation, method or worked example THAT THE PASSAGES PROVIDE to "
    "the user's specific numbers — that is derivation from the source, not guessing. But "
    "you may NOT invent values, assume unstated parameters, or substitute knowledge the "
    "documents don't contain.\n"
    "• You do NOT receive page images, so you cannot read charts, schematics or figures "
    "directly. If answering needs a value that lives only in a figure/diagram, say so "
    "explicitly rather than guessing it.\n"
    "• If you are not sure you have all the relevant passages, FETCH MORE before "
    "concluding anything: use `search_documents` to find related passages by meaning, and "
    "use `get_pages` to pull a SPECIFIC page's text by number when a passage points to one "
    "(e.g. 'see Table 3.2 on p.112') or when you need the page just before/after the one "
    "you're reading. Use them as many times as needed.\n"
    "• If, after searching, the documents do NOT contain the needed data or a method to "
    "derive it, DO NOT guess. Say plainly: \"Not enough data available in the documents\" "
    "(or similar), state exactly what is missing, and ask the user the specific question(s) "
    "or for the specific input that would let you proceed. It is correct and expected to "
    "ask for clarification rather than assume. This determination MUST appear in your FINAL "
    "ANSWER to the user — the text AFTER the </thinking> tag — never only inside <thinking>. "
    "Anything you conclude only in your reasoning is invisible to the user and does not "
    "count; if the data is insufficient, the user must read that in the answer itself.\n"
    "• If a parameter the user gave is ambiguous or a question is unclear, ask a "
    "clarifying question instead of guessing what they meant.\n"
    "• Cite sources inline as (filename p.N) for every claim.\n"
    "CALCULATIONS:\n"
    "• Use the `calculate` tool whenever the answer requires arithmetic or a derived "
    "number — additions, subtractions, multiplications, divisions, powers, roots, logs, "
    "unit conversions, percentages, averages, ratios, everything. If a number in your "
    "answer is the result of ANY computation, it MUST come from a `calculate` call. NEVER "
    "do arithmetic in your head, and never write a computed number you did not get from "
    "the tool.\n"
    "• Prefer MORE tool calls over fewer: break a multi-step calculation into one "
    "`calculate` call per step so each intermediate value is independently tool-verified.\n"
    "• Do NOT show equations, formulas, or symbolic setup unless you actually perform a "
    "corresponding calculation with `calculate`. When you do calculate, show only the "
    "formula(s) needed for that calculation, substitute the actual numbers, and write "
    "the exact value the tool returned (with units). If the answer does not require a "
    "calculation, answer in prose without equations.\n"
    "• ALWAYS VERIFY every result: confirm the units are right and the magnitude is "
    "sensible, and wherever possible plug the value back into the relation (via another "
    "`calculate` call) to confirm it holds. State the verification explicitly.\n"
    "• Present every number EXACTLY as the tool returned it so it can be checked.\n"
    "Format answers in Markdown. Write equations in LaTeX using \\( \\) for inline and "
    "\\[ \\] for display math."
)


# The user only ever sees the text AFTER </thinking>, so the closing reminder
# forces every real conclusion — especially a "not enough data" finding — out of
# the private reasoning and into the visible answer.
_THINK_TAIL = (
    " The user sees ONLY the text after </thinking>, so every conclusion that "
    "matters must appear there — in particular, if the documents lack the data to "
    "answer, state \"Not enough data available in the documents\" and what is "
    "missing in the final answer, not only inside <thinking>."
)

THINK_INSTRUCTION = (
    "\n\nBefore answering, reason step by step inside <thinking>...</thinking> tags: "
    "describe what you see in the page images (curve shapes, axis values, schematic "
    "nodes), which equations apply, and any calculation you do. After the closing "
    "</thinking> tag, give the final answer for the user." + _THINK_TAIL
)


# Same as THINK_INSTRUCTION but for the text-only path — there are no page images
# to describe, so it reasons over the passages instead.
TEXT_THINK_INSTRUCTION = (
    "\n\nBefore answering, reason step by step inside <thinking>...</thinking> tags: "
    "identify which passages are relevant, which equations apply, and any calculation "
    "you do. After the closing </thinking> tag, give the final answer for the user." + _THINK_TAIL
)


def _system_prompt(think: bool = False, vision: bool = True) -> str:
    system = SYSTEM_PROMPT if vision else TEXT_SYSTEM_PROMPT
    if config.CUSTOM_SYSTEM_PROMPT:
        system += f"\n\nAdditional user-provided system instructions:\n{config.CUSTOM_SYSTEM_PROMPT}"
    if think:
        system += THINK_INSTRUCTION if vision else TEXT_THINK_INSTRUCTION
    return system


def _followup_note(history, has_images: bool) -> str:
    """Per-turn guidance: force page reading on the first message; on follow-ups
    the model already has the conversation, so only fetch pages if this question
    actually needs material it doesn't already have."""
    if not history:
        return ("Document page images follow. Answer using the passages and by reading "
                "the page images." if has_images else
                "Answer using the passages above and the document pages.")
    base = ("This is a follow-up turn — you already have the earlier conversation "
            "context. Only fetch more pages (search_documents / get_pages) if THIS "
            "question needs material you don't already have; don't re-read everything.")
    return (("Page images follow. " if has_images else
             "No page images are attached for this follow-up. ") + base)


# Injected into the user turn when the first-stage retrieval was weak (low top
# similarity). It reinforces the grounding rules exactly where they matter most —
# when the documents probably don't cover the question — so the model returns an
# honest "not enough data" instead of stretching a poor match.
LOW_CONFIDENCE_NOTE = (
    "RETRIEVAL CONFIDENCE: LOW — the search found no strongly-matching passages "
    "for this question, so the documents may not cover it. Read what was retrieved "
    "carefully and, if it does not actually contain the data or a method to derive "
    "the answer, say \"Not enough data available in the documents\", state exactly "
    "what is missing, and ask the user for it rather than stretching a weak match."
)


def _user_text(question, contexts, history, has_images, note) -> str:
    text_block = "\n\n".join(
        f"[Passage {i+1}] ({c['doc']} p.{c['page']})\n{c['text']}"
        for i, c in enumerate(contexts)
    )
    parts = [f"Question: {question}", f"Retrieved passages:\n{text_block}",
             _followup_note(history, has_images)]
    if note:
        parts.append(note)
    return "\n\n".join(parts)


def _build_messages(question, contexts, image_paths, history, think, vision=True, note="") -> list[dict]:
    # A text-only model gets no page images regardless of what was retrieved.
    if not vision:
        image_paths = []
    content: list[dict] = [
        {"type": "text",
         "text": _user_text(question, contexts, history, bool(image_paths), note)}
    ]
    for p in image_paths:
        content.append({"type": "image_url",
                        "image_url": {"url": _image_data_url(p, config.VISION_MAX_DIM)}})

    messages = [{"role": "system", "content": _system_prompt(think, vision)}]
    if history:
        messages.extend(history)
    messages.append({"role": "user", "content": content})
    return messages


def split_thinking(text: str) -> tuple[str, str]:
    """Split a model response into (thinking, answer).

    Removes EVERY <thinking>...</thinking> block wherever it appears — start,
    middle, or end — and concatenates the rest as the answer. Multiple blocks
    are supported, and a trailing unclosed <thinking> (mid-stream) is treated as
    thinking-in-progress so it never leaks into the visible answer.
    """
    import re
    parts = re.findall(r"<thinking>(.*?)</thinking>", text, re.S)
    answer = re.sub(r"<thinking>.*?</thinking>", " ", text, flags=re.S)
    m = re.search(r"<thinking>(.*)\Z", answer, re.S)   # unclosed tail while streaming
    if m:
        parts.append(m.group(1))
        answer = answer[:m.start()]
    thinking = "\n\n".join(p.strip() for p in parts if p.strip()).strip()
    return thinking, answer.strip()


def _parse_inline_tool_args(raw: str) -> dict | None:
    """Parse the argument payload from an inline <tool_call> block. Handles two
    shapes models emit as text: a JSON object ({"expression": "...", "units": ...})
    and the Hermes/Qwen XML form GLM uses —
    `calculate<arg_key>expression</arg_key><arg_value>6.23e-13 / 2</arg_value>` —
    where the leading token is the tool name and each arg is a key/value pair.
    Returns the args dict, or None if neither shape matches."""
    import json
    import re
    raw = raw.strip()
    try:
        payload = json.loads(raw)
        return payload if isinstance(payload, dict) else None
    except Exception:
        pass
    pairs = re.findall(r"<arg_key>(.*?)</arg_key>\s*<arg_value>(.*?)</arg_value>", raw, re.S)
    if not pairs:
        return None
    out: dict = {k.strip(): v.strip() for k, v in pairs}
    if "units" in out:
        out["units"] = str(out["units"]).strip().lower() in ("1", "true", "yes")
    return out


def extract_inline_tool_calls(text: str) -> tuple[str, list]:
    """Some models emit tool calls as inline `<tool_call>...</tool_call>` text
    instead of through the tool API, which would otherwise leak into the answer.
    Both a JSON payload and GLM's Hermes XML form (<arg_key>/<arg_value>) are
    recognised.

    Strip every such block from the visible answer and, for `calculate`-style
    payloads ({"expression": "...", "units": bool}), actually run the calculation
    so it still appears in the verified-calculations panel. Returns
    (clean_text, calcs) where each calc matches the {expression, ok, result,
    error} shape used elsewhere. A trailing unclosed <tool_call> (mid-stream) is
    dropped too.
    """
    import re
    from . import calc
    calcs: list = []

    def _run(m) -> str:
        payload = _parse_inline_tool_args(m.group(1))
        if not payload:
            return ""   # not a shape we understand — just remove the markup
        expr = str(payload.get("expression", "")).strip()
        if expr:
            res = calc.evaluate(expr, bool(payload.get("units")))
            calcs.append({"expression": expr, "ok": res["ok"],
                          "result": res.get("text"), "error": res.get("error")})
        return ""

    clean = re.sub(r"<tool_call>(.*?)</tool_call>", _run, text, flags=re.S)
    clean = re.sub(r"<tool_call>.*\Z", "", clean, flags=re.S)   # unclosed tail
    clean = re.sub(r"\n{3,}", "\n\n", clean).strip()
    return clean, calcs


def _usage_dict(usage) -> dict:
    if not usage:
        return {}
    out = {
        "prompt": getattr(usage, "prompt_tokens", None),
        "completion": getattr(usage, "completion_tokens", None),
        "total": getattr(usage, "total_tokens", None),
    }
    details = getattr(usage, "completion_tokens_details", None)
    rt = getattr(details, "reasoning_tokens", None) if details else None
    if rt:
        out["reasoning"] = rt  # reasoning models (o3, o4-mini, …) report this
    return out


def _omits_temperature(model: str) -> bool:
    """Reasoning / frontier models (o-series, gpt-5.x) reject a custom temperature.
    Tolerates OpenRouter slugs like 'openai/gpt-5.5' by checking the bare model."""
    m = model.lower().split("/")[-1]
    return m.startswith(("o1", "o3", "o4")) or m.startswith("gpt-5")


# A native reasoning model (o-series, gpt-5.x) does its own chain-of-thought, which
# we surface live (see _reasoning_text). For those we DON'T also force the verbose
# <thinking> text block — that just gates the visible answer behind a long emitted
# block and duplicates the native reasoning.
def _is_reasoning_model(model: str) -> bool:
    return _omits_temperature(model)


def _is_glm_model(model: str) -> bool:
    """GLM tends to obey literal <thinking> prompts too well and can spend the
    whole response there. Let it answer directly while the UI still supports
    native reasoning deltas if a provider exposes them."""
    m = model.lower()
    return "glm" in m or m.startswith("z-ai/") or ".glm-" in m or "zai.glm" in m


def _reasoning_text(delta) -> str:
    """Pull a reasoning-token chunk out of a streamed delta. OpenRouter exposes a
    reasoning model's chain-of-thought as `delta.reasoning` (some providers use
    `reasoning_content`); the OpenAI SDK stashes such non-standard fields on the
    object directly or under `model_extra`. Returns "" when there's none."""
    v = getattr(delta, "reasoning", None) or getattr(delta, "reasoning_content", None)
    if not v:
        extra = getattr(delta, "model_extra", None) or {}
        if isinstance(extra, dict):
            v = extra.get("reasoning") or extra.get("reasoning_content")
    return v if isinstance(v, str) else ""


def _max_tokens_for(model: str) -> int:
    """Token ceiling for a chat call. Reasoning-heavy models (o-series, gpt-5.x,
    GLM) consume a large share of the completion on hidden reasoning tokens that
    count against max_tokens; with the base cap they get truncated mid-reasoning
    and never emit a visible answer, so they get the larger REASONING_MAX_TOKENS."""
    if _is_reasoning_model(model) or _is_glm_model(model):
        return config.REASONING_MAX_TOKENS
    return config.ANSWER_MAX_TOKENS


def _chat_kwargs(model: str | None = None) -> dict:
    """Shared chat-completion kwargs; temperature omitted when unset or when the
    target model rejects it (reasoning / gpt-5.x models)."""
    m = model or config.VISION_MODEL
    kw: dict = {"model": m, "max_tokens": _max_tokens_for(m)}
    if config.VISION_TEMPERATURE is not None and not _omits_temperature(m):
        kw["temperature"] = config.VISION_TEMPERATURE
    return kw


# The model MUST use this tool for arithmetic — the engine computes exactly,
# so the answer's numbers come from SymPy/pint, never from the model's head.
CALC_TOOL = {
    "type": "function",
    "function": {
        "name": "calculate",
        "description": (
            "Evaluate a mathematical expression EXACTLY. You MUST call this for every "
            "arithmetic step (powers, logs, roots, division) instead of computing in your "
            "head, and use the returned value verbatim. Supports + - * / ** , parentheses, "
            "and functions sqrt, log (natural), ln, log10, log2, exp, sin, cos, tan, asin, "
            "acos, atan, pi, e. For dimensional results set units=true and include unit "
            "tokens such as ohm, V, W, A, Hz."),
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {"type": "string",
                               "description": "e.g. '10*log10(50)' or '(2*W*8*ohm)**0.5'"},
                "units": {"type": "boolean",
                          "description": "true if the expression includes physical units"},
            },
            "required": ["expression"],
        },
    },
}

# Same tool, in Anthropic's schema (name + description + input_schema).
ANTHROPIC_CALC_TOOL = {
    "name": CALC_TOOL["function"]["name"],
    "description": CALC_TOOL["function"]["description"],
    "input_schema": CALC_TOOL["function"]["parameters"],
}

# Lets the model fetch MORE pages/passages when the first retrieval pass didn't
# surface everything it needs to answer fully and accurately.
SEARCH_TOOL = {
    "type": "function",
    "function": {
        "name": "search_documents",
        "description": (
            "Search the indexed PDF library for ADDITIONAL passages and page images. "
            "Call this whenever the material you already have is not enough to answer "
            "completely and accurately from the documents — e.g. you need another "
            "section, a referenced figure/table, a datasheet rating, or a different part "
            "of the document. You may call it as many times as needed. It returns more "
            "passages (with their (filename p.N) citations) and adds the matching page "
            "images to the conversation for you to read. If after searching the documents "
            "still don't contain the needed data or method, say so explicitly."),
        "parameters": {
            "type": "object",
            "properties": {
                "query": {"type": "string",
                          "description": "What to look for, in natural language, e.g. "
                                         "'6N1P maximum plate dissipation' or 'output "
                                         "transformer primary impedance table'."},
                "k": {"type": "integer",
                      "description": "How many passages to retrieve (default 6, max 12)."},
            },
            "required": ["query"],
        },
    },
}
ANTHROPIC_SEARCH_TOOL = {
    "name": SEARCH_TOOL["function"]["name"],
    "description": SEARCH_TOOL["function"]["description"],
    "input_schema": SEARCH_TOOL["function"]["parameters"],
}

# Fetch SPECIFIC pages by number (and optionally adjacent ones). Unlike
# search_documents (semantic), this is page-addressed: use it when a passage
# references a precise page/figure/table ("see Fig. 4.2, p.106", "Table 3.2 on
# p.112") or when you need the page just before/after the one you're reading.
# It can also retrieve figure-only pages that carry no searchable text.
GET_PAGES_TOOL = {
    "type": "function",
    "function": {
        "name": "get_pages",
        "description": (
            "Fetch specific page images (and their text, if any) from a document by "
            "PAGE NUMBER. Use this when you need an exact page — e.g. a passage points to "
            "'see p.112' or 'Fig. 4.2 (p.106)', or you want the page right before/after the "
            "one you're reading. Unlike search_documents, this is addressed by number and "
            "can also return figure-only pages that have no searchable text. Give the "
            "document filename exactly as it appears in the (filename p.N) citations."),
        "parameters": {
            "type": "object",
            "properties": {
                "doc": {"type": "string",
                        "description": "Document filename as shown in citations, e.g. 'Morgan_Jones_Valve_Amplifiers.pdf'."},
                "pages": {"type": "array", "items": {"type": "integer"},
                          "description": "1-based page numbers to fetch, e.g. [106] or [111, 112]."},
                "context": {"type": "integer",
                            "description": "Also include this many pages before AND after each requested page (default 0, max 3)."},
            },
            "required": ["doc", "pages"],
        },
    },
}
ANTHROPIC_GET_PAGES_TOOL = {
    "name": GET_PAGES_TOOL["function"]["name"],
    "description": GET_PAGES_TOOL["function"]["description"],
    "input_schema": GET_PAGES_TOOL["function"]["parameters"],
}


def _format_passages(contexts: list[dict]) -> str:
    """Render retrieved passages as the text a search tool-call returns."""
    if not contexts:
        return "No additional passages found for that query."
    return "\n\n".join(
        f"[{c['doc']} p.{c['page']}]\n{c['text']}" for c in contexts
    )


# Safety backstop only: the loop runs until the model stops requesting tools, but
# we cap iterations far above any real need so a misbehaving model can't spin
# forever (and rack up cost). Effectively "unlimited" for normal use.
_MAX_TOOL_ROUNDS = 100

# A model stuck in a useless tool loop (e.g. GLM dividing a number by 2 fifty
# times) calls tools round after round without ever writing prose. A real answer
# interleaves text between calculation batches, which resets the counter; this
# many consecutive tool-only rounds means the model has lost the plot, so we stop
# offering tools and force it to write the final answer from what it already has.
_MAX_TOOLONLY_ROUNDS = 24
_MAX_GLM_TOOLONLY_ROUNDS = 6
_MAX_DUPLICATE_TOOLONLY_ROUNDS = 3
_MAX_GLM_DUPLICATE_TOOLONLY_ROUNDS = 1


def _tool_signature(name: str, raw_args: str) -> tuple:
    """Stable signature for spotting repeated tool calls across rounds."""
    import json
    try:
        args = json.loads(raw_args or "{}")
    except Exception:
        args = raw_args or ""
    return (name, json.dumps(args, sort_keys=True) if isinstance(args, dict) else str(args))


def _run_calc(tc_name: str, raw_args: str, collected: list) -> str:
    """Execute one tool call; record it; return the JSON the model will see."""
    import json
    from . import calc
    if tc_name != "calculate":
        return json.dumps({"error": f"unknown tool {tc_name}"})
    try:
        args = json.loads(raw_args or "{}")
    except Exception:
        args = {}
    expr = str(args.get("expression", ""))
    res = calc.evaluate(expr, bool(args.get("units")))
    collected.append({"expression": expr, "ok": res["ok"],
                      "result": res.get("text"), "error": res.get("error")})
    return json.dumps(res)


def answer(question: str, contexts: list[dict], image_paths: list[str],
           history: list[dict] | None = None, think: bool = False) -> dict:
    """Non-streaming answer with the calculate tool loop (used by the CLI)."""
    import time
    client = _chat_client()
    model_id = _chat_model_id(config.resolve_model(config.DEFAULT_MODEL))
    messages = _build_messages(question, contexts, image_paths, history, think)
    t0 = time.time()
    calculations: list = []
    usage_tot = _new_usage()
    for _ in range(_MAX_TOOL_ROUNDS):
        resp = client.chat.completions.create(messages=messages, tools=[CALC_TOOL], **_chat_kwargs(model_id))
        _add_usage(usage_tot, getattr(resp, "usage", None))
        msg = resp.choices[0].message
        if msg.tool_calls:
            messages.append({"role": "assistant", "content": msg.content or None,
                             "tool_calls": [{"id": tc.id, "type": "function",
                                             "function": {"name": tc.function.name,
                                                          "arguments": tc.function.arguments}}
                                            for tc in msg.tool_calls]})
            for tc in msg.tool_calls:
                out = _run_calc(tc.function.name, tc.function.arguments, calculations)
                messages.append({"role": "tool", "tool_call_id": tc.id, "content": out})
            continue
        return {"text": msg.content, "model": model_id,
                "latency": time.time() - t0, "n_images": len(image_paths),
                "usage": usage_tot, "calculations": calculations}
    return {"text": "(calculation loop did not converge)", "model": model_id,
            "latency": time.time() - t0, "n_images": len(image_paths),
            "usage": usage_tot, "calculations": calculations}


def _new_usage() -> dict:
    return {"prompt": 0, "completion": 0, "total": 0, "reasoning": 0}


def _add_usage(tot: dict, usage) -> None:
    if not usage:
        return
    tot["prompt"] += getattr(usage, "prompt_tokens", 0) or 0
    tot["completion"] += getattr(usage, "completion_tokens", 0) or 0
    tot["total"] += getattr(usage, "total_tokens", 0) or 0
    det = getattr(usage, "completion_tokens_details", None)
    if det:
        tot["reasoning"] += getattr(det, "reasoning_tokens", 0) or 0


def _search_query(raw_args: str) -> str:
    import json
    try:
        return str(json.loads(raw_args or "{}").get("query", ""))
    except Exception:
        return ""


def _pages_summary(raw_args: str) -> str:
    import json
    try:
        a = json.loads(raw_args or "{}")
        pages = a.get("pages") or []
        return f"{a.get('doc', '?')} pp.{','.join(str(p) for p in pages)}"
    except Exception:
        return ""


def _run_search(raw_args: str, searcher) -> tuple[dict, list]:
    """Run a search_documents tool call. Returns (result, new_image_paths) where
    result = {"text": passages-as-text, "n": passage_count}."""
    import json
    try:
        args = json.loads(raw_args or "{}")
    except Exception:
        args = {}
    query = str(args.get("query", "")).strip()
    try:
        k = int(args.get("k") or 6)
    except Exception:
        k = 6
    k = max(1, min(k, 12))
    found = searcher(query, k) if query else {"contexts": [], "images": []}
    ctx = found.get("contexts", [])
    return {"text": _format_passages(ctx), "n": len(ctx)}, found.get("images", [])


def _run_get_pages(raw_args: str, pager) -> tuple[dict, list]:
    """Run a get_pages tool call. Returns (result, new_image_paths) where
    result = {"text": passages-as-text, "n": page_count}."""
    import json
    try:
        args = json.loads(raw_args or "{}")
    except Exception:
        args = {}
    doc = str(args.get("doc", "")).strip()
    raw_pages = args.get("pages") or []
    pages = []
    for p in raw_pages if isinstance(raw_pages, list) else [raw_pages]:
        try:
            pages.append(int(p))
        except Exception:
            continue
    try:
        context = int(args.get("context") or 0)
    except Exception:
        context = 0
    context = max(0, min(context, 3))
    found = pager(doc, pages, context) if (doc and pages) else {"contexts": [], "images": []}
    ctx = found.get("contexts", [])
    text = found.get("note") or _format_passages(ctx)
    return {"text": text, "n": len(ctx)}, found.get("images", [])


def answer_stream(question: str, contexts: list[dict], image_paths: list[str],
                  history: list[dict] | None = None, think: bool = True,
                  model: str | None = None, searcher=None, pager=None, note: str = ""):
    """Streaming answer generator with the calculate + search + get_pages loop.

    `model` is a UI model id (see config.MODELS); it selects the provider.
    `searcher(query, k)` retrieves more pages by relevance; `pager(doc, pages,
    context)` fetches specific pages by number. Both return {"contexts":[...],
    "images":[paths]} and let the model read more pages mid-answer. Yields
    {"type":"delta","text"}, {"type":"tool_call","name","args","ok","result"} per
    tool use, then {"type":"final","text","usage","calculations",...}.
    """
    spec = config.resolve_model(model)
    # Text-only models (GLM, text-only local models) never receive page images.
    vision = config.model_supports_vision(spec)
    # Local CLI models run on the machine (no API) — handle before any remote path.
    if spec["provider"] == "cli":
        yield from _answer_stream_cli(question, contexts, image_paths, history, think, spec["model"], note=note)
        return
    # Local OpenAI-compatible server: same streaming path as remote OpenAI, but the
    # client points at LOCAL_BASE_URL and we send the server's native model id
    # (OpenRouter routing never applies to a local model).
    if spec["provider"] == "local":
        yield from _answer_stream_openai(question, contexts, image_paths, history,
                                         think, spec["model"], searcher, pager, spec=spec, vision=vision, note=note)
        return
    # AWS Bedrock. Claude isn't on the OpenAI-compatible mantle gateway so it uses
    # the boto3 Converse path; GLM and DeepSeek speak mantle Chat Completions and
    # reuse the OpenAI streaming path with their native Bedrock model id.
    if spec["provider"] == "bedrock":
        if spec.get("api") == "converse":   # Claude: bedrock-runtime Converse (not on mantle)
            yield from _answer_stream_bedrock_converse(question, contexts, image_paths, history,
                                                       think, spec["model"], searcher, pager, vision=vision, note=note)
        else:                                # GLM, DeepSeek: Chat Completions on mantle
            yield from _answer_stream_openai(question, contexts, image_paths, history,
                                             think, spec["model"], searcher, pager, spec=spec, vision=vision, note=note)
        return
    # Direct-to-OpenAI override: send the native model id straight to OpenAI,
    # skipping OpenRouter even when it's globally enabled.
    if spec.get("direct"):
        yield from _answer_stream_openai(question, contexts, image_paths, history,
                                         think, spec["model"], searcher, pager, spec=spec, vision=vision, note=note)
        return
    # When OpenRouter is on, everything (incl. Claude) goes through the OpenAI-
    # compatible path; otherwise Anthropic uses its native SDK path.
    if not config.USE_OPENROUTER and spec["provider"] == "anthropic":
        yield from _answer_stream_anthropic(question, contexts, image_paths,
                                            history, think, spec["model"], searcher, pager, vision=vision, note=note)
    else:
        yield from _answer_stream_openai(question, contexts, image_paths,
                                         history, think, _chat_model_id(spec), searcher, pager, vision=vision, note=note)


def _answer_stream_openai(question: str, contexts: list[dict], image_paths: list[str],
                          history: list[dict] | None, think: bool, model: str,
                          searcher=None, pager=None, spec: dict | None = None, vision: bool = True, note: str = ""):
    import time
    if not vision:
        image_paths = []   # text-only model — never send page images
    client = _chat_client(spec)
    # OpenRouter is the active route unless this is the direct-to-OpenAI override or
    # a local server. Only over OpenRouter do we get (and ask for) reasoning deltas.
    via_openrouter = config.USE_OPENROUTER and not (
        spec and (spec.get("direct") or spec.get("provider") in ("local", "bedrock")))
    reasoning_model = _is_reasoning_model(model)
    glm_model = _is_glm_model(model)
    # Native reasoning models stream their own chain-of-thought; surfacing that live
    # is the "thinking", so don't also force the verbose <thinking> text block (it
    # would gate the visible answer behind a long emitted block).
    if reasoning_model or glm_model:
        think = False
    messages = _build_messages(question, contexts, image_paths, history, think, vision, note=note)
    tools = [CALC_TOOL] + ([SEARCH_TOOL] if searcher else []) + ([GET_PAGES_TOOL] if pager else [])
    t0 = time.time()
    content_all: list = []
    calculations: list = []
    usage_tot = _new_usage()
    pending = False   # last round still wanted tools but we ran out of rounds
    tools_ok = bool(tools)   # some local (Ollama) vision models reject `tools` — drop them on first failure

    def _open_stream(tool_choice: str | None = None, use_tools: bool = True,
                     reasoning_off: bool = False):
        """Start a chat stream, gracefully degrading if the server can't do tools.
        Local vision models often 400 with 'does not support tools'; in that case we
        retry without tools (the calculate/search tools just go unused). Pass
        use_tools=False to omit the tools entirely (the forced final turn) — some
        models (e.g. GLM) emit an inline tool-call as text when tools are present
        but `tool_choice` forbids them, instead of writing the actual answer. Pass
        reasoning_off=True on the forced final turn so a reasoning model spends its
        whole budget on the visible answer instead of burning it on more hidden
        reasoning (which is what truncated the answer in the first place)."""
        nonlocal tools_ok
        kw = dict(messages=messages, stream=True,
                  stream_options={"include_usage": True}, **_chat_kwargs(model))
        if via_openrouter and (reasoning_model or glm_model):
            # Over OpenRouter we control reasoning explicitly: normally ask the model
            # to generate AND return reasoning tokens so we can stream them as live
            # "thinking"; on the forced final turn, disable reasoning so the budget
            # goes to the answer prose, not another (possibly truncated) think pass.
            kw["extra_body"] = {"reasoning": {"enabled": not reasoning_off}}
        if use_tools and tools_ok and tools:
            kw["tools"] = tools
            if tool_choice:
                kw["tool_choice"] = tool_choice
        try:
            return client.chat.completions.create(**kw)
        except Exception as e:  # noqa: BLE001
            msg = str(e).lower()
            if tools_ok and tools and "support" in msg and "tool" in msg:
                tools_ok = False
                kw.pop("tools", None)
                kw.pop("tool_choice", None)
                return client.chat.completions.create(**kw)
            raise

    think_open = False   # currently streaming reasoning inside an injected <thinking> block
    toolonly_rounds = 0  # consecutive rounds with tool calls but no prose (spiral guard)
    duplicate_toolonly_rounds = 0
    seen_tool_sigs: dict[tuple, int] = {}
    max_toolonly_rounds = _MAX_GLM_TOOLONLY_ROUNDS if glm_model else _MAX_TOOLONLY_ROUNDS
    max_duplicate_toolonly_rounds = (
        _MAX_GLM_DUPLICATE_TOOLONLY_ROUNDS if glm_model else _MAX_DUPLICATE_TOOLONLY_ROUNDS
    )

    for _ in range(_MAX_TOOL_ROUNDS):
        stream = _open_stream()
        round_content: list = []
        tool_calls: dict = {}
        round_reasoned = False   # this round emitted reasoning tokens
        finish_reason = None     # "stop" | "length" | "tool_calls" | …
        for chunk in stream:
            _add_usage(usage_tot, getattr(chunk, "usage", None))
            if not chunk.choices:
                continue
            if chunk.choices[0].finish_reason:
                finish_reason = chunk.choices[0].finish_reason
            d = chunk.choices[0].delta
            # Reasoning tokens stream first: wrap them in <thinking>…</thinking> so the
            # UI shows a live, expandable "Thinking" box. They're NOT part of the answer,
            # so they go to the delta stream only — never into content_all.
            r = _reasoning_text(d)
            if r:
                round_reasoned = True
                if not think_open:
                    think_open = True
                    yield {"type": "delta", "text": "<thinking>"}
                yield {"type": "delta", "text": r}
            c = getattr(d, "content", None)
            if c:
                if think_open:   # reasoning done — close the block before the answer starts
                    think_open = False
                    yield {"type": "delta", "text": "</thinking>"}
                round_content.append(c)
                content_all.append(c)
                yield {"type": "delta", "text": c}
            for tc in (getattr(d, "tool_calls", None) or []):
                slot = tool_calls.setdefault(tc.index, {"id": "", "name": "", "args": ""})
                if getattr(tc, "id", None):
                    slot["id"] = tc.id
                fn = getattr(tc, "function", None)
                if fn and getattr(fn, "name", None):
                    slot["name"] = fn.name
                if fn and getattr(fn, "arguments", None):
                    slot["args"] += fn.arguments

        if think_open:   # round ended mid-reasoning (e.g. reasoned, then called a tool)
            think_open = False
            yield {"type": "delta", "text": "</thinking>"}

        if not tool_calls:
            # No tool call ends the turn — normally a finished answer. But a
            # reasoning model (GLM) can spend its whole token budget on hidden
            # reasoning and get cut off (finish_reason == "length") before writing
            # any visible prose; that empty turn is NOT a finished answer. If
            # nothing visible has been emitted across the whole stream, force a
            # clean, reasoning-free continuation below instead of returning "".
            if "".join(content_all).strip():
                pending = False
                break
            if finish_reason == "length" or round_reasoned:
                pending = True   # stopped before answering — recover with a final turn
            else:
                pending = False
            break
        pending = True
        # Spiral guard: count rounds that called tools but produced no answer prose.
        # A healthy answer writes text between calculation batches (resetting this);
        # a runaway loop never does. Trip → break out and force a final answer below.
        has_prose = bool("".join(round_content).strip())
        round_sigs = [
            _tool_signature(tool_calls[i]["name"], tool_calls[i]["args"] or "{}")
            for i in sorted(tool_calls)
        ]
        repeated_round = bool(round_sigs) and all(seen_tool_sigs.get(sig, 0) > 0 for sig in round_sigs)
        toolonly_rounds = toolonly_rounds + 1 if not has_prose else 0
        duplicate_toolonly_rounds = (
            duplicate_toolonly_rounds + 1 if repeated_round and not has_prose else 0
        )
        if (toolonly_rounds >= max_toolonly_rounds
                or duplicate_toolonly_rounds >= max_duplicate_toolonly_rounds):
            break
        for sig in round_sigs:
            seen_tool_sigs[sig] = seen_tool_sigs.get(sig, 0) + 1
        # record the assistant turn that requested the tools, then run them
        messages.append({"role": "assistant", "content": "".join(round_content) or None,
                         "tool_calls": [{"id": tool_calls[i]["id"] or f"call_{i}", "type": "function",
                                         "function": {"name": tool_calls[i]["name"],
                                                      "arguments": tool_calls[i]["args"] or "{}"}}
                                        for i in sorted(tool_calls)]})
        new_images: list = []   # page images any search() asked for, added after tool results
        for i in sorted(tool_calls):
            c = tool_calls[i]
            cid = c["id"] or f"call_{i}"
            if c["name"] == "search_documents" and searcher:
                out, imgs = _run_search(c["args"], searcher)
                new_images.extend(imgs)
                yield {"type": "tool_call", "name": "search_documents",
                       "args": _search_query(c["args"]),
                       "ok": True, "result": f"{out['n']} passage(s), {len(imgs)} new page(s)"}
                messages.append({"role": "tool", "tool_call_id": cid, "content": out["text"]})
            elif c["name"] == "get_pages" and pager:
                out, imgs = _run_get_pages(c["args"], pager)
                new_images.extend(imgs)
                yield {"type": "tool_call", "name": "get_pages", "args": _pages_summary(c["args"]),
                       "ok": True, "result": f"{out['n']} page(s), {len(imgs)} image(s)"}
                messages.append({"role": "tool", "tool_call_id": cid, "content": out["text"]})
            else:
                res = _run_calc(c["name"], c["args"], calculations)
                if c["name"] == "calculate" and calculations:
                    last = calculations[-1]
                    yield {"type": "tool_call", "name": "calculate", "args": last["expression"],
                           "ok": last["ok"], "result": last["result"] or last["error"]}
                messages.append({"role": "tool", "tool_call_id": cid, "content": res})
        if new_images and vision:   # OpenAI: images can't ride in tool results, so add a user turn
            content = [{"type": "text", "text": "Additional page images you requested:"}]
            for p in new_images:
                content.append({"type": "image_url",
                                "image_url": {"url": _image_data_url(p, config.VISION_MAX_DIM)}})
            messages.append({"role": "user", "content": content})
        if toolonly_rounds >= max_toolonly_rounds:
            break   # runaway tool loop — stop and force the final answer below

    # The model ended without a usable answer — it ran out of the round budget, it
    # tripped the spiral guard, or (GLM) it spent the whole token budget on hidden
    # reasoning and was cut off before writing prose. Force one final turn: drop
    # the tools ENTIRELY (not just tool_choice="none" — some models, e.g. GLM, then
    # emit a tool call as inline text instead of prose), disable reasoning so the
    # full budget goes to the answer rather than another truncated think pass, and
    # tell it explicitly to write up the result.
    if pending:
        messages.append({"role": "user", "content":
            "Stop reasoning and stop calling tools. Using the values you already "
            "computed above, write your complete final answer now in prose. Do NOT "
            "call any tool or emit any tool-call syntax — just the answer."})
        stream = _open_stream(use_tools=False, reasoning_off=True)
        for chunk in stream:
            _add_usage(usage_tot, getattr(chunk, "usage", None))
            if not chunk.choices:
                continue
            d = chunk.choices[0].delta
            r = _reasoning_text(d)
            if r:
                if not think_open:
                    think_open = True
                    yield {"type": "delta", "text": "<thinking>"}
                yield {"type": "delta", "text": r}
            c = getattr(d, "content", None)
            if c:
                if think_open:
                    think_open = False
                    yield {"type": "delta", "text": "</thinking>"}
                content_all.append(c)
                yield {"type": "delta", "text": c}
        if think_open:
            think_open = False
            yield {"type": "delta", "text": "</thinking>"}

    yield {"type": "final", "text": "".join(content_all), "latency": time.time() - t0,
           "n_images": len(image_paths), "usage": usage_tot, "calculations": calculations}


# ---- Local CLI path (claude -p) ---------------------------------------------

def _answer_stream_cli(question: str, contexts: list[dict], image_paths: list[str],
                       history: list[dict] | None, think: bool, model: str, note: str = ""):
    """Answer via a locally-installed model CLI (Claude Code's `claude -p`).

    Text-only: the CLI receives the retrieved passage text + question and streams
    its answer. It does not get the page images or our calculate/search tools, and
    it uses the user's own logged-in CLI session (no API key)."""
    import shutil
    import subprocess
    import time
    t0 = time.time()
    binname = config.CLAUDE_CLI_BIN

    if not shutil.which(binname):
        yield {"type": "final",
               "text": f"Local Claude CLI not found (`{binname}`). Install Claude Code and run "
                       f"`claude login`, or set CLAUDE_CLI_BIN to its path.",
               "latency": 0, "n_images": 0, "usage": _new_usage(), "calculations": []}
        return

    passages = "\n\n".join(
        f"[{c['doc']} p.{c['page']}]\n{c['text']}" for c in contexts) or "(no passages retrieved)"
    hist = ""
    if history:
        hist = "\n\n".join(f"{h['role'].upper()}: {h['content']}" for h in history) + "\n\n"
    prompt = (f"{hist}Retrieved passages from the indexed PDF library:\n{passages}\n\n"
              f"Question: {question}" + (f"\n\n{note}" if note else ""))

    args = [binname, "-p", "--append-system-prompt", _system_prompt(False)]
    if model:
        args += ["--model", model]

    try:
        proc = subprocess.Popen(args, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                                stderr=subprocess.PIPE, text=True, bufsize=1)
    except Exception as e:  # noqa: BLE001
        yield {"type": "final", "text": f"Could not launch `{binname}`: {e}",
               "latency": 0, "n_images": 0, "usage": _new_usage(), "calculations": []}
        return

    assert proc.stdin and proc.stdout and proc.stderr
    try:
        proc.stdin.write(prompt)
        proc.stdin.close()   # EOF — also prevents the CLI blocking on an interactive prompt
    except Exception:
        pass

    chunks: list = []
    for line in proc.stdout:
        chunks.append(line)
        yield {"type": "delta", "text": line}
    proc.wait()
    err = (proc.stderr.read() or "").strip()
    text = "".join(chunks).strip()
    if not text:
        text = f"Claude CLI produced no output{(': ' + err[:500]) if err else '.'}"
    yield {"type": "final", "text": text, "latency": time.time() - t0,
           "n_images": 0, "usage": _new_usage(), "calculations": []}


# ---- Anthropic (Claude) path ------------------------------------------------

def _build_anthropic_messages(question, contexts, image_paths, history, vision=True, note="") -> list[dict]:
    """Anthropic puts the system prompt in its own parameter and uses content
    blocks with base64 image sources, so we build messages separately from the
    OpenAI path (the prompt text and tool are shared)."""
    if not vision:
        image_paths = []
    content: list[dict] = [
        {"type": "text",
         "text": _user_text(question, contexts, history, bool(image_paths), note)}
    ]
    for p in image_paths:
        content.append({"type": "image",
                        "source": {"type": "base64", "media_type": "image/jpeg",
                                   "data": _image_jpeg_b64(p, config.VISION_MAX_DIM)}})
    messages: list[dict] = []
    if history:
        messages.extend(history)  # {"role","content": str} turns are valid as-is
    messages.append({"role": "user", "content": content})
    return messages


def _answer_stream_anthropic(question: str, contexts: list[dict], image_paths: list[str],
                             history: list[dict] | None, think: bool, model: str,
                             searcher=None, pager=None, vision: bool = True, note: str = ""):
    import json
    import time
    if not vision:
        image_paths = []
    client = _anthropic_client()
    messages = _build_anthropic_messages(question, contexts, image_paths, history, vision, note=note)
    system = _system_prompt(think, vision)
    tools = ([ANTHROPIC_CALC_TOOL]
             + ([ANTHROPIC_SEARCH_TOOL] if searcher else [])
             + ([ANTHROPIC_GET_PAGES_TOOL] if pager else []))
    t0 = time.time()
    content_all: list = []
    calculations: list = []
    usage_tot = _new_usage()
    pending = False   # last round still wanted tools but we ran out of rounds

    for _ in range(_MAX_TOOL_ROUNDS):
        with client.messages.stream(
            model=model, max_tokens=config.ANTHROPIC_MAX_TOKENS, system=system,
            messages=messages, tools=tools,
        ) as stream:
            for text in stream.text_stream:
                content_all.append(text)
                yield {"type": "delta", "text": text}
            final_msg = stream.get_final_message()

        u = getattr(final_msg, "usage", None)
        if u:
            usage_tot["prompt"] += getattr(u, "input_tokens", 0) or 0
            usage_tot["completion"] += getattr(u, "output_tokens", 0) or 0
            usage_tot["total"] = usage_tot["prompt"] + usage_tot["completion"]

        # split the response into the assistant turn (echoed back verbatim) and
        # the tool_use blocks we must answer
        assistant_content: list = []
        tool_uses: list = []
        for block in final_msg.content:
            if block.type == "text":
                assistant_content.append({"type": "text", "text": block.text})
            elif block.type == "tool_use":
                assistant_content.append({"type": "tool_use", "id": block.id,
                                          "name": block.name, "input": block.input})
                tool_uses.append(block)

        if not tool_uses:
            pending = False
            break
        pending = True

        messages.append({"role": "assistant", "content": assistant_content})
        tool_results: list = []
        for block in tool_uses:
            if block.name in ("search_documents", "get_pages") and (searcher or pager):
                if block.name == "get_pages":
                    res, imgs = _run_get_pages(json.dumps(block.input or {}), pager)
                    yield {"type": "tool_call", "name": "get_pages",
                           "args": _pages_summary(json.dumps(block.input or {})),
                           "ok": True, "result": f"{res['n']} page(s), {len(imgs)} image(s)"}
                else:
                    res, imgs = _run_search(json.dumps(block.input or {}), searcher)
                    yield {"type": "tool_call", "name": "search_documents",
                           "args": str((block.input or {}).get("query", "")),
                           "ok": True, "result": f"{res['n']} passage(s), {len(imgs)} new page(s)"}
                # Anthropic tool_result may carry image blocks directly (vision only).
                content_blocks: list = [{"type": "text", "text": res["text"]}]
                for p in (imgs if vision else []):
                    content_blocks.append({"type": "image", "source": {
                        "type": "base64", "media_type": "image/jpeg",
                        "data": _image_jpeg_b64(p, config.VISION_MAX_DIM)}})
                tool_results.append({"type": "tool_result", "tool_use_id": block.id,
                                     "content": content_blocks})
            else:
                out = _run_calc(block.name, json.dumps(block.input or {}), calculations)
                if block.name == "calculate" and calculations:
                    last = calculations[-1]
                    yield {"type": "tool_call", "name": "calculate", "args": last["expression"],
                           "ok": last["ok"], "result": last["result"] or last["error"]}
                tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": out})
        messages.append({"role": "user", "content": tool_results})

    # Ran out of tool rounds without a final answer — force one more turn with
    # tools disabled so the user always gets a rendered response.
    if pending:
        with client.messages.stream(
            model=model, max_tokens=config.ANTHROPIC_MAX_TOKENS, system=system,
            messages=messages, tools=tools, tool_choice={"type": "none"},
        ) as stream:
            for text in stream.text_stream:
                content_all.append(text)
                yield {"type": "delta", "text": text}
            fin = stream.get_final_message()
        u = getattr(fin, "usage", None)
        if u:
            usage_tot["prompt"] += getattr(u, "input_tokens", 0) or 0
            usage_tot["completion"] += getattr(u, "output_tokens", 0) or 0
            usage_tot["total"] = usage_tot["prompt"] + usage_tot["completion"]

    yield {"type": "final", "text": "".join(content_all), "latency": time.time() - t0,
           "n_images": len(image_paths), "usage": usage_tot, "calculations": calculations}


# ---- Bedrock Converse path (Claude on bedrock-runtime) ----------------------
# Claude is NOT on the OpenAI-compatible mantle gateway, so it uses boto3's
# Converse API. Same tool loop as the other paths, in Converse's wire format
# (content blocks, toolUse/toolResult, converse_stream events). Page images ride
# in the user turn and in tool results (Converse allows image blocks in both).
# NOTE: not exercised against a live account here — verify when you first run it.

def _converse_tool(t: dict) -> dict:
    """Convert a Chat-Completions tool spec to a Converse toolSpec."""
    f = t["function"]
    return {"toolSpec": {"name": f["name"], "description": f["description"],
                         "inputSchema": {"json": f["parameters"]}}}


def _converse_image_block(path: str) -> dict:
    return {"image": {"format": "jpeg",
                      "source": {"bytes": base64.b64decode(_image_jpeg_b64(path, config.VISION_MAX_DIM))}}}


def _build_converse_user_content(question, contexts, image_paths, history, vision, note="") -> list:
    if not vision:
        image_paths = []
    blocks: list = [{"text": _user_text(question, contexts, history, bool(image_paths), note)}]
    for p in image_paths:
        blocks.append(_converse_image_block(p))
    return blocks


def _answer_stream_bedrock_converse(question: str, contexts: list[dict], image_paths: list[str],
                                    history: list[dict] | None, think: bool, model: str,
                                    searcher=None, pager=None, vision: bool = True, note: str = ""):
    import json
    import time
    if not vision:
        image_paths = []
    client = _bedrock_runtime_client()
    model_id = config.bedrock_model_id(model)
    system = [{"text": _system_prompt(think, vision)}]
    tool_config = {"tools": [_converse_tool(CALC_TOOL)]
                   + ([_converse_tool(SEARCH_TOOL)] if searcher else [])
                   + ([_converse_tool(GET_PAGES_TOOL)] if pager else [])}
    inference: dict = {"maxTokens": config.ANTHROPIC_MAX_TOKENS}
    if config.VISION_TEMPERATURE is not None:
        inference["temperature"] = config.VISION_TEMPERATURE

    messages: list = []
    for h in (history or []):
        messages.append({"role": h["role"], "content": [{"text": h["content"]}]})
    messages.append({"role": "user",
                     "content": _build_converse_user_content(question, contexts, image_paths, history, vision, note=note)})

    t0 = time.time()
    content_all: list = []
    calculations: list = []
    usage_tot = _new_usage()
    pending = False

    def _accumulate_usage(usage):
        if not usage:
            return
        usage_tot["prompt"] += usage.get("inputTokens", 0) or 0
        usage_tot["completion"] += usage.get("outputTokens", 0) or 0
        usage_tot["total"] = usage_tot["prompt"] + usage_tot["completion"]

    def _tool_result_blocks(out: dict, imgs: list) -> list:
        blocks: list = [{"text": out["text"]}]
        for p in (imgs if vision else []):
            blocks.append(_converse_image_block(p))
        return blocks

    for _ in range(_MAX_TOOL_ROUNDS):
        resp = client.converse_stream(modelId=model_id, system=system, messages=messages,
                                      toolConfig=tool_config, inferenceConfig=inference)
        text_parts: list = []
        tool_uses: dict = {}     # contentBlockIndex -> {toolUseId, name, input_str}
        stop_reason = None
        for event in resp["stream"]:
            if "contentBlockStart" in event:
                cbs = event["contentBlockStart"]
                start = cbs.get("start", {})
                if "toolUse" in start:
                    tu = start["toolUse"]
                    tool_uses[cbs["contentBlockIndex"]] = {"toolUseId": tu["toolUseId"],
                                                           "name": tu["name"], "input_str": ""}
            elif "contentBlockDelta" in event:
                cbd = event["contentBlockDelta"]
                delta = cbd.get("delta", {})
                if "text" in delta:
                    txt = delta["text"]
                    text_parts.append(txt)
                    content_all.append(txt)
                    yield {"type": "delta", "text": txt}
                elif "toolUse" in delta and cbd["contentBlockIndex"] in tool_uses:
                    tool_uses[cbd["contentBlockIndex"]]["input_str"] += delta["toolUse"].get("input", "")
            elif "messageStop" in event:
                stop_reason = event["messageStop"].get("stopReason")
            elif "metadata" in event:
                _accumulate_usage(event["metadata"].get("usage"))

        if not tool_uses or stop_reason != "tool_use":
            pending = False
            break
        pending = True

        # Echo the assistant turn (text + toolUse blocks), then answer the tools.
        assistant_blocks: list = []
        if "".join(text_parts).strip():
            assistant_blocks.append({"text": "".join(text_parts)})
        parsed: list = []
        for idx in sorted(tool_uses):
            tu = tool_uses[idx]
            try:
                args_obj = json.loads(tu["input_str"] or "{}")
            except Exception:
                args_obj = {}
            assistant_blocks.append({"toolUse": {"toolUseId": tu["toolUseId"],
                                                 "name": tu["name"], "input": args_obj}})
            parsed.append((tu, args_obj))
        messages.append({"role": "assistant", "content": assistant_blocks})

        tool_results: list = []
        for tu, args_obj in parsed:
            name, tuid, args_json = tu["name"], tu["toolUseId"], json.dumps(args_obj)
            if name == "search_documents" and searcher:
                out, imgs = _run_search(args_json, searcher)
                yield {"type": "tool_call", "name": "search_documents", "args": _search_query(args_json),
                       "ok": True, "result": f"{out['n']} passage(s), {len(imgs)} new page(s)"}
                tool_results.append({"toolResult": {"toolUseId": tuid, "content": _tool_result_blocks(out, imgs)}})
            elif name == "get_pages" and pager:
                out, imgs = _run_get_pages(args_json, pager)
                yield {"type": "tool_call", "name": "get_pages", "args": _pages_summary(args_json),
                       "ok": True, "result": f"{out['n']} page(s), {len(imgs)} image(s)"}
                tool_results.append({"toolResult": {"toolUseId": tuid, "content": _tool_result_blocks(out, imgs)}})
            else:
                res = _run_calc(name, args_json, calculations)
                if name == "calculate" and calculations:
                    last = calculations[-1]
                    yield {"type": "tool_call", "name": "calculate", "args": last["expression"],
                           "ok": last["ok"], "result": last["result"] or last["error"]}
                tool_results.append({"toolResult": {"toolUseId": tuid, "content": [{"text": res}]}})
        messages.append({"role": "user", "content": tool_results})

    # Ran out of rounds still wanting tools — force a final, tool-free answer.
    if pending:
        messages.append({"role": "user", "content": [{"text":
            "Stop calling tools. Using the values you already have, write your complete "
            "final answer now in prose. Do NOT call any tool."}]})
        resp = client.converse_stream(modelId=model_id, system=system, messages=messages,
                                      inferenceConfig=inference)
        for event in resp["stream"]:
            if "contentBlockDelta" in event:
                delta = event["contentBlockDelta"].get("delta", {})
                if "text" in delta:
                    txt = delta["text"]
                    content_all.append(txt)
                    yield {"type": "delta", "text": txt}
            elif "metadata" in event:
                _accumulate_usage(event["metadata"].get("usage"))

    yield {"type": "final", "text": "".join(content_all), "latency": time.time() - t0,
           "n_images": len(image_paths), "usage": usage_tot, "calculations": calculations}
