#!/usr/bin/env python3
"""OpenAI-compatible endpoint backed by ONE persistent Claude Code session.

    python3 shim/claude_openai_shim.py

Any OpenAI client can then point at http://127.0.0.1:8080/v1 — the Discord
assistant for text, speech-to-speech for voice — and both continue the *same*
conversation, because the session lives here rather than in any client.

OpenAI-SHAPED BUT STATEFUL — a deliberate deviation from the spec:

  role            handling      why
  ------------    -----------   ----------------------------------------------
  system          pass through  per-request output rules (s2s sends voice rules:
                                "one spoken sentence, no markdown")
  latest user     the turn      the actual new input
  everything else DISCARD       the Claude Code session already has the history

Clients resend full history per the OpenAI spec. Appending that to a session
that already has it would double the context every turn and drift into a second,
divergent history. So we drop it — which is also what makes Telegram-to-Discord
continuity work: the session, not the transport, is the conversation.

Verified before writing this (2026-08-02): `claude -p` keeps skills, slash
commands, and MCP; `--session-id` then `--resume <uuid>` continues a
conversation across separate invocations.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

HOST = os.environ.get("SHIM_HOST", "127.0.0.1")
PORT = int(os.environ.get("SHIM_PORT", "8080"))
MODEL = os.environ.get("SHIM_MODEL", "claude-code")
CWD = os.environ.get("SHIM_CWD", str(Path.home() / "Documents/Obsidian/Personal"))
MCP_CONFIG = os.environ.get("SHIM_MCP_CONFIG", str(Path.home() / ".claude/mcp-obsidian-personal.json"))
TIMEOUT = int(os.environ.get("SHIM_TIMEOUT", "300"))
# One identity == one session. Persisted so a restart resumes rather than forgets.
SESSION_FILE = Path(os.environ.get("SHIM_SESSION_FILE", Path.home() / ".claude/shim-session-id"))

# Claude Code turns are serialized: one session cannot run two turns at once.
_turn_lock = Lock()
_session_started = SESSION_FILE.exists()


def session_id() -> str:
    global _session_started
    if SESSION_FILE.exists():
        return SESSION_FILE.read_text().strip()
    sid = str(uuid.uuid4())
    SESSION_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSION_FILE.write_text(sid)
    _session_started = False
    return sid


# A session carrying a personal CLAUDE.md follows *its* output rules — status
# panels, markdown, bullet lists — which are right for a terminal and unusable as
# speech. s2s's own voice prompt is advisory and loses to them, so the shim has
# to enforce. Belt (instruction) and braces (post-strip), because the model
# obeying the instruction is not guaranteed.
VOICE_DIRECTIVE = (
    "SPOKEN OUTPUT MODE. Your reply is read aloud by a speech synthesiser, not displayed. "
    "Reply in at most two short sentences of plain prose. "
    "This overrides any output-format rules in CLAUDE.md or memory: emit NO status panels, "
    "no lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, no 'You:' or 'Next:' lines, "
    "no markdown, no bullet lists, no headings, no code, no backticks, no emoji. "
    "Do not speak file paths, wikilinks, URLs or hashes — describe them in words. "
    "If the answer is long, say the single most important thing and offer to continue."
)

# Status-panel lines the closer convention produces; never speak these.
# Two patterns, deliberately narrow. "Recommend:" and "You ..." are also normal
# prose openings — stripping those on the keyword alone eats the actual answer,
# which is worse than speaking a stray panel line. So the ambiguous words are
# only dropped when they carry the panel's leading emoji AND a colon.
_PANEL = re.compile(
    r"^[^\w\n]{1,6}\s*(?:You|Next|Recommend)\s*:.*$"      # 👤 You: / ⏰ Next:
    r"|^[^\w\n]{0,6}\s*(?:\*\*)?(?:READY|DONE|ACTIVE|WAITING|BLOCKED)\b[^\n]*$",  # 🔵 READY — …
    re.M,
)


def strip_markdown(text: str) -> str:
    """Make model output safe to speak: no markup, no panels, no paths."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)      # code fences
    text = _PANEL.sub("", text)                              # closer panels
    text = re.sub(r"\[\[([^\]|]*\|)?([^\]]+)\]\]", r"\2", text)  # wikilinks -> label
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)     # md links -> label
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)     # bullets
    text = re.sub(r"[*_`#>|]+", "", text)                    # inline markup
    text = re.sub(r"https?://\S+", "a link", text)
    return re.sub(r"\s+", " ", text).strip()


