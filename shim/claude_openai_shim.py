#!/usr/bin/env python3
"""OpenAI-compatible endpoint backed by keyed, persistent Claude Code sessions.

    python3 shim/claude_openai_shim.py

Any OpenAI client can point at http://127.0.0.1:8080/v1. Clients that send
`X-Session-Key` get their own conversation; clients that cannot send headers
(speech-to-speech) share the default one, so voice stays continuous.

WHY KEYED SESSIONS, NOT ONE
    An earlier design used a single session so a voice turn and a text turn
    shared context. That requirement is a symptom of not having durable memory.
    The rule from Agent System Concept — "the identity agent may hold
    conversation in memory precisely because it never holds *work* in memory" —
    means anything that matters is written to the vault. Session context is
    therefore a cache, not the record: it can be cleared, and continuity comes
    from the vault instead. That buys parallel conversations and bounded
    context, and costs nothing that was not recoverable anyway.

OPENAI-SHAPED BUT STATEFUL — a deliberate deviation:

  role            handling      why
  ------------    -----------   ----------------------------------------------
  system          pass through  per-request output rules (voice sends speech rules)
  latest user     the turn      the actual new input
  everything else DISCARD       the session already has the history

Clients resend full history per the spec; appending it to a session that
already has it would double context every turn and fork a second, divergent
history.
"""

from __future__ import annotations

import json
import os
import re
import subprocess
import time
import uuid
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Lock

HOST = os.environ.get("SHIM_HOST", "127.0.0.1")
PORT = int(os.environ.get("SHIM_PORT", "8080"))
MODEL = os.environ.get("SHIM_MODEL", "claude-code")
CWD = os.environ.get("SHIM_CWD", str(Path.home() / "Documents/Obsidian/Personal"))
MCP_CONFIG = os.environ.get("SHIM_MCP_CONFIG", str(Path.home() / ".claude/mcp-obsidian-personal.json"))
TIMEOUT = int(os.environ.get("SHIM_TIMEOUT", "300"))

# Blast radius. Anyone on the Discord allowlist reaches this session, so the
# tool set is bounded rather than left at "whatever Claude Code can do".
# Derived from the /first-mate command's own allowed-tools: read and write the
# vault, search it, query GitHub read-only, and nothing else. Notably absent:
# unrestricted Bash, WebFetch, and any mutating git or kubectl.
#
# `--allowed-tools` is an allowlist, so anything not named here is refused —
# and because -p disables interactive prompts, refusal is a clean failure
# rather than a hang. Set SHIM_ALLOWED_TOOLS to override, or SHIM_UNSAFE=1 to
# drop the restriction entirely (do that only against a throwaway vault).
DEFAULT_ALLOWED_TOOLS = ",".join([
    "Read", "Edit", "Write", "Glob", "Grep",
    "Bash(vault-cli:*)",
    "Bash(date:*)", "Bash(shasum:*)", "Bash(ls:*)",
    "Bash(gh api:*)", "Bash(gh pr view:*)", "Bash(git ls-remote:*)",
    "mcp__semantic-search__search_related",
    "mcp__semantic-search__check_duplicates",
])
ALLOWED_TOOLS = os.environ.get("SHIM_ALLOWED_TOOLS", DEFAULT_ALLOWED_TOOLS)
UNSAFE = os.environ.get("SHIM_UNSAFE") == "1"
SESSIONS_FILE = Path(os.environ.get("SHIM_SESSIONS_FILE", Path.home() / ".claude/shim-sessions.json"))
DEFAULT_KEY = "default"

# Per-key locks: Claude Code serializes turns *within* a session, but different
# sessions run concurrently. A single global lock would silently serialize every
# thread, which is the thing keyed sessions exist to avoid.
_locks: dict[str, Lock] = defaultdict(Lock)
_sessions_lock = Lock()

# Sequence per key, so a request can tell it has been superseded.
#
# speech-to-speech emits PROGRESSIVE transcription finals: one sentence arrives
# as "The plot." / "The plot uh dash p allows uh" / "…allows uh streaming of" /
# the full text. Each becomes a request, each queues on the key's lock, and the
# result is four Claude invocations for one sentence and a multi-second stall.
# s2s cancels its own stale HTTP requests, but that does not reach us — so a
# request that finds a newer one waiting simply drops itself before doing work.
_seq: dict[str, int] = defaultdict(int)
_seq_lock = Lock()


def next_seq(key: str) -> int:
    with _seq_lock:
        _seq[key] += 1
        return _seq[key]


def superseded(key: str, mine: int) -> bool:
    with _seq_lock:
        return _seq[key] > mine


