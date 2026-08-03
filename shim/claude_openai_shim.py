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
import pty
import random
import re
import select
import socket as _socket
import subprocess
import time
import uuid
from collections import defaultdict
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Lock, Thread

HOST = os.environ.get("SHIM_HOST", "127.0.0.1")
PORT = int(os.environ.get("SHIM_PORT", "8080"))
MODEL = os.environ.get("SHIM_MODEL", "claude-code")
CWD = os.environ.get("SHIM_CWD", str(Path.home() / "Documents/Obsidian/Personal"))
MCP_CONFIG = os.environ.get("SHIM_MCP_CONFIG", str(Path.home() / ".claude/mcp-obsidian-personal.json"))
TIMEOUT = int(os.environ.get("SHIM_TIMEOUT", "300"))
# Which model Claude Code itself runs. Distinct from SHIM_MODEL above, which is
# only the name advertised to OpenAI clients. Empty = the CLI's own default.
#
# Worth setting for voice: a warm turn costs ~5.5s even for a trivial reply
# (measured 2026-08-03), and most spoken requests are retrieval or commands
# rather than reasoning, so a smaller model shortens the answer itself — unlike
# an acknowledgement tier, which only shortens the silence before it.
CLAUDE_MODEL = os.environ.get("SHIM_CLAUDE_MODEL", "").strip()

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
    "SPOKEN OUTPUT MODE. Your reply is read aloud, not displayed. Speak the way a person "
    "speaks: full, flowing sentences, one or two of them, in a natural conversational "
    "register. Never a clipped fragment or a list read out loud.\n"
    "This overrides any output-format rules in CLAUDE.md or memory: no status panels, no "
    "lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, no 'You:' or 'Next:' lines, "
    "no markdown, bullets, headings, code, backticks or emoji.\n"
    "NEVER say aloud: identifiers, hashes, session ids, byte counts, file paths, "
    "wikilinks, URLs, line numbers, timestamps or version strings. They are noise when "
    "heard rather than read. Say 'the transcript file' not its path, 'the same session as "
    "before' not its id, 'about thirty turns' not an exact count. If a detail only makes "
    "sense written down, say you have put it in the vault instead of reciting it.\n"
    "If you are about to look something up, SAY ONE SHORT SENTENCE FIRST — 'let me "
    "check that' — then do the lookup and answer. Speaking before the tool runs is what "
    "keeps the silence from feeling broken; your first sentence is spoken while the work "
    "happens.\n"
    "LENGTH IS A HARD LIMIT, and it is the rule most often broken: TWO SENTENCES. "
    "Not three. This holds however much you found and however interesting it is — a "
    "spoken answer cannot be skimmed, re-read, or interrupted politely, so a third "
    "sentence is not extra value, it is talking over someone. If more matters, give "
    "the single most important fact in one sentence and offer the rest in a short "
    "second one: 'there is more if you want it'. Then stop and wait."
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


# Identifiers read aloud are pure noise — "bee one eff five zero six bee zero".
# The directive asks the model not to emit them; this is the backstop, because
# asking is not the same as guaranteeing.
# Sentence boundary for streaming text to TTS. Punctuation must be followed by
# whitespace, so a decimal ("5.5s") or a version ("v1.2.3") never splits.
_SENTENCE_END = re.compile(r"[.!?…]+[\"')\]]*(?=\s)")
# Longest run of unpunctuated text to hold before flushing anyway. Without this
# a list or a long clause would sit in the buffer until the turn ended, which is
# exactly the dead air streaming is meant to remove.
SENTENCE_MAX = 200