def ask_claude(system: str, prompt: str) -> str:
    """Run one turn against the persistent session."""
    global _session_started
    sid = session_id()
    cmd = ["claude", "-p", prompt, "--output-format", "text",
           "--mcp-config", MCP_CONFIG, "--strict-mcp-config",
           "--permission-mode", "auto"]
    cmd += ["--resume", sid] if _session_started else ["--session-id", sid]
    if system:
        cmd += ["--append-system-prompt", system]

    started = time.monotonic()
    try:
        r = subprocess.run(cmd, cwd=CWD, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return f"(timed out after {TIMEOUT}s)"

    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()[:400]
        # A resume can fail if the session file was lost; fall back to a new one.
        if _session_started and "session" in err.lower():
            SESSION_FILE.unlink(missing_ok=True)
            _session_started = False
            print(f"  session resume failed, starting fresh: {err[:120]}")
            return ask_claude(system, prompt)
        print(f"  claude failed rc={r.returncode}: {err}")
        return f"(claude error: {err[:200]})"

    _session_started = True
    out = r.stdout.strip()
    print(f"  turn took {time.monotonic() - started:.1f}s, {len(out)} chars")
    return out


def extract(messages: list[dict]) -> tuple[str, str]:
    """system messages -> passed through; latest user message -> the turn."""
    system = "\n\n".join(
        c if isinstance(c := m.get("content"), str) else json.dumps(c)
        for m in messages if m.get("role") == "system"
    )
    users = [m for m in messages if m.get("role") == "user"]
    prompt = ""
    if users:
        c = users[-1].get("content")
        prompt = c if isinstance(c, str) else " ".join(
            p.get("text", "") for p in c if isinstance(p, dict))
    return system.strip(), prompt.strip()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):  # quiet: we log what matters ourselves
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path.rstrip("/").endswith("/models"):
            self._json(200, {"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "anthropic"}]})
        else:
            self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if "chat/completions" not in self.path:
            self._json(404, {"error": {"message": "not found"}})
            return
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except Exception as e:
            self._json(400, {"error": {"message": f"bad json: {e}"}})
            return

        system, prompt = extract(req.get("messages", []))
        if not prompt:
            self._json(400, {"error": {"message": "no user message"}})
            return

        # Voice clients (speech-to-speech) announce themselves via their system
        # prompt. Fall back to a header so any client can opt in explicitly.
        low = system.lower()
        voice = ("spoken conversation" in low or "voice rules" in low
                 or self.headers.get("X-Output-Mode", "").lower() == "voice")
        print(f"-> {'VOICE' if voice else 'TEXT '} {prompt[:90]!r}", flush=True)

        if voice:
            system = f"{system}\n\n{VOICE_DIRECTIVE}" if system else VOICE_DIRECTIVE

        with _turn_lock:                      # one turn at a time per session
            answer = ask_claude(system, prompt)
        if voice:
            answer = strip_markdown(answer)
        print(f"<- {answer[:90]!r}")

        if req.get("stream"):
            self._stream(answer)
        else:
            self._json(200, self._completion(answer))

    def _completion(self, text: str) -> dict:
        return {
            "id": f"chatcmpl-{uuid.uuid4().hex[:24]}",
            "object": "chat.completion",
            "created": int(time.time()),
            "model": MODEL,
            "choices": [{"index": 0, "finish_reason": "stop",
                         "message": {"role": "assistant", "content": text}}],
            "usage": {"prompt_tokens": 0, "completion_tokens": 0, "total_tokens": 0},
        }

    def _stream(self, text: str):
        """Claude Code has no partial output here, so emit sentence-sized chunks —
        enough for speech-to-speech to start synthesizing before the end."""
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.send_header("Connection", "close")
        self.end_headers()
        cid, created = f"chatcmpl-{uuid.uuid4().hex[:24]}", int(time.time())

        def send(delta: dict, finish=None):
            chunk = {"id": cid, "object": "chat.completion.chunk", "created": created,
                     "model": MODEL,
                     "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
            self.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.wfile.flush()

        send({"role": "assistant", "content": ""})
        for part in re.findall(r"[^.!?]+[.!?]*\s*", text) or [text]:
            if part:
                send({"content": part})
        send({}, finish="stop")
        self.wfile.write(b"data: [DONE]\n\n")
        self.wfile.flush()


if __name__ == "__main__":
    sid = session_id()
    print(f"claude-code shim on http://{HOST}:{PORT}/v1")
    print(f"  session {sid} ({'resuming' if _session_started else 'new'})")
    print(f"  cwd     {CWD}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
