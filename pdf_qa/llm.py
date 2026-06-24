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


def _local_client():
    from openai import OpenAI
    if not config.LOCAL_BASE_URL:
        raise RuntimeError(
            "LOCAL_BASE_URL is not set. Point it at your local server (e.g. "
            "http://localhost:11434/v1 for Ollama) and set LOCAL_MODEL, or pick a "
            "different model in the UI."
        )
    return OpenAI(api_key=config.LOCAL_API_KEY or "local", base_url=config.LOCAL_BASE_URL)


def _chat_client(spec: dict | None = None):
    """OpenAI-compatible client for chat/vision/title calls. A "local" spec points
    at LOCAL_BASE_URL; otherwise routes through OpenRouter when enabled, else the
    direct OpenAI API. (Embeddings always use the direct OpenAI client via
    _client() — neither OpenRouter nor local servers serve our embedding model.)"""
    if spec and spec.get("provider") == "local":
        return _local_client()
    if spec and spec.get("direct"):
        return _client()   # force direct OpenAI even when OpenRouter is globally on
    if config.USE_OPENROUTER:
        from openai import OpenAI
        if not config.OPENROUTER_API_KEY:
            raise RuntimeError(
                "OPENROUTER_API_KEY is not set. Add it in Settings or .env, or set "
                "USE_OPENROUTER=false to use the providers directly."
            )
        return OpenAI(api_key=config.OPENROUTER_API_KEY, base_url=config.OPENROUTER_BASE_URL,
                      default_headers={"HTTP-Referer": "https://github.com/pdf_qa",
                                       "X-Title": "pdf_qa"})
    return _client()


def _chat_model_id(spec: dict) -> str:
    """The model id to send on chat calls: OpenRouter slug when routing through
    OpenRouter, else the provider-native id."""
    return spec["openrouter"] if config.USE_OPENROUTER else spec["model"]


def embed_texts(texts: list[str]) -> np.ndarray:
    """Embed a list of texts, batching to stay within request limits."""
    client = _client()
    out: list[list[float]] = []
    for i in range(0, len(texts), config.EMBED_BATCH):
        batch = texts[i : i + config.EMBED_BATCH]
        resp = client.embeddings.create(model=config.EMBED_MODEL, input=batch)
        out.extend([d.embedding for d in resp.data])
    return np.asarray(out, dtype=np.float32)


def embed_query(text: str) -> np.ndarray:
    return embed_texts([text])[0]


_TITLE_SYSTEM = (
    "You write a very short title for a chat conversation. Reply with 3 to 6 words, "
    "Title Case, describing the topic. No quotes, no trailing punctuation, no prefix "
    "like 'Title:'. Just the title."
)


def summarize_title(question: str, answer: str) -> str:
    """Summarise the first exchange into a short thread title using the small,
    cheap SUMMARY_MODEL. Best-effort: returns "" on any failure so the caller can
    fall back to a placeholder."""
    client = _chat_client()
    model = f"openai/{config.SUMMARY_MODEL}" if config.USE_OPENROUTER else config.SUMMARY_MODEL
    convo = f"User: {question.strip()[:800]}\n\nAssistant: {answer.strip()[:800]}"
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
    "ask for clarification rather than assume.\n"
    "• If a parameter the user gave is ambiguous or a question is unclear, ask a "
    "clarifying question instead of guessing what they meant.\n"
    "• Cite sources inline as (filename p.N) for every claim.\n"
    "CALCULATIONS — THIS IS MANDATORY AND NON-NEGOTIABLE:\n"
    "• Use the `calculate` tool for EVERY single piece of arithmetic, no matter how "
    "trivial — additions, subtractions, multiplications, divisions, powers, roots, logs, "
    "unit conversions, percentages, averages, ratios, interpolation between graph points, "
    "everything. If a number in your answer is the result of ANY computation, it MUST "
    "come from a `calculate` call. NEVER do arithmetic in your head, and never write a "
    "computed number that you did not get from the tool.\n"
    "• Prefer MORE tool calls over fewer: break a multi-step calculation into one "
    "`calculate` call per step rather than computing several operations at once, so each "
    "intermediate value is independently tool-verified. When in doubt, call the tool.\n"
    "• ALWAYS SHOW every calculation explicitly in your answer: state the formula, "
    "substitute the actual numbers, and write the exact value the tool returned (with "
    "units). Never hide a calculation or present only the final number.\n"
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


