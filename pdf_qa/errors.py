"""Crash & error reporting for the backend via Sentry.

Mirrors the desktop side (app/src/errors.ts). The Electron main process passes
``PDF_QA_SENTRY_DSN`` / ``PDF_QA_SENTRY_RELEASE`` / ``PDF_QA_SENTRY_ENV`` into
our environment *only* when a DSN is configured and the user has not opted out
of analytics, so simply honouring those vars keeps the backend silent in exactly
the same cases as the UI. ``SENTRY_DSN`` is also accepted for bare CLI use.

Everything here is best-effort: a missing ``sentry_sdk`` or a bad DSN must never
stop the backend from serving. ``sentry_sdk.init`` installs ``sys.excepthook``
(and a ``threading.excepthook``) on its own, so uncaught exceptions in serve /
ingest are reported automatically; ``capture_exception`` is for the handled
errors we would otherwise swallow.

Logs: the backend writes diagnostics to stderr, which the Electron main process
reads and streams to Sentry Logs — so we do NOT enable log streaming here (it
would double up). Instead we tee stderr into a small ring buffer and attach the
recent lines to our *own* error events, since those are sent straight from this
process and would otherwise have no surrounding log context.
"""
from __future__ import annotations

import os
import re
import sys
from collections import deque

_started = False

# Recent stderr lines, attached to error events for context. Bounded.
_MAX_LOG_LINES = 200
_ATTACH_MAX_CHARS = 16000
_recent: deque[str] = deque(maxlen=_MAX_LOG_LINES)

# Best-effort redaction of secrets before any log text leaves the machine. File
# names/paths are intentionally kept (they make logs useful); the Settings copy
# discloses that diagnostic logs may include them.
_SECRET_RE = re.compile(
    r"(sk-ant-[A-Za-z0-9_-]{6,}|sk-[A-Za-z0-9_-]{6,}|Bearer\s+[A-Za-z0-9._-]{8,}|AKIA[0-9A-Z]{12,})"
)


def _redact(s: str) -> str:
    return _SECRET_RE.sub("[redacted]", s)


class _TeeStderr:
    """Wrap the real stderr, copying complete lines into the ring buffer. Pure
    pass-through otherwise — never swallows or reorders output."""

    def __init__(self, real):
        self._real = real
        self._partial = ""

    def write(self, s):
        n = self._real.write(s)
        try:
            self._partial += s
            while "\n" in self._partial:
                line, self._partial = self._partial.split("\n", 1)
                if line.strip():
                    _recent.append(_redact(line))
        except Exception:
            pass
        return n

    def flush(self):
        self._real.flush()

    def __getattr__(self, name):
        return getattr(self._real, name)


def init_error_reporting() -> None:
    """Initialise Sentry from the environment. No-op without a DSN."""
    global _started
    if _started:
        return
    dsn = os.getenv("PDF_QA_SENTRY_DSN") or os.getenv("SENTRY_DSN") or ""
    if not dsn:
        return
    try:
        import sentry_sdk
    except Exception:  # SDK not installed (e.g. minimal env) — stay silent
        return
    try:
        sentry_sdk.init(
            dsn=dsn,
            release=os.getenv("PDF_QA_SENTRY_RELEASE") or None,
            environment=os.getenv("PDF_QA_SENTRY_ENV") or "production",
            # No PII: never attach usernames, IPs or request bodies.
            send_default_pii=False,
            # Crucial: by default the Python SDK attaches every stack frame's
            # local variables, which here would include questions, answer text,
            # retrieved PDF chunks and file paths. Strip them so a traceback
            # carries only file/line/function — never document content.
            include_local_variables=False,
            # Release-health sessions are left off to match the desktop side and
            # keep the opt-out airtight.
            auto_session_tracking=False,
            # Raise the value cap so the attached recent-log tail isn't truncated
            # to the 1024-char default.
            max_value_length=20000,
            before_send=_before_send,
        )
        # Start buffering stderr only once Sentry is live (and only if not
        # already wrapped, so a second init can't stack tees).
        if not isinstance(sys.stderr, _TeeStderr):
            sys.stderr = _TeeStderr(sys.stderr)
        _started = True
    except Exception:  # never let reporting break startup
        pass


def _before_send(event, hint):
    """Drop the machine hostname and attach the recent stderr tail. Stack frames
    are kept (that's the point)."""
    event.pop("server_name", None)
    if _recent:
        tail = "\n".join(_recent)[-_ATTACH_MAX_CHARS:]
        event.setdefault("extra", {})["recent_logs"] = tail
    return event


def capture_exception(e: BaseException) -> None:
    """Report a handled exception we'd otherwise swallow. No-op unless init'd."""
    if not _started:
        return
    try:
        import sentry_sdk
        sentry_sdk.capture_exception(e)
    except Exception:
        pass