# How long a voice turn may stay silent before the shim speaks for itself.
#
# VOICE_DIRECTIVE asks the model to say one short sentence before it reaches for
# a tool, and it does — sometimes. A directive is a request, not a guarantee, and
# a turn that ignores it is 15s of dead air. This timer makes the early sentence
# deterministic: it fires only when nothing has been spoken yet, so a prompt
# answer is never interrupted by it.
#
# 3s, not less: a warm turn with no tools reaches its first word at ~2.4s, so a
# shorter threshold interjects "checking now" in front of an answer that was
# already arriving. Tool turns produce nothing for 6s or more, which is the case
# worth covering. If the model beats us to it the duplicate is suppressed, so
# racing near the boundary is harmless.
HOLD_AFTER = float(os.environ.get("SHIM_HOLD_AFTER", "3.0"))
# Well inside speech-to-speech's 20s read timeout, and cheap: an empty SSE delta
# is a few dozen bytes and produces no speech.
KEEPALIVE_EVERY = float(os.environ.get("SHIM_KEEPALIVE_EVERY", "8.0"))
# Fallback for a turn that is slow WITHOUT using tools. Rare, so the threshold is
# generous: better to say nothing than to interject into an answer that is coming.
HOLD_MAX = float(os.environ.get("SHIM_HOLD_MAX", "8.0"))
# TWO sentences, deliberately. speech-to-speech releases a sentence to TTS only
# once the NEXT one has started (base_openai_compatible_language_model.py:404) —
# a lone holding line is held as incomplete text until the answer begins, which
# is the whole silence it was meant to fill. Observed 2026-08-03: emitted at 3s,
# spoken at 13.4s. The second sentence is what pushes the first out; it is itself
# held back and lands just before the answer, which reads as a natural beat.
# Deliberately free of any claim about what is happening. The timer is blind —
# it fires on silence, not on tool use — so "checking now" was spoken in reply to
# "thank you". A holding line that only buys time cannot be wrong about anything;
# one that describes the work can.
_HOLD_LINES = (
    "One moment. Just a second.",
    "Hang on. Won't be long.",
    "One second. Bear with me.",
    "Just a moment. Nearly there.",
)
# When the model DOES comply, its own holding sentence lands after ours and the
# listener hears two. Recognise the shape and drop the duplicate — only ever the
# first sentence, and only when we already spoke.
_HOLDISH = re.compile(
    r"^\s*(let me\b|one moment|one second|hold on|checking\b|i'?ll check|"
    r"give me a\b|sure,? let me\b|okay,? let me\b)", re.I)
# A trailing abbreviation is not a sentence end. Splitting there makes TTS speak
# "e.g." alone, and CoreAudio clips the first word of every utterance — so the
# fragment is not merely odd, it is inaudible.
_ABBREV = {"e.g", "i.e", "etc", "vs", "approx", "no", "fig",
           "dr", "mr", "mrs", "ms", "prof", "st"}


def _ends_with_abbrev(text: str) -> bool:
    tail = text.rstrip("\"')]").rstrip(".")
    word = re.split(r"[\s(]", tail)[-1].lower() if tail else ""
    return word in _ABBREV


_HEXISH = re.compile(r"\b(?=[0-9a-f]*\d)(?=[0-9a-f]*[a-f])[0-9a-f]{6,}\b", re.I)
_UUID = re.compile(r"\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\b", re.I)
_PATHISH = re.compile(r"\S*/\S+\.\w{1,5}\b")


def strip_markdown(text: str) -> str:
    """Make model output safe to speak: no markup, no panels, no identifiers."""
    text = re.sub(r"```.*?```", " ", text, flags=re.S)
    text = _UUID.sub("an id", text)
    text = _PATHISH.sub("a file", text)
    text = _HEXISH.sub("an id", text)
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
def peer_hung_up(sock) -> bool:
    """True once the client has closed its end.

    A failed write is NOT enough to notice in time: a turn spends most of its
    life running tools, producing nothing to write, so a disconnect at second 5
    would go unseen until the answer at second 60 — measured exactly that. This
    peeks instead: a socket that is readable but yields no bytes has seen EOF.

    Never raises. A socket we cannot inspect is assumed alive, so the failure
    mode is the old behaviour rather than a turn killed by mistake.
    """
    try:
        r, _, _ = select.select([sock], [], [], 0)
        if not r:
            return False
        return sock.recv(1, _socket.MSG_PEEK) == b""
    except (BlockingIOError, InterruptedError):
        return False
    except OSError:
        return True     # already unusable
    except Exception:
        return False


class ClientGone(Exception):
    """The listener hung up — raised by the sink, caught by the turn.

    speech-to-speech drops its HTTP request whenever it supersedes its own turn,
    which happens on every mid-sentence pause. Without this the turn kept running
    to completion holding the per-key lock, and the NEXT request — the one
    carrying the full sentence — queued behind one or two dead turns. Measured
    2026-08-03: three fragments of one sentence, the real answer's holding line
    delayed to 15s purely by that queue.
    """


