"""Terminal UI helpers: ANSI colors + a Claude Code-style tool-call trace.

Dependency-free. Colors auto-disable when stdout isn't a TTY or NO_COLOR is set,
so piping/redirecting still produces clean text.
"""
from __future__ import annotations

import os
import sys
import time

_ENABLED = sys.stdout.isatty() and os.getenv("NO_COLOR") is None

_CODES = {
    "reset": "\033[0m", "bold": "\033[1m", "dim": "\033[2m", "italic": "\033[3m",
    "black": "\033[30m", "red": "\033[31m", "green": "\033[32m", "yellow": "\033[33m",
    "blue": "\033[34m", "magenta": "\033[35m", "cyan": "\033[36m", "white": "\033[37m",
    "gray": "\033[90m", "brightgreen": "\033[92m", "brightcyan": "\033[96m",
}


def c(text: str, *styles: str) -> str:
    if not _ENABLED or not styles:
        return text
    pre = "".join(_CODES.get(s, "") for s in styles)
    return f"{pre}{text}{_CODES['reset']}"


# --- semantic shortcuts ------------------------------------------------------
def dim(t: str) -> str: return c(t, "gray")
def bold(t: str) -> str: return c(t, "bold")
def ok(t: str) -> str: return c(t, "green")
def err(t: str) -> str: return c(t, "red")
def accent(t: str) -> str: return c(t, "brightcyan")


def banner(title: str, subtitle: str = "") -> None:
    bar = "─" * max(len(title), len(subtitle), 20)
    print(c("┌─ ", "cyan") + bold(title))
    if subtitle:
        print(c("│  ", "cyan") + dim(subtitle))
    print(c("└" + bar, "cyan"))


def user_prompt() -> str:
    """The '> ' prompt, colored."""
    return c("› ", "brightcyan", "bold")


class ToolCall:
    """Render a step like Claude Code's tool calls:

        ⏺ search                                  0.04s
          ⎿ top 8 chunks from 2 docs

    Use as a context manager so timing is automatic. Add detail lines with .log().
    """
    def __init__(self, name: str, args: str = "", enabled: bool = True):
        self.name = name
        self.args = args
        self.enabled = enabled
        self._lines: list[str] = []
        self.t0 = 0.0

    def __enter__(self):
        self.t0 = time.time()
        return self

    def log(self, line: str):
        self._lines.append(line)
        return self

    def __exit__(self, exc_type, exc, tb):
        if not self.enabled:
            return False
        dt = time.time() - self.t0
        head = c("⏺ ", "brightgreen") + bold(self.name)
        if self.args:
            head += " " + dim(self.args)
        head += "  " + dim(f"{dt:0.2f}s")
        print(head)
        for i, ln in enumerate(self._lines):
            elbow = "  ⎿ " if i == 0 else "    "
            print(c(elbow, "gray") + dim(ln))
        return False  # never swallow exceptions