THINK_INSTRUCTION = (
    "\n\nBefore answering, reason step by step inside <thinking>...</thinking> tags: "
    "describe what you see in the page images (curve shapes, axis values, schematic "
    "nodes), which equations apply, and any calculation you do. After the closing "
    "</thinking> tag, give the final answer for the user."
)


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


def _build_messages(question, contexts, image_paths, history, think) -> list[dict]:
    text_block = "\n\n".join(
        f"[Passage {i+1}] ({c['doc']} p.{c['page']})\n{c['text']}"
        for i, c in enumerate(contexts)
    )
    content: list[dict] = [
        {"type": "text",
         "text": f"Question: {question}\n\nRetrieved passages:\n{text_block}\n\n"
                 f"{_followup_note(history, bool(image_paths))}"}
    ]
    for p in image_paths:
        content.append({"type": "image_url",
                        "image_url": {"url": _image_data_url(p, config.VISION_MAX_DIM)}})

    system = SYSTEM_PROMPT + (THINK_INSTRUCTION if think else "")
    messages = [{"role": "system", "content": system}]
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


def extract_inline_tool_calls(text: str) -> tuple[str, list]:
    """Some models emit tool calls as inline `<tool_call>{json}</tool_call>` text
    instead of through the tool API, which would otherwise leak into the answer.

    Strip every such block from the visible answer and, for `calculate`-style
    payloads ({"expression": "...", "units": bool}), actually run the calculation
    so it still appears in the verified-calculations panel. Returns
    (clean_text, calcs) where each calc matches the {expression, ok, result,
    error} shape used elsewhere. A trailing unclosed <tool_call> (mid-stream) is
    dropped too.
    """
    import json
    import re
    from . import calc
    calcs: list = []

    def _run(m) -> str:
        raw = m.group(1).strip()
        try:
            payload = json.loads(raw)
        except Exception:
            return ""   # not JSON we understand — just remove the markup
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


def _chat_kwargs(model: str | None = None) -> dict:
    """Shared chat-completion kwargs; temperature omitted when unset or when the
    target model rejects it (reasoning / gpt-5.x models)."""
    m = model or config.VISION_MODEL
    kw: dict = {"model": m}
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
                  model: str | None = None, searcher=None, pager=None):
    """Streaming answer generator with the calculate + search + get_pages loop.

    `model` is a UI model id (see config.MODELS); it selects the provider.
    `searcher(query, k)` retrieves more pages by relevance; `pager(doc, pages,
    context)` fetches specific pages by number. Both return {"contexts":[...],
    "images":[paths]} and let the model read more pages mid-answer. Yields
    {"type":"delta","text"}, {"type":"tool_call","name","args","ok","result"} per
    tool use, then {"type":"final","text","usage","calculations",...}.
    """
    spec = config.resolve_model(model)
    # Local CLI models run on the machine (no API) — handle before any remote path.
    if spec["provider"] == "cli":
        yield from _answer_stream_cli(question, contexts, image_paths, history, think, spec["model"])
        return
    # Local OpenAI-compatible server: same streaming path as remote OpenAI, but the
    # client points at LOCAL_BASE_URL and we send the server's native model id
    # (OpenRouter routing never applies to a local model).
    if spec["provider"] == "local":
        yield from _answer_stream_openai(question, contexts, image_paths, history,
                                         think, spec["model"], searcher, pager, spec=spec)
        return
    # Direct-to-OpenAI override: send the native model id straight to OpenAI,
    # skipping OpenRouter even when it's globally enabled.
    if spec.get("direct"):
        yield from _answer_stream_openai(question, contexts, image_paths, history,
                                         think, spec["model"], searcher, pager, spec=spec)
        return
    # When OpenRouter is on, everything (incl. Claude) goes through the OpenAI-
    # compatible path; otherwise Anthropic uses its native SDK path.
    if not config.USE_OPENROUTER and spec["provider"] == "anthropic":
        yield from _answer_stream_anthropic(question, contexts, image_paths,
                                            history, think, spec["model"], searcher, pager)
    else:
        yield from _answer_stream_openai(question, contexts, image_paths,
                                         history, think, _chat_model_id(spec), searcher, pager)


