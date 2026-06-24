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
    "Use BOTH. When a question depends on a chart, schematic, table or equation, READ "
    "IT DIRECTLY from the page image — trace curves, read axis values, apply formulas.\n"
    "YOU ARE EXPECTED TO DO THE MATH. If the documents give an equation, method, graph "
    "or worked example, APPLY it to the user's specific numbers and compute the answer "
    "yourself — even when that exact value is not printed in the text. Substitute into "
    "the equation, show each step and the numbers used, and give the final result with "
    "units. Reading a value off a graph or interpolating between plotted points is "
    "expected and encouraged. Treat a question like 'what about 50?' as a request to "
    "re-evaluate the documented formula at that input, not as a lookup.\n"
    "Only state that the answer cannot be determined if the documents provide NEITHER "
    "the data NOR a method/equation to derive it — and then say exactly what is missing. "
    "Cite sources inline as (filename p.N).\n"
    "CALCULATIONS: For EVERY arithmetic operation (powers, logs, roots, division, etc.) "
    "you MUST call the `calculate` tool and use its exact returned value — never compute "
    "in your head. Whenever you calculate, SHOW THE CALCULATION explicitly in your "
    "answer: state the formula, substitute the numbers, and write the exact value the "
    "tool returned. Then VERIFY it: confirm the result is sound — check that the units "
    "are right and the magnitude is sensible, and where possible plug the value back "
    "into the relation to confirm it holds. Present every number exactly as the tool "
    "returned it so it can be checked.\n"
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


def _build_messages(question, contexts, image_paths, history, think) -> list[dict]:
    text_block = "\n\n".join(
        f"[Passage {i+1}] ({c['doc']} p.{c['page']})\n{c['text']}"
        for i, c in enumerate(contexts)
    )
    content: list[dict] = [
        {"type": "text",
         "text": f"Question: {question}\n\nRetrieved passages:\n{text_block}\n\n"
                 f"Document page images follow. Answer using the passages and by "
                 f"reading the page images."}
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

    Handles the mid-stream case where <thinking> is open but not yet closed.
    """
    import re
    m = re.search(r"<thinking>(.*?)</thinking>(.*)", text, re.S)
    if m:
        return m.group(1).strip(), m.group(2).strip()
    m = re.search(r"<thinking>(.*)", text, re.S)
    if m:
        return m.group(1).strip(), ""
    return "", text.strip()


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


def _chat_kwargs(model: str | None = None) -> dict:
    """Shared chat-completion kwargs; temperature omitted when unset (for reasoning models)."""
    kw: dict = {"model": model or config.VISION_MODEL}
    if config.VISION_TEMPERATURE is not None:
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

_MAX_TOOL_ROUNDS = 8


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
    client = _client()
    messages = _build_messages(question, contexts, image_paths, history, think)
    t0 = time.time()
    calculations: list = []
    usage_tot = _new_usage()
    for _ in range(_MAX_TOOL_ROUNDS):
        resp = client.chat.completions.create(messages=messages, tools=[CALC_TOOL], **_chat_kwargs())
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
        return {"text": msg.content, "model": config.VISION_MODEL,
                "latency": time.time() - t0, "n_images": len(image_paths),
                "usage": usage_tot, "calculations": calculations}
    return {"text": "(calculation loop did not converge)", "model": config.VISION_MODEL,
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


def answer_stream(question: str, contexts: list[dict], image_paths: list[str],
                  history: list[dict] | None = None, think: bool = True,
                  model: str | None = None):
    """Streaming answer generator with the calculate tool loop.

    `model` is a UI model id (see config.MODELS); it selects the provider. Yields
    {"type":"delta","text"}, {"type":"tool_call","name","args","ok","result"} for
    each calculation, then {"type":"final","text","usage","calculations",...}.
    """
    spec = config.resolve_model(model)
    if spec["provider"] == "anthropic":
        yield from _answer_stream_anthropic(question, contexts, image_paths,
                                            history, think, spec["model"])
    else:
        yield from _answer_stream_openai(question, contexts, image_paths,
                                         history, think, spec["model"])


def _answer_stream_openai(question: str, contexts: list[dict], image_paths: list[str],
                          history: list[dict] | None, think: bool, model: str):
    import time
    client = _client()
    messages = _build_messages(question, contexts, image_paths, history, think)
    t0 = time.time()
    content_all: list = []
    calculations: list = []
    usage_tot = _new_usage()

    for _ in range(_MAX_TOOL_ROUNDS):
        stream = client.chat.completions.create(
            messages=messages, tools=[CALC_TOOL], stream=True,
            stream_options={"include_usage": True}, **_chat_kwargs(model))
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
            break
        # record the assistant turn that requested the tools, then run them
        messages.append({"role": "assistant", "content": "".join(round_content) or None,
                         "tool_calls": [{"id": tool_calls[i]["id"] or f"call_{i}", "type": "function",
                                         "function": {"name": tool_calls[i]["name"],
                                                      "arguments": tool_calls[i]["args"] or "{}"}}
                                        for i in sorted(tool_calls)]})
        for i in sorted(tool_calls):
            c = tool_calls[i]
            cid = c["id"] or f"call_{i}"
            out = _run_calc(c["name"], c["args"], calculations)
            if c["name"] == "calculate" and calculations:
                last = calculations[-1]
                yield {"type": "tool_call", "name": "calculate", "args": last["expression"],
                       "ok": last["ok"], "result": last["result"] or last["error"]}
            messages.append({"role": "tool", "tool_call_id": cid, "content": out})

    yield {"type": "final", "text": "".join(content_all), "latency": time.time() - t0,
           "n_images": len(image_paths), "usage": usage_tot, "calculations": calculations}


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
                 f"Document page images follow. Answer using the passages and by "
                 f"reading the page images."}
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
                             history: list[dict] | None, think: bool, model: str):
    import json
    import time
    client = _anthropic_client()
    messages = _build_anthropic_messages(question, contexts, image_paths, history)
    system = SYSTEM_PROMPT + (THINK_INSTRUCTION if think else "")
    t0 = time.time()
    content_all: list = []
    calculations: list = []
    usage_tot = _new_usage()

    for _ in range(_MAX_TOOL_ROUNDS):
        with client.messages.stream(
            model=model, max_tokens=config.ANTHROPIC_MAX_TOKENS, system=system,
            messages=messages, tools=[ANTHROPIC_CALC_TOOL],
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
            break

        messages.append({"role": "assistant", "content": assistant_content})
        tool_results: list = []
        for block in tool_uses:
            out = _run_calc(block.name, json.dumps(block.input or {}), calculations)
            if block.name == "calculate" and calculations:
                last = calculations[-1]
                yield {"type": "tool_call", "name": "calculate", "args": last["expression"],
                       "ok": last["ok"], "result": last["result"] or last["error"]}
            tool_results.append({"type": "tool_result", "tool_use_id": block.id, "content": out})
        messages.append({"role": "user", "content": tool_results})

    yield {"type": "final", "text": "".join(content_all), "latency": time.time() - t0,
           "n_images": len(image_paths), "usage": usage_tot, "calculations": calculations}