class ClaudeProcess:
    def __init__(self, key: str, session_id: str, resume: bool, system: str):
        cmd = ["claude", "-p",
               "--input-format", "stream-json", "--output-format", "stream-json",
               # Without this, only COMPLETE assistant events arrive, so there is
               # nothing to stream and the whole reply lands at once — measured
               # first-token == total == 5.5s on a warm process. With it, text
               # arrives token-by-token and TTS can start on the first sentence.
               "--include-partial-messages",
               "--verbose", "--permission-mode", "auto",
               "--mcp-config", MCP_CONFIG, "--strict-mcp-config"]
        if CLAUDE_MODEL:
            cmd += ["--model", CLAUDE_MODEL]
        if not UNSAFE:
            cmd += ["--allowed-tools", ALLOWED_TOOLS]
        cmd += ["--resume", session_id] if resume else ["--session-id", session_id]
        if system:
            cmd += ["--append-system-prompt", system]

        self.key = key
        self.session_id = session_id
        self.last_used = time.time()

        # stdout goes to a PTY, not a pipe. Claude Code block-buffers when it
        # is not on a terminal, so every event of a turn arrives at once at the
        # end — measured: acknowledgement and answer both landing at 32.4s. On a
        # PTY it line-buffers, and the same turn yields "let me check" at 3.0s
        # with the answer at 7.8s. That early sentence is what TTS speaks while
        # the tools run, instead of dead air.
        self._pty_main, pty_child = pty.openpty()
        self.proc = subprocess.Popen(
            cmd, cwd=CWD, stdin=subprocess.PIPE, stdout=pty_child,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        os.close(pty_child)
        self._out = os.fdopen(self._pty_main, "rb", 0)
        self._buf = b""
        print(f"  [{key}] spawned claude ({'resume' if resume else 'new'} {session_id[:8]})", flush=True)

    def alive(self) -> bool:
        return self.proc.poll() is None

    def interrupt(self) -> None:
        """Abandon the in-flight turn without killing the session.

        Verified: the turn ends within ~0.1s with a `result` carrying
        subtype 'error_during_execution', and the SAME process answers the next
        prompt normally — so the session is not desynchronised by this. That
        second property is what makes it safe; without it, waiting out the dead
        turn would be the lesser evil.
        """
        try:
            self.proc.stdin.write(json.dumps({
                "type": "control_request",
                "request_id": str(uuid.uuid4()),
                "request": {"subtype": "interrupt"},
            }) + "\n")
            self.proc.stdin.flush()
        except Exception:
            pass    # a turn we were abandoning anyway

    def _readline(self) -> str | None:
        """One JSON line off the PTY. A PTY has no EOF while the child lives,
        so read byte-wise and split on newlines ourselves; \r is the PTY's
        own line-ending translation and is not part of the payload."""
        while True:
            chunk = self._out.read(1)
            if not chunk:
                return None
            self._buf += chunk
            if chunk == b"\n":
                line = self._buf.decode("utf-8", errors="ignore").replace("\r", "")
                self._buf = b""
                return line

    def ask(self, prompt: str, on_text=None, is_gone=None) -> str:
        """Run one turn. `on_text` receives assistant text as it arrives.

        The `assistant` event carries the reply BEFORE `result` — measured 6.1s
        vs 8.7s on a plain question, and much wider when the turn uses tools,
        because `result` waits for every tool to finish. Waiting for `result`
        therefore throws away speech-ready text; emitting on `assistant` lets
        TTS start earlier and lets the model say "let me check" while it works,
        which is exactly what the voice prompt asks for and never got.
        """
        msg = {"type": "user",
               "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}
        self.proc.stdin.write(json.dumps(msg) + "\n")
        self.proc.stdin.flush()

        seen: list[str] = []
        pending = ""       # partial text not yet handed to on_text
        streamed = False   # did any partial reach on_text this turn?
        held = False       # did the timer below speak for us?
        first_out = True   # next emitted sentence is the model's first
        gone = False       # listener hung up; abandon as soon as we notice
        tool_seen = False  # Claude reached for a tool, so a real wait is coming

        def push(part: str) -> None:
            """The ONLY route from model text to the wire.

            Both the sentence-split path and the end-of-block flush go through
            here: keeping the duplicate check in one of them let the model's own
            holding sentence through whenever it arrived unpunctuated, and the
            listener heard "Let me check that." twice.
            """
            nonlocal streamed, first_out, gone
            if gone or not part:
                return
            if first_out and held and _HOLDISH.match(part):
                first_out = False       # we already said it; do not say it twice
                streamed = True
                return
            first_out = False
            try:
                on_text(part)
            except ClientGone:
                gone = True
                return
            streamed = True

        def emit_sentences(flush: bool = False) -> None:
            """Hand whole sentences to on_text, never bare tokens.

            TTS synthesises what it is given, so forwarding each delta as it
            arrives produces one clipped utterance per token. Sentence
            boundaries are the natural unit; SENTENCE_MAX bounds the wait for
            text that never punctuates (a long list, a code-ish line).
            """
            nonlocal pending
            if not on_text:
                pending = "" if flush else pending
                return
            search_from = 0
            while True:
                m = _SENTENCE_END.search(pending, search_from)
                if m and _ends_with_abbrev(pending[:m.end()]):
                    search_from = m.end()   # "e.g." — keep looking
                    continue
                if m:
                    cut = m.end()
                elif len(pending) >= SENTENCE_MAX:
                    cut = pending.rfind(" ", 0, SENTENCE_MAX) + 1 or SENTENCE_MAX
                else:
                    break
                part, pending = pending[:cut].strip(), pending[cut:]
                search_from = 0
                push(part)
            if flush and pending.strip():
                push(pending.strip())
                pending = ""

        def speak_holding_line():
            nonlocal held, gone
            if streamed or gone or not on_text:
                return          # already talking; nothing to fill
            held = True
            try:
                on_text(random.choice(_HOLD_LINES))
            except ClientGone:
                gone = True     # the write is also how we learn they left
            except Exception:
                pass            # a failed filler must never break the turn

        # Wait for EVIDENCE of work, not merely for time to pass. A bare timer
        # fires on any slow turn, so "thank you" was answered with "checking
        # now" — a holding line in front of a reply that needed no lookup at
        # all. A tool_use block is the signal that a wait is genuinely coming.
        hold_stop = Event()

        def hold_watch():
            began = time.monotonic()
            while not hold_stop.wait(0.4):
                if streamed or gone:
                    return
                waited = time.monotonic() - began
                if (tool_seen and waited >= HOLD_AFTER) or waited >= HOLD_MAX:
                    speak_holding_line()
                    return

        if on_text and HOLD_AFTER > 0:
            Thread(target=hold_watch, daemon=True).start()

        def stop_timer():
            hold_stop.set()

        interrupted = False
        deadline = time.time() + TIMEOUT
        while time.time() < deadline:
            # Noticed on the previous iteration that nobody is listening. Stop
            # the turn so the per-key lock frees for the request that replaced
            # it, then keep reading until `result` so the process stays in sync.
            if not gone and is_gone and is_gone():
                gone = True
            if gone and not interrupted:
                interrupted = True
                stop_timer()
                print(f"  [{self.key}] listener gone — interrupting turn", flush=True)
                self.interrupt()

            line = self._readline()
            if line is None:
                stop_timer()
                raise RuntimeError("claude process ended")
            if not line.strip():
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            kind = event.get("type")
            if kind == "stream_event":
                # {"type":"stream_event","event":{"type":"content_block_delta",
                #   "delta":{"type":"text_delta","text":"…"}}}
                # Only text_delta: input_json_delta is tool arguments and
                # thinking_delta is private reasoning — neither is speakable.
                ev = event.get("event", {})
                if ev.get("type") == "content_block_delta":
                    d = ev.get("delta", {})
                    if d.get("type") == "text_delta":
                        pending += d.get("text", "")
                        emit_sentences()
                elif ev.get("type") == "content_block_start":
                    if ev.get("content_block", {}).get("type") == "tool_use":
                        tool_seen = True
                elif ev.get("type") == "content_block_stop":
                    emit_sentences(flush=True)
            elif kind == "assistant":
                chunk = "".join(
                    c.get("text", "")
                    for c in event.get("message", {}).get("content", [])
                    if c.get("type") == "text"
                ).strip()
                if chunk:
                    # Authoritative text for the RETURN value only. It repeats
                    # what the deltas already carried, and it arrives BEFORE
                    # content_block_stop — so emitting here too would speak the
                    # block once now and again at the flush. Streaming is left
                    # entirely to the deltas.
                    seen.append(chunk)
            elif kind == "result":
                # A block that never closed (turn ended early, or the model
                # stopped without punctuation) would otherwise be swallowed.
                stop_timer()
                emit_sentences(flush=True)
                self.last_used = time.time()
                final = str(event.get("result") or "").strip()
                # `result` repeats the last assistant text; return what was
                # already emitted so the caller does not say it twice.
                return final if not seen else "\n".join(seen)
        stop_timer()
        raise TimeoutError(f"no result within {TIMEOUT}s")

    def close(self):
        try:
            self.proc.stdin.close()
        except Exception:
            pass
        try:
            self._out.close()
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


def ask_claude(key: str, system: str, prompt: str, on_text=None, is_gone=None) -> str:
    """Ask over the persistent process, respawning once if it has died."""
    for attempt in (1, 2):
        proc = get_process(key, system)
        began = time.monotonic()
        try:
            out = proc.ask(prompt, on_text=on_text, is_gone=is_gone)
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


class _StreamWriter:
    """Incremental SSE writer for one response.

    Headers go out on the first chunk, so a turn that produces nothing (a
    superseded or filler turn) can still answer with the simple empty body.
    """

    def __init__(self, handler):
        self.h = handler
        self.id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        self.created = int(time.time())
        self.started = False
        # The keepalive runs on its own thread; two writers interleaving would
        # split an SSE frame down the middle.
        self._wlock = Lock()

    def keepalive(self) -> None:
        """Empty delta — resets the client's read timeout, says nothing.

        speech-to-speech aborts a request after 20s with no bytes
        (base_openai_compatible_language_model.py:139) and speaks a canned
        apology. That is a gap between chunks, not a total, so a tool phase
        longer than 20s killed the turn even though it was progressing. An empty
        delta is a well-formed chunk that adds no text, so nothing is spoken.
        Sent only once the response has started; before that there is nothing to
        keep alive.
        """
        if self.started:
            self._raw({})

    def _send(self, delta: dict, finish=None):
        if not self.started:
            self.h.send_response(200)
            self.h.send_header("Content-Type", "text/event-stream")
            self.h.send_header("Cache-Control", "no-cache")
            self.h.send_header("Connection", "close")
            self.h.end_headers()
            self.started = True
            self._raw({"role": "assistant", "content": ""})
        self._raw(delta, finish)

    def _raw(self, delta: dict, finish=None):
        chunk = {"id": self.id, "object": "chat.completion.chunk", "created": self.created,
                 "model": MODEL,
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        with self._wlock:
            self.h.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self.h.wfile.flush()

    def chunk(self, text: str):
        if text:
            self._send({"content": text})

    def finish(self):
        if not self.started:
            self._send({"content": ""})
        self._raw({}, finish="stop")
        self.h.wfile.write(b"data: [DONE]\n\n")
        self.h.wfile.flush()


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def log_message(self, *_):
        pass

    def handle_one_request(self):
        """Client disconnects are normal here, not errors.

        speech-to-speech cancels its own in-flight request on barge-in and on a
        superseded turn, so the socket is often gone by the time we answer.
        The default handler dumps a traceback for that; it is expected traffic.
        """
        try:
            super().handle_one_request()
        except (BrokenPipeError, ConnectionResetError):
            print("   (client went away — cancelled turn)", flush=True)
            self.close_connection = True

    def _json(self, code: int, payload: dict):
        body = json.dumps(payload).encode()
        try:
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True

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
        # The session key is the reliable signal, not the prompt: text surfaces
        # always carry a thread:/dm:/channel: prefix (src/llm.js sessionKeyFor)
        # while voice uses the bare default key.
        #
        # The prompt sniff alone silently failed on every real call — s2s picks
        # its voice system prompt only when wants_audio is set
        # (base_openai_compatible_language_model.py:284), and with TTS as a
        # separate stage it never is. So live voice turns arrived carrying the
        # TEXT prompt, were classified TEXT, and got neither the voice directive
        # nor live streaming. Kept as a fallback for clients that do send it.
        voice = (":" not in key
                 or "spoken conversation" in low or "voice rules" in low
                 or self.headers.get("X-Output-Mode", "").lower() == "voice")
        print(f"-> {'VOICE' if voice else 'TEXT '} [{key}] {prompt[:70]!r}", flush=True)

        parts = [p for p in (system, MEMORY_DIRECTIVE,
                             VOICE_DIRECTIVE if voice else TEXT_DIRECTIVE) if p]
        mine = next_seq(key)

        # Live streaming is VOICE ONLY. strip_panels recognises a closer panel in
        # a complete answer; chunk-by-chunk it cannot, so a text surface would
        # leak panel lines into the reply. Text has no latency pressure and keeps
        # the buffer-then-strip path.
        live = bool(req.get("stream")) and voice
        writer = _StreamWriter(self) if live else None
        dead = False

        def on_text(part: str):
            # Must never raise: speech-to-speech drops the socket on barge-in,
            # and an exception here would abandon the read loop mid-turn, leaving
            # the warm process out of sync with its own session.
            nonlocal dead
            if dead:
                return
            spoken = strip_markdown(part).strip()
            if not spoken:
                return
            try:
                # Trailing space matters: each sentence is its own SSE delta and
                # the client concatenates them verbatim, so without it a reply
                # arrives as "Still here.That question" — which TTS then reads
                # as one run-on word.
                writer.chunk(spoken + " ")
            except (BrokenPipeError, ConnectionResetError):
                dead = True
                self.close_connection = True
                # Raise rather than swallow: the write is the only place we
                # learn the listener left, and the turn needs to know so it can
                # interrupt instead of running on holding the lock.
                raise ClientGone from None

        # Keepalive for the whole turn, including the wait for the lock: a turn
        # queued behind another can easily exceed the client's 20s read timeout
        # before it even starts.
        stop_keepalive = Event()
        if live:
            def keepalive_loop():
                while not stop_keepalive.wait(KEEPALIVE_EVERY):
                    if dead:
                        return
                    try:
                        writer.keepalive()
                    except Exception:
                        return
            Thread(target=keepalive_loop, daemon=True).start()

        try:
            with _locks[key]:             # per key, so other keys run concurrently
                # While we waited for the lock a newer turn may have arrived —
                # this one is a partial hypothesis of the same sentence. Drop it
                # rather than spending a Claude invocation on stale text.
                if superseded(key, mine):
                    print(f"-> STALE [{key}] superseded, dropping: {prompt[:40]!r}", flush=True)
                    return self._stream("") if req.get("stream") else self._json(200, self._completion(""))
                answer = ask_claude(
                    key, "\n\n".join(parts), prompt,
                    on_text=on_text if live else None,
                    is_gone=(lambda: peer_hung_up(self.connection)) if live else None)
        finally:
            stop_keepalive.set()

        if live:
            if not dead:
                try:
                    writer.finish()
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
            return

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
        """Send an ALREADY-COMPLETE answer as sentence-sized chunks.

        The non-live path: text surfaces, and voice turns that produced nothing
        (filler, superseded). Live voice streaming goes through _StreamWriter in
        do_POST instead, driven by on_text as Claude produces the text."""
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

        def safe(*a, **kw):
            try:
                send(*a, **kw)
                return True
            except (BrokenPipeError, ConnectionResetError):
                self.close_connection = True
                return False

        if not safe({"role": "assistant", "content": ""}):
            return
        for part in re.findall(r"[^.!?]+[.!?]*\s*", text) or [text]:
            if part and not safe({"content": part}):
                return
        if not safe({}, finish="stop"):
            return
        try:
            self.wfile.write(b"data: [DONE]\n\n")
            self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError):
            self.close_connection = True


if __name__ == "__main__":
    existing = _load()
    print(f"claude-code shim on http://{HOST}:{PORT}/v1")
    print(f"  sessions {len(existing)} known ({SESSIONS_FILE})")
    print(f"  tools    {'UNRESTRICTED (SHIM_UNSAFE=1)' if UNSAFE else str(ALLOWED_TOOLS.count(',') + 1) + ' allowed'}")
    print(f"  cwd      {CWD}")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