# ── sessions ───────────────────────────────────────────────────────────────
def _load() -> dict:
    if SESSIONS_FILE.exists():
        try:
            return json.loads(SESSIONS_FILE.read_text())
        except Exception as e:
            print(f"  sessions file unreadable, starting fresh: {e}", flush=True)
    return {}


def _save(data: dict) -> None:
    SESSIONS_FILE.parent.mkdir(parents=True, exist_ok=True)
    SESSIONS_FILE.write_text(json.dumps(data, indent=2))


def get_session(key: str) -> tuple[str, bool]:
    """Return (session_id, started) for a key, creating one if needed."""
    with _sessions_lock:
        data = _load()
        entry = data.get(key)
        if entry:
            return entry["id"], entry.get("started", False)
        sid = str(uuid.uuid4())
        data[key] = {"id": sid, "started": False, "created": time.time(), "turns": 0}
        _save(data)
        return sid, False


def mark_started(key: str) -> None:
    with _sessions_lock:
        data = _load()
        if key in data:
            data[key]["started"] = True
            data[key]["turns"] = data[key].get("turns", 0) + 1
            data[key]["last"] = time.time()
            _save(data)


def reset_session(key: str) -> str:
    """Drop the key's session so the next turn starts a fresh conversation."""
    with _sessions_lock:
        data = _load()
        old = data.pop(key, {}).get("id", "")
        _save(data)
    return old


# ── output shaping ─────────────────────────────────────────────────────────
# A session carrying a personal CLAUDE.md follows *its* output rules — status
# panels, markdown, bullet lists — which are right for a terminal and unusable
# as speech. The voice prompt is advisory and loses to them, so the shim
# enforces: belt (instruction) and braces (post-strip).
VOICE_DIRECTIVE = (
    "SPOKEN OUTPUT MODE. Your reply is read aloud by a speech synthesiser, not displayed. "
    "Reply in at most two short sentences of plain prose. "
    "This overrides any output-format rules in CLAUDE.md or memory: emit NO status panels, "
    "no lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, no 'You:' or 'Next:' lines, "
    "no markdown, no bullet lists, no headings, no code, no backticks, no emoji. "
    "Do not speak file paths, wikilinks, URLs or hashes — describe them in words. "
    "If the answer is long, say the single most important thing and offer to continue."
)

# Sessions here are disposable by design, so anything that matters must leave
# the session before it is cleared. This is the load-bearing half of keyed
# sessions: without it, clearing one loses decisions that existed nowhere else.
MEMORY_DIRECTIVE = (
    "DURABLE MEMORY. This conversation is a cache, not a record — it will be cleared. "
    "Before the turn ends, write anything worth keeping into the vault: a decision, a "
    "conclusion, a commitment, a fact you had to work to establish. Use the existing task "
    "or Knowledge Base page if one fits, and say in one short clause where you put it. "
    "Do not write chit-chat, and do not ask permission for a small note."
)

# Same lesson as the voice directive: instruct AND post-strip, because the model
# following a formatting instruction every time is not guaranteed.
TEXT_DIRECTIVE = (
    "You are replying in a Discord chat, not a terminal. Do not emit status panels: "
    "no lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, and no 'You:' or 'Next:' "
    "lines. Markdown is fine — Discord renders it. Keep it short unless asked."
)

# Three signals, most reliable first. The state icon is the strongest: those five
# emoji appear only in closer panels, whereas the keyword after them is free-form
# ("⚪ Status check answered" is not "⚪ DONE"), so matching on the word alone
# misses real panels.
# Backchannel that VAD turns into a "turn". Each one otherwise costs a full
# Claude Code invocation (10-70s) AND blocks the per-session lock, so a couple
# of "okay"s while thinking will queue up behind the real question.
#
# Deliberately narrow: bare "yes"/"no" are NOT here, because they are real
# answers to a question the assistant just asked. Only ≤3 words, all filler.
# Greetings and thanks are NOT here: "hello" is an opener that deserves a
# reply, and silence in response reads as the bot being broken. Bare "yes"/"no"
# are excluded for the same reason — they answer a question.
_FILLER_WORDS = {
    "okay", "ok", "yeah", "yep", "yup", "mm", "mmm", "mhm", "mmhmm", "hmm", "hm",
    "uh", "um", "ah", "oh", "erm", "eh", "alright", "right",
}


def is_filler(text: str) -> bool:
    words = re.findall(r"[\w'-]+", text.lower())
    return 0 < len(words) <= 3 and all(w in _FILLER_WORDS for w in words)


_PANEL = re.compile(
    r"^\s*[\U0001F7E2\U0001F7E1\U0001F534\U0001F535\u26AA][^\n]*$"   # 🟢🟡🔴🔵⚪ …
    r"|^[^\w\n]{1,6}\s*(?:You|Next|Recommend)\s*:.*$"                    # 👤 You: / ⏰ Next:
    r"|^[^\w\n]{0,6}\s*(?:\*\*)?(?:READY|DONE|ACTIVE|WAITING|BLOCKED)\b[^\n]*$",
    re.M,
)