def _answer_stream_openai(question: str, contexts: list[dict], image_paths: list[str],
                          history: list[dict] | None, think: bool, model: str,
                          searcher=None, pager=None, spec: dict | None = None):
    import time
    client = _chat_client(spec)
    messages = _build_messages(question, contexts, image_paths, history, think)
    tools = [CALC_TOOL] + ([SEARCH_TOOL] if searcher else []) + ([GET_PAGES_TOOL] if pager else [])
    t0 = time.time()
    content_all: list = []
    calculations: list = []
    usage_tot = _new_usage()
    pending = False   # last round still wanted tools but we ran out of rounds
    tools_ok = bool(tools)   # some local (Ollama) vision models reject `tools` — drop them on first failure

    def _open_stream(tool_choice: str | None = None):
        """Start a chat stream, gracefully degrading if the server can't do tools.
        Local vision models often 400 with 'does not support tools'; in that case we
        retry without tools (the calculate/search tools just go unused)."""
        nonlocal tools_ok
        kw = dict(messages=messages, stream=True,
                  stream_options={"include_usage": True}, **_chat_kwargs(model))
        if tools_ok and tools:
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

    for _ in range(_MAX_TOOL_ROUNDS):
        stream = _open_stream()
        round_content: list = []
        tool_calls: dict = {}
        for chunk in stream:
            _add_usage(usage_tot, getattr(chunk, "usage", None))
            if not chunk.choices:
                continue
            d = chunk.choices[0].delta
            c = getattr(d, "content", None)
            if c:
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

        if not tool_calls:
            pending = False
            break
        pending = True
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
        if new_images:   # OpenAI: images can't ride in tool results, so add a user turn
            content = [{"type": "text", "text": "Additional page images you requested:"}]
            for p in new_images:
                content.append({"type": "image_url",
                                "image_url": {"url": _image_data_url(p, config.VISION_MAX_DIM)}})
            messages.append({"role": "user", "content": content})

    # If the model kept calling tools until the round budget ran out, it never
    # produced a final answer — force one more turn with tools disabled so the
    # user always gets a rendered response (not just the tool-call trace).
    if pending:
        stream = _open_stream(tool_choice="none")
        for chunk in stream:
            _add_usage(usage_tot, getattr(chunk, "usage", None))
            if not chunk.choices:
                continue
            c = getattr(chunk.choices[0].delta, "content", None)
            if c:
                content_all.append(c)
                yield {"type": "delta", "text": c}

    yield {"type": "final", "text": "".join(content_all), "latency": time.time() - t0,
           "n_images": len(image_paths), "usage": usage_tot, "calculations": calculations}


# ---- Local CLI path (claude -p) ---------------------------------------------

def _answer_stream_cli(question: str, contexts: list[dict], image_paths: list[str],
                       history: list[dict] | None, think: bool, model: str):
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
              f"Question: {question}")

    args = [binname, "-p", "--append-system-prompt", SYSTEM_PROMPT]
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

def _build_anthropic_messages(question, contexts, image_paths, history) -> list[dict]:
    """Anthropic puts the system prompt in its own parameter and uses content
    blocks with base64 image sources, so we build messages separately from the
    OpenAI path (the prompt text and tool are shared)."""
    text_block = "\n\n".join(
        f"[Passage {i+1}] ({c['doc']} p.{c['page']})\n{c['text']}"
        for i, c in enumerate(contexts)
    )
    content: list[dict] = [
        {"type": "text",
         "text": f"Question: {question}\n\nRetrieved passages:\n{text_block}\n\n"
                 f"{_followup_note(history, bool(image_paths))}"}
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
                             searcher=None, pager=None):
    import json
    import time
    client = _anthropic_client()
    messages = _build_anthropic_messages(question, contexts, image_paths, history)
    system = SYSTEM_PROMPT + (THINK_INSTRUCTION if think else "")
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
                # Anthropic tool_result may carry image blocks directly.
                content_blocks: list = [{"type": "text", "text": res["text"]}]
                for p in imgs:
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
