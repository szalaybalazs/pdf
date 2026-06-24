"""Deterministic math engine for the `calculate` tool.

The LLM is good at choosing the right formula and substituting values, but
unreliable at the actual arithmetic. So all numbers are computed here, exactly,
with SymPy (math) and pint (units) — never by the model.

evaluate("10*log10(50)")          -> {'ok': True, 'value': 16.9897..., 'text': '16.9897'}
evaluate("sqrt(8*2)")             -> {'ok': True, 'value': 4.0, 'text': '4'}
evaluate("sqrt(2*W*8*ohm)", units=True) -> result carries volts
"""
from __future__ import annotations

import re

# Common unit tokens that signal we should try the unit-aware (pint) path.
_UNIT_HINT = re.compile(
    r"\b(ohm|volt|V|W|watt|A|amp|ampere|Hz|hertz|kHz|MHz|F|farad|H|henry|"
    r"dB|dBm|dBV|mA|uA|kV|mV|mW|kW|pF|nF|uF|mH|uH|kohm|Mohm)\b")


def _sympy_funcs() -> dict:
    import sympy as sp
    return {
        "log10": lambda x: sp.log(x, 10),
        "log2": lambda x: sp.log(x, 2),
        "ln": sp.log, "log": sp.log, "sqrt": sp.sqrt,
        "sin": sp.sin, "cos": sp.cos, "tan": sp.tan,
        "asin": sp.asin, "acos": sp.acos, "atan": sp.atan, "atan2": sp.atan2,
        "exp": sp.exp, "pi": sp.pi, "e": sp.E, "Abs": sp.Abs, "abs": sp.Abs,
    }


def _fmt(x: float) -> str:
    if x == int(x) and abs(x) < 1e15:
        return str(int(x))
    return f"{x:.6g}"


def _desqrt(s: str) -> str:
    """Rewrite sqrt(...) as (...)**0.5 (pint has no sqrt function)."""
    while "sqrt(" in s:
        i = s.index("sqrt(")
        j = i + 4              # index of '('
        depth, k = 0, j
        while k < len(s):
            if s[k] == "(":
                depth += 1
            elif s[k] == ")":
                depth -= 1
                if depth == 0:
                    break
            k += 1
        s = s[:i] + "(" + s[j:k + 1] + "**0.5)" + s[k + 1:]
    return s


def _eval_units(expr: str) -> dict | None:
    """Unit-aware evaluation via pint. Returns None if it can't handle it."""
    try:
        import pint
    except Exception:
        return None
    try:
        ureg = pint.UnitRegistry()
        val = ureg.parse_expression(_desqrt(expr.replace("^", "**")))
        mag = getattr(val, "magnitude", val)
        units = str(getattr(val, "units", "")) or "dimensionless"
        return {"ok": True, "value": float(mag), "text": f"{_fmt(float(mag))} {units}".strip(),
                "units": units}
    except Exception:
        return None


def evaluate(expression: str, units: bool = False) -> dict:
    """Evaluate a math expression exactly. Returns {ok, value, text[, units]} or {ok:False, error}."""
    expr = (expression or "").strip()
    if not expr:
        return {"ok": False, "error": "empty expression"}

    if units or _UNIT_HINT.search(expr):
        res = _eval_units(expr)
        if res is not None:
            return res
        # fall through to plain math if pint couldn't parse (e.g. has log10)

    try:
        import sympy as sp
        e = sp.sympify(expr, locals=_sympy_funcs(), evaluate=True)
        v = sp.N(e, 12)
        if v.free_symbols:
            return {"ok": False, "error": f"unresolved symbols: {', '.join(map(str, v.free_symbols))}"}
        fv = float(v)
        return {"ok": True, "value": fv, "text": _fmt(fv)}
    except Exception as e:  # noqa: BLE001
        return {"ok": False, "error": f"{type(e).__name__}: {e}"}