def strip_panels(text: str) -> str:
    """Remove the CLAUDE.md closer panel. Applied to BOTH surfaces.

    A chat window is not a terminal: "READY / You: / Next:" is noise in Discord
    and unspeakable in voice. Markdown is kept for text, where Discord renders
    it, and removed for voice, where TTS would read the asterisks aloud.
    """
    text = _PANEL.sub("", text)
    return re.sub(r"\n{3,}", "\n\n", text).strip()   # tidy the gaps left behind


def strip_markdown(text: str) -> str:
    """Make model output safe to speak: no markup, no panels, no paths."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = _PANEL.sub("", text)
    text = re.sub(r"\[\[([^\]|]*\|)?([^\]]+)\]\]", r"\2", text)
    text = re.sub(r"\[([^\]]+)\]\([^)]+\)", r"\1", text)
    text = re.sub(r"^\s*[-*+]\s+", "", text, flags=re.M)
    text = re.sub(r"[*_`#>|]+", "", text)
    text = re.sub(r"https?://\S+", "a link", text)
    return re.sub(r"\s+", " ", text).strip()


# ── persistent claude processes ────────────────────────────────────────────
# One long-lived `claude` per session key, fed over stdin as stream-json.
#
# Spawning `claude -p` per turn re-pays startup every time: measured at ~10s,
# of which trimming MCP from 15 servers to 1 saved only 1.6s — the cost is the
# CLI itself, so only process reuse fixes it. A second turn on a warm process
# measured 4.4s against 7.5s cold, and the gap widens as a session grows.
#
# `--append-system-prompt` is a LAUNCH flag, not per-message. That is fine here
# because a key maps to exactly one surface (voice uses the default key, text
# uses thread:/dm:/channel: keys), so the directive is stable for the process's
# life.
class ClaudeProcess:
    def __init__(self, key: str, session_id: str, resume: bool, system: str):
        cmd = ["claude", "-p",
               "--input-format", "stream-json", "--output-format", "stream-json",
               "--verbose", "--permission-mode", "auto",
               "--mcp-config", MCP_CONFIG, "--strict-mcp-config"]
        if not UNSAFE:
            cmd += ["--allowed-tools", ALLOWED_TOOLS]
        cmd += ["--resume", session_id] if resume else ["--session-id", session_id]
        if system:
            cmd += ["--append-system-prompt", system]

        self.key = key
        self.session_id = session_id
        self.last_used = time.time()
        self.proc = subprocess.Popen(
            cmd, cwd=CWD, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, text=True, bufsize=1,
        )
        print(f"  [{key}] spawned claude ({'resume' if resume else 'new'} {session_id[:8]})", flush=True)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def ask(self, prompt: str) -> str:
        msg = {"type": "user",
               "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                raise RuntimeError("claude process ended")
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue
            if event.get("type") == "result":
                self.last_used = time.time()
                return str(event.get("result") or "").strip()
        raise TimeoutError(f"no result within {TIMEOUT}s")

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self.proc.terminate()
        except Exception:
            pass


_procs: dict[str, ClaudeProcess] = {}
_procs_lock = Lock()


def get_process(key: str, system: str) -> ClaudeProcess:
    with _procs_lock:
        proc = _procs.get(key)
        if proc and proc.alive():
            return proc
        if proc:
            print(f"  [{key}] claude process died, respawning", flush=True)
            proc.close()
        sid, started = get_session(key)
        proc = ClaudeProcess(key, sid, started, system)
        _procs[key] = proc
        return proc


def drop_process(key: str) -> None:
    with _procs_lock:
        proc = _procs.pop(key, None)
    if proc:
        proc.close()


def ask_claude(key: str, system: str, prompt: str) -> str:
    """Ask over the persistent process, respawning once if it has died."""
    for attempt in (1, 2):
        proc = get_process(key, system)
        began = time.monotonic()
        try:
            out = proc.ask(prompt)
            mark_started(key)
            print(f"  [{key}] {time.monotonic() - began:.1f}s, {len(out)} chars", flush=True)
            return out
        except (RuntimeError, BrokenPipeError, OSError) as e:
            print(f"  [{key}] process failed ({e}), attempt {attempt}", flush=True)
            drop_process(key)
            if attempt == 2:
                return f"(claude unavailable: {e})"
        except TimeoutError as e:
            print(f"  [{key}] {e}", flush=True)
            return f"(timed out after {TIMEOUT}s)"
    return "(claude unavailable)"


def _legacy_ask_claude(key: str, system: str, prompt: str) -> str:
    sid, started = get_session(key)
    cmd = ["claude", "-p", prompt, "--output-format", "text",
           "--mcp-config", MCP_CONFIG, "--strict-mcp-config",
           "--permission-mode", "auto"]
    if not UNSAFE:
        cmd += ["--allowed-tools", ALLOWED_TOOLS]
    cmd += ["--resume", sid] if started else ["--session-id", sid]
    if system:
        cmd += ["--append-system-prompt", system]

    began = time.monotonic()
    try:
        r = subprocess.run(cmd, cwd=CWD, capture_output=True, text=True, timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        return f"(timed out after {TIMEOUT}s)"

    if r.returncode != 0:
        err = (r.stderr or r.stdout).strip()[:400]
        # A resume can fail if the session file was pruned; start a new one once.
        if started and "session" in err.lower():
            reset_session(key)
            print(f"  [{key}] resume failed, starting fresh: {err[:120]}", flush=True)
            return ask_claude(key, system, prompt)
        print(f"  [{key}] claude failed rc={r.returncode}: {err}", flush=True)
        return f"(claude error: {err[:200]})"

    mark_started(key)
    out = r.stdout.strip()
    print(f"  [{key}] {time.monotonic() - began:.1f}s, {len(out)} chars", flush=True)
    return out


def extract(messages: list[dict]) -> tuple[str, str]:
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

    def log_message(self, *_):
        pass

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def _key(self) -> str:
        return self.headers.get("X-Session-Key") or DEFAULT_KEY

    def do_GET(self):
        path = self.path.rstrip("/")
        if path.endswith("/models"):
            return self._json(200, {"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "anthropic"}]})
        if path.endswith("/sessions"):
            now = time.time()
            return self._json(200, {"sessions": [
                {"key": k, "id": v["id"], "turns": v.get("turns", 0),
                 "age_minutes": round((now - v.get("created", now)) / 60, 1)}
                for k, v in sorted(_load().items())
            ]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/").endswith("/sessions/reset"):
            key = self._key()
            drop_process(key)          # kill the live process, not just the mapping
            old = reset_session(key)
            print(f"-> RESET [{key}] {old or '(none)'}", flush=True)
            return self._json(200, {"reset": key, "previous": old})

        if "chat/completions" not in self.path:
            return self._json(404, {"error": {"message": "not found"}})
        try:
            req = json.loads(self.rfile.read(int(self.headers.get("Content-Length", 0))) or b"{}")
        except Exception as e:
            return self._json(400, {"error": {"message": f"bad json: {e}"}})

        system, prompt = extract(req.get("messages", []))
        if not prompt:
            return self._json(400, {"error": {"message": "no user message"}})

        key = self._key()

        # Answer filler without waking Claude Code. Empty content means
        # speech-to-speech synthesises nothing, so the bot simply stays quiet —
        # which is what a person does when you say "okay" mid-thought.
        if is_filler(prompt):
            print(f"-> SKIP  [{self._key()}] filler: {prompt[:40]!r}", flush=True)
            if req.get("stream"):
                return self._stream("")
            return self._json(200, self._completion(""))

        low = system.lower()
        voice = ("spoken conversation" in low or "voice rules" in low
                 or self.headers.get("X-Output-Mode", "").lower() == "voice")
        print(f"-> {'VOICE' if voice else 'TEXT '} [{key}] {prompt[:70]!r}", flush=True)

        parts = [p for p in (system, MEMORY_DIRECTIVE,
                             VOICE_DIRECTIVE if voice else TEXT_DIRECTIVE) if p]
        mine = next_seq(key)
        with _locks[key]:                 # per key, so other keys run concurrently
            # While we waited for the lock a newer turn may have arrived — this
            # one is a partial hypothesis of the same sentence. Drop it silently
            # rather than spending a Claude invocation on stale text.
            if superseded(key, mine):
                print(f"-> STALE [{key}] superseded, dropping: {prompt[:40]!r}", flush=True)
                return self._stream("") if req.get("stream") else self._json(200, self._completion(""))
            answer = ask_claude(key, "\n\n".join(parts), prompt)
        answer = strip_markdown(answer) if voice else strip_panels(answer)

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
        """Claude Code gives no partial output here, so emit sentence-sized
        chunks — enough for speech-to-speech to start synthesizing early."""
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
    existing = _load()
    print(f"claude-code shim on http://{HOST}:{PORT}/v1")
    print(f"  sessions {len(existing)} known ({SESSIONS_FILE})")
    print(f"  tools    {'UNRESTRICTED (SHIM_UNSAFE=1)' if UNSAFE else str(ALLOWED_TOOLS.count(',') + 1) + ' allowed'}")
    print(f"  cwd      {CWD}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
