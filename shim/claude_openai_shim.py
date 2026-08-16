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
import urllib.error
import urllib.request
from collections import defaultdict, deque
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from threading import Event, Lock, Thread

# ── configuration ──────────────────────────────────────────────────────────
# One flat config for one instance. Deliberately NOT multi-profile: two
# configurations means two deployments, which k8s already expresses better than
# a profile key would, and a single active profile is the only thing this
# process could ever use anyway.
#
# Precedence is env > file > default, in that order. Environment last-word is
# what keeps this k8s-native — a ConfigMap or a plain `SHIM_*` var still wins,
# and an instance with no config file behaves exactly as before.
#
# Secrets are named, never carried: `front.api_key_id` is a TeamVault key id,
# resolved by the launcher into `SHIM_FRONT_API_KEY`. This file is not
# gitignored the way `local.env` is, so it must stay safe to read.
CONFIG_FILE = Path(os.environ.get(
    "DISCORD_ASSISTANT_CONFIG", Path.home() / ".config/discord-assistant/config.yaml"))


def _load_config() -> dict:
    if not CONFIG_FILE.exists():
        return {}
    try:
        import yaml
    except ImportError:
        print(f"  config: {CONFIG_FILE} present but PyYAML is not installed — ignoring", flush=True)
        return {}
    try:
        return yaml.safe_load(CONFIG_FILE.read_text()) or {}
    except Exception as e:
        # Loud but not fatal: a typo in the config must not take the endpoint
        # down, and every value has a working default behind it.
        print(f"  config: {CONFIG_FILE} unreadable ({e}) — using defaults", flush=True)
        return {}


_CFG = _load_config()


def setting(env: str, path: str, default):
    """One value, resolved env > config file > default.

    `path` is dotted (`front.model`). Types follow the default: an int default
    parses an int, so config and env agree rather than one yielding a string.
    """
    raw = os.environ.get(env)
    if raw is None:
        node = _CFG
        for part in path.split("."):
            node = node.get(part) if isinstance(node, dict) else None
            if node is None:
                break
        raw = node
    if raw is None:
        return default
    if isinstance(default, bool):
        # Quotes stripped and "off" included so this agrees with the bot's
        # `flag()` (src/config.js) on every spelling. It did not: `X=off` read
        # as TRUE here and false there, and a Make-quoted `"0"` read as TRUE on
        # both — a switch that looks set and isn't is worse than no switch.
        return str(raw).strip().strip("\"'").lower() not in ("0", "false", "no", "off", "")
    if isinstance(default, int) and not isinstance(default, bool):
        return int(raw)
    if isinstance(default, float):
        return float(raw)
    return str(raw)


def _expand(p: str) -> str:
    return str(Path(p).expanduser())


HOST = setting("SHIM_HOST", "host", "127.0.0.1")
PORT = setting("SHIM_PORT", "port", 8080)
MODEL = setting("SHIM_MODEL", "model", "claude-code")
CWD = _expand(setting("SHIM_CWD", "cwd", str(Path.home() / "Documents/Obsidian/Personal")))
MCP_CONFIG = _expand(setting(
    "SHIM_MCP_CONFIG", "mcp_config", str(Path.home() / ".claude/mcp-obsidian-personal.json")))
# The launcher that starts Claude, e.g. ~/Documents/workspaces/scripts/cc-personal.
# Naming a script rather than restating its flags is the point: the wrapper
# already pins the router, model, effort and --add-dir set that every other
# entry point uses, and a second copy of that list here drifts from it silently.
# vault-cli solves the same problem the same way, with `claude_script` per vault.
_script = setting("SHIM_CLAUDE_SCRIPT", "claude_script", "").strip()
CLAUDE_SCRIPT = _expand(_script) if _script else ""
TIMEOUT = setting("SHIM_TIMEOUT", "timeout", 300)
# Which model Claude Code itself runs. Distinct from SHIM_MODEL above, which is
# only the name advertised to OpenAI clients. Empty = the CLI's own default.
#
# Worth setting for voice: a warm turn costs ~5.5s even for a trivial reply
# (measured 2026-08-03), and most spoken requests are retrieval or commands
# rather than reasoning, so a smaller model shortens the answer itself — unlike
# an acknowledgement tier, which only shortens the silence before it.
CLAUDE_MODEL = setting("SHIM_CLAUDE_MODEL", "claude_model", "").strip()

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
ALLOWED_TOOLS = setting("SHIM_ALLOWED_TOOLS", "allowed_tools", DEFAULT_ALLOWED_TOOLS)
UNSAFE = setting("SHIM_UNSAFE", "unsafe", False)
SESSIONS_FILE = Path(_expand(setting(
    "SHIM_SESSIONS_FILE", "sessions_file", str(Path.home() / ".claude/shim-sessions.json"))))
DEFAULT_KEY = "default"

# ── front tier ─────────────────────────────────────────────────────────────
# A small hosted model answers pure conversation, so "hello" does not pay the
# ~2.4s a Claude Code turn costs before its first word. Everything else goes to
# Claude untouched.
#
# The ROUTING is a closed whitelist here, not a decision the front model makes.
# Letting it choose costs a round trip (~0.6s) to be told what the transcript
# already says, and puts a safety-critical judgement inside a model: answering
# "what did I decide about the deploy" from its own head produces a fluent
# invention about the user's vault, spoken in the assistant's voice. A closed set
# of phrases cannot drift, and anything unrecognised falls through to Claude.
#
# Disabled unless a key is present, so a missing credential degrades to today's
# behaviour rather than breaking voice.
FRONT_BASE_URL = setting("SHIM_FRONT_BASE_URL", "front.base_url", "https://api.minimax.io/v1").rstrip("/")
FRONT_MODEL = setting("SHIM_FRONT_MODEL", "front.model", "MiniMax-M3")
FRONT_API_KEY = os.environ.get("SHIM_FRONT_API_KEY", "").strip()
FRONT_TIMEOUT = setting("SHIM_FRONT_TIMEOUT", "front.timeout", 4.0)
FRONT_HISTORY = setting("SHIM_FRONT_HISTORY", "front.history", 8)
# The hand-written whitelist and factual backstop below are a bet that pattern
# matching routes better than the model does. SHIM_FRONT_HEURISTICS=0 takes them
# out of the path so the front model decides every turn on its own — slower, but
# it is the honest baseline the heuristics have to beat.
FRONT_HEURISTICS = setting("SHIM_FRONT_HEURISTICS", "front.heuristics", True)

# ── chat bridge ────────────────────────────────────────────────────────────
# The back-edge that lets a spoken answer also land in the channel as text.
# See the task's `# Design`: the shim already computes the full answer and
# discards everything past SPOKEN_MAX — this posts what would otherwise be
# thrown away to the bot's health server, which owns channel routing because
# it (not the shim) knows which voice call is actually live.
#
# CHAT_BRIDGE_TOKEN is read directly from the environment, never via
# `setting()`'s config-file fallback and never via argv — the secret-in-argv
# class has bitten this repo twice (visible in `ps`, logged by supervisors).
# Both processes read the SAME env var name by convention (see local.env.example)
# so a name mismatch cannot silently strand the secret on one side.
CHAT_BRIDGE_URL = setting("SHIM_CHAT_BRIDGE_URL", "chat_bridge.url", "http://127.0.0.1:8081/chat")
CHAT_BRIDGE_TOKEN = os.environ.get("CHAT_BRIDGE_TOKEN", "").strip()
CHAT_BRIDGE_TIMEOUT = setting("SHIM_CHAT_BRIDGE_TIMEOUT", "chat_bridge.timeout", 5.0)

# The model has no tool for this and makes no decision about it — the posting
# is done here, in code. But it still has to know the channel is reachable,
# because otherwise it truthfully reports the old limitation: caught on a live
# call 2026-08-09, asked to "write it to the chat", it answered "I can only
# speak, not type into the channel" while this very bridge was armed.
#
# Note what this directive does NOT say: it never asks the model to decide, to
# emit a marker, or to call anything. It corrects a factual belief and gets out
# of the way. The LENGTH rule above still binds what is SPOKEN; the full text
# reaching the channel is exactly the point of the cap.
CHAT_BRIDGE_DIRECTIVE = (
    "WRITTEN COPY. Everything you write this turn is ALSO posted into the voice "
    "channel's text chat, in full and automatically. Only the opening is spoken; the "
    "whole thing is readable. This is why the SHAPE rule above says answer first, "
    "detail after — the two halves go to different senses, not to different people.\n"
    "So NEVER say you can only speak, that you cannot type, or that you have no way "
    "to put something in the chat. That was true once and is not true now.\n"
    "When asked to write something down — a name, a list, a link, a price — do not "
    "announce that you have put it somewhere. Just answer, in full: the writing IS "
    "the answer, and it arrives without you saying so."
)

# ── typed-turn hint ────────────────────────────────────────────────────────
# A turn the user TYPED during a live call reaches us through speech-to-speech
# looking exactly like a spoken one — no session key, no output mode, nothing
# in the text that distinguishes it. That indistinguishability is by design
# (it is what lets the same pipeline answer both), and it is also why the
# chat-bridge triggers cannot see the difference on their own.
#
# So the bot says so out of band: it POSTs here immediately before pushing the
# typed turn into its s2s socket, and the next turn on that key consumes the
# flag. One-shot, and it fails in the safe direction — a stale hint costs one
# unnecessary post, never a missing one.
#
# Why the hint matters: the spoken reply is capped at SPOKEN_MAX sentences, so
# without it a typed question is the ONLY kind whose full answer reaches
# nobody — you typed it because it was precise, and the precise answer is the
# one that evaporates. In a call you should always hear it AND be able to read
# it.
_TYPED_TURN_HINTS: set[str] = set()
_TYPED_TURN_LOCK = Lock()


def mark_typed_turn(key: str) -> None:
    with _TYPED_TURN_LOCK:
        _TYPED_TURN_HINTS.add(key)


def clear_typed_turn(key: str) -> None:
    """Drop a hint set for a turn that never happened (speak() refused/failed)."""
    with _TYPED_TURN_LOCK:
        _TYPED_TURN_HINTS.discard(key)


def take_typed_turn(key: str) -> bool:
    """Consume the flag — reading it clears it, so it applies to ONE turn."""
    with _TYPED_TURN_LOCK:
        if key in _TYPED_TURN_HINTS:
            _TYPED_TURN_HINTS.discard(key)
            return True
        return False


# Which session spoken turns belong to right now.
#
# speech-to-speech owns the HTTP call and cannot set X-Session-Key, so every
# spoken turn used to fall through to DEFAULT_KEY — ONE conversation for all
# voice, in every guild. Joining a call in a second server resumed the first
# server's conversation, which is a privacy boundary, not a papercut.
#
# So the bot names the key out of band on join, the same shape as the typed-turn
# hint above. The difference is lifetime: that one is consumed by a single turn,
# this one persists until the next bind or leave, because it describes WHICH
# CONVERSATION is live rather than something about one utterance.
#
# A single pointer (not a map) is sound because speech-to-speech serves exactly
# one session at a time — "All 1 session slots are in use" — and the bot holds at
# most one call. Two concurrent voice conversations cannot exist to disagree
# about. If s2s ever serves more, this must become a map keyed by whatever
# identifies the socket, and the assert below is where that will surface.
# Every voice conversation's key starts with this. It is not cosmetic: the
# request handler matches on it to know a turn was SPOKEN, which is what gates
# the wake phrase. Keep the bot's `voiceKeyFor()` in step with it.
VOICE_KEY_PREFIX = "voice:"

# ── per-identity persona ───────────────────────────────────────────────────
# Multiple Discord identities can share this ONE shim (and the one
# `speech-to-speech` process every voice call goes through) without
# answering with each other's persona, session store or vault.
#
# Why here, not a second shim: `speech-to-speech` wires its backend at
# process STARTUP (`scripts/s2s-minimax`, trailing `"$@"` from `local.env`)
# and never changes it again — so the single s2s always talks to ONE shim for
# its whole life. A second identity's own shim never sees a spoken turn; only
# consolidating to one shim that decides persona PER TURN fixes the routing,
# not adding more shims for it to ignore.
#
# `ClaudeProcess` already takes `cwd` per spawn (`Popen(cmd, cwd=cwd, ...)`),
# not process-global, so the fix is to stop reading the module-level CWD /
# CLAUDE_SCRIPT / MCP_CONFIG / ALLOWED_TOOLS constants directly and resolve
# them per session key instead — a lookup, not a redesign.
#
# Keyed by IDENTITY name, not guild id: persona belongs to the identity (the
# bot), while the guild is the other half of the key that keeps sessions
# separate — see `identity_for()`. `identities:` in config.yaml maps identity
# name -> overrides; any field left unset falls back to this instance's own
# top-level setting, so a config with no `identities:` at all resolves every
# key to the same defaults it always had — single-identity setups need no
# migration.
#
# Guild-id-keyed entries (the `v0.16.0` shape) still work: a 2-segment key
# (`voice:<guildId>`, no identity segment — the bot never set `IDENTITY`)
# looks itself up in this SAME map by guildId, unchanged from before. The two
# lookups do not collide in practice — identity names and Discord guild
# snowflakes do not share a namespace — so one map serves both shapes.
def _load_identities() -> dict[str, dict]:
    """identityName-or-guildId -> {cwd, claude_script, mcp_config, allowed_tools}.

    Read straight off the parsed config file rather than through `setting()`:
    that helper resolves ONE scalar against env/file/default, and an identity
    is a small object, not a scalar. There is deliberately no per-field env
    override here — a second identity's cwd is an operator-authored fact that
    belongs in config.yaml next to the other identities, not a `SHIM_*` var
    that would need one distinct name per guild to even be expressible.
    """
    raw = _CFG.get("identities") or {}
    if not isinstance(raw, dict):
        print(f"  config: identities must be a mapping, got {type(raw).__name__} — ignoring", flush=True)
        return {}
    out: dict[str, dict] = {}
    for guild_id, cfg in raw.items():
        if not isinstance(cfg, dict):
            print(f"  config: identities.{guild_id} must be a mapping — ignoring", flush=True)
            continue
        entry: dict[str, str] = {}
        if cfg.get("cwd"):
            entry["cwd"] = _expand(str(cfg["cwd"]))
        if cfg.get("claude_script"):
            entry["claude_script"] = _expand(str(cfg["claude_script"]))
        if cfg.get("mcp_config"):
            entry["mcp_config"] = _expand(str(cfg["mcp_config"]))
        if cfg.get("allowed_tools"):
            # Expanded like every other path field above. An allowed-tools value
            # can carry a `~`-rooted path, and passing the literal `~` through to
            # --allowed-tools fails silently rather than erroring.
            entry["allowed_tools"] = _expand(str(cfg["allowed_tools"]))
        out[str(guild_id)] = entry
    return out


IDENTITIES = _load_identities()


def identity_for(key: str) -> dict:
    """Resolve {cwd, claude_script, mcp_config, allowed_tools} for a turn.

    This is the routing fix itself: everything that used to read the
    module-level CWD / CLAUDE_SCRIPT / MCP_CONFIG / ALLOWED_TOOLS constants
    directly now calls this instead, so persona becomes a function of WHICH
    conversation a turn belongs to rather than a process-wide constant every
    identity shared by accident.

    Identity rides in the KEY for every surface, not just voice — a header
    was tried first and dropped: two bots in the SAME Discord channel produce
    the IDENTICAL `thread:`/`channel:`/`dm:` key, so a header fixes which
    persona a process spawns with but does NOT separate the sessions — one
    identity would resume the conversation another was holding, then spawn
    it under the wrong cwd. Only the key can do both jobs at once, which is
    why voice already worked this way and text now matches it:

    - `voice:<guildId>:<identity>` — unchanged since `v0.16.1`.
      `speech-to-speech` owns the HTTP call for a spoken turn and cannot set
      `X-Session-Key` at all, which is why the bot binds this key out of band
      instead (`bind_voice_key`) — see the module docstring above.
    - `thread:<channelId>:<identity>` / `channel:<channelId>:<identity>` /
      `dm:<userId>:<identity>` — the bot DOES own `X-Session-Key` on every
      text surface, so it embeds identity there uniformly rather than
      needing a second mechanism. Before this, a text key carried no
      identity at all and every text turn from every identity resolved to
      this instance's own default persona.

    The identity segment is always LAST regardless of prefix, so resolution
    is one rule for every surface: split off the prefix, then split the
    remainder on `:`. A 3-segment key resolves by IDENTITY, in whichever
    segment it lands. A 2-segment key falls through to the identity map
    keyed by GUILD id — but only for voice: `thread:111`/`dm:111`/
    `channel:111` name a channel or user, never a guild, so a bare 2-segment
    text key must never accidentally pick up a guildId entry that happens to
    share the string. An unconfigured identity name falls back to this
    instance's own default rather than crashing or guessing.

    Persona and session are different axes and the key format reflects it:
    the guild/channel/user segment keeps sessions apart (two identities
    sharing one channel get two conversations), the optional identity
    segment is what picks persona (one identity across several
    guilds/channels gets one persona). A key with no identity segment means
    the bot never set `IDENTITY` — this instance behaves exactly as
    `v0.16.0`/pre-identity did, resolving voice by guild id and text by
    instance default, for backward compatibility with that config shape.
    """
    defaults = {"cwd": CWD, "claude_script": CLAUDE_SCRIPT,
                "mcp_config": MCP_CONFIG, "allowed_tools": ALLOWED_TOOLS}
    prefix, sep, rest = key.partition(":")
    if not sep:
        return defaults
    first, sep2, identity = rest.partition(":")
    if sep2:
        # 3-segment key of ANY prefix — identity always lands in the last
        # segment, resolved by IDENTITY, never by guild/channel/user even
        # when that segment's value happens to match a configured one.
        overrides = IDENTITIES.get(identity)
    elif f"{prefix}:" == VOICE_KEY_PREFIX:
        # 2-segment `voice:<guildId>`, no `IDENTITY` set on the bot — the
        # v0.16.0 lookup, unchanged: resolve by guild id.
        overrides = IDENTITIES.get(first)
    else:
        # 2-segment text key (`thread:<id>`/`dm:<id>`/`channel:<id>`) — never
        # a guild, so never consults the guild-keyed map.
        overrides = None
    if not overrides:
        return defaults
    return {**defaults, **overrides}


_VOICE_KEY = DEFAULT_KEY
_VOICE_KEY_LOCK = Lock()


def is_voice_turn(mode: str, key: str, text: str = "") -> bool:
    """Was this turn SPOKEN? Decides whether the wake phrase is enforced.

    Extracted from the request handler after living there as an inline
    expression, which is how it came to be keyed on the SHAPE of a session key
    (`":" not in key`, meaning "the key is `default`"). Keying voice per guild
    gave every spoken turn a colon, so all of them classified as text, the wake
    gate stopped running, and the assistant answered every sentence of a live
    meeting. Nothing errored and every health check stayed green.

    Order matters:

    - an explicit `X-Output-Mode` header wins in both directions — the bot sets
      it, and it is the only signal that distinguishes a message TYPED into a
      call's text chat (same session key as the speech) from one spoken aloud
    - otherwise a key in the voice keyspace is spoken, since speech-to-speech
      owns the HTTP call and can send no headers
    - `":" not in key` remains for the legacy `default` key and any client that
      sends neither
    - the prompt sniff is a last resort: s2s attaches its voice system prompt
      only when `wants_audio` is set, which it never is with TTS as a separate
      stage
    """
    mode = (mode or "").lower()
    if mode == "voice":
        return True
    if mode == "text":
        return False
    low = (text or "").lower()
    return (key.startswith(VOICE_KEY_PREFIX)
            or ":" not in key
            or "spoken conversation" in low
            or "voice rules" in low)


def bind_voice_key(key: str) -> str:
    """Point spoken turns at `key` until the next bind. Returns the previous."""
    global _VOICE_KEY
    with _VOICE_KEY_LOCK:
        previous, _VOICE_KEY = _VOICE_KEY, key or DEFAULT_KEY
    return previous


# Whether the operator is the only human in the call. Sticky, like the voice
# key above and unlike the one-shot typed hint: it describes a standing state of
# the room, not something about one utterance.
#
# DEFAULTS TO FALSE, and that direction is load-bearing. An endpoint that is
# never told stays exactly as it was — gate armed — so a shim that predates this
# route, a bot that fails to post, and a backend that 404s the path all degrade
# to the safe behaviour rather than to an assistant that answers everything.
_SOLO = False
_SOLO_LOCK = Lock()


def set_solo(solo: bool) -> bool:
    """Record whether the operator is alone. Returns the previous value."""
    global _SOLO
    with _SOLO_LOCK:
        previous, _SOLO = _SOLO, bool(solo)
    return previous


def is_solo() -> bool:
    with _SOLO_LOCK:
        return _SOLO


def voice_key() -> str:
    with _VOICE_KEY_LOCK:
        return _VOICE_KEY


ASK_CLAUDE_TOOL = {
    "type": "function",
    "function": {
        "name": "ask_claude",
        "description": (
            "Look something up. Reaches the user's notes, tasks, files, "
            "repositories and systems, none of which you can see. Use it for "
            "ANYTHING factual or specific to the user's world. It is the normal "
            "way to answer, not an escalation: call it freely and without asking."),
        "parameters": {
            "type": "object",
            "properties": {
                "question": {"type": "string",
                             "description": "The user's question, in full."},
            },
            "required": ["question"],
        },
    },
}

# Backstop for the case the tool contract cannot cover: the front model deciding
# it knows the answer to something factual. A wrong "I'll check" costs a second;
# a wrong "the answer is X" invents something about the user's world and says it
# in the assistant's voice. So anything shaped like a question about the user's
# things goes to Claude no matter what the front model chose.
_FACTUAL = re.compile(r"""(
      \b(what|which|when|where|who|why|how\s+(many|much|long|often))\b
    | \b(did|do|does|have|has|is|are|was|were)\s+(i|we|you|it|there|my|the)\b
    # Asking to enumerate something is asking about the user's world by
    # definition — and it arrives as "can you list…", which matches no
    # interrogative and no auxiliary above.
    | \b(list|show|tell\s+me\s+about|summari[sz]e|remind\s+me)\b
    # PLURALS MATTER: \btask\b cannot match "tasks", because \b needs a
    # non-word character after "task" and "s" is not one. That single missing
    # letter let "can you list all active tasks?" reach the front tier, which
    # answered with an invented task name, an invented count and an invented
    # due date — spoken as fact. Observed 2026-08-04 17:24.
    | \b(status(es)?|tasks?|notes?|files?|vaults?|repos?|repositor(y|ies)
        |deploys?|logs?|transcripts?|objectives?|goals?|commits?
        |branch(es)?|tests?|errors?|meetings?|calendars?|plans?
        |sessions?|projects?|tickets?|issues?|prs?|reviews?)\b
    # INFRASTRUCTURE, added 2026-08-14 after a live fabrication. The list above
    # covers the user's WORK — tasks, notes, repos — because that is what the
    # assistant was originally asked about. It does not cover the user's own
    # SETUP, and a growing share of spoken questions are exactly that.
    #
    # "Can you now give me a complete answer? Can we run the benchmark against
    # the router?" matches nothing above: no interrogative in the first list, no
    # `my`/`our`, and neither "benchmark" nor "router" was a known noun. It went
    # to the front tier, which answered "No — not yet because the necessary
    # router components are missing" — a confident invention about the user's own
    # router, spoken aloud. Same shape as the 2026-08-04 incident, different
    # vocabulary.
    #
    # The asymmetry rule decides the breadth here: a needless consult costs a
    # second, a missed one puts an invented fact in the assistant's mouth. These
    # can only push turns TOWARD Claude — `looks_factual` returns early for
    # anything the chitchat whitelist already matched, so small talk is unaffected.
    | \b(routers?|benchmarks?|models?|endpoints?|shims?|servers?|clusters?
        |pods?|services?|apis?|configs?|configuration(s)?|settings?
        |subscriptions?|accounts?|keys?|tokens?|costs?|latency|throughput
        |containers?|images?|builds?|releases?|versions?)\b
    | \b(my|our)\b
)""", re.I | re.X)


def looks_factual(text: str) -> bool:
    """Would answering this require knowing something about the user's world?

    Deliberately over-broad — "my", a bare "did we", any interrogative — because
    the cost is asymmetric: a needless consult loses a second, a missed one puts
    an invented fact in the assistant's mouth. The conversational whitelist is
    the exemption that keeps that breadth from swallowing "how are you", which
    matches on "are you" alone.
    """
    if is_chitchat(text):
        return False
    return bool(_FACTUAL.search(text))


# A refusal CONTRACT, not a tool. Measured 2026-08-04 across 20 factual trials
# including deliberately subtle phrasings ("so what's left for today", "did that
# finish", "anything I should know about"): zero fabrications. The same model
# given an ask_claude TOOL instead answered "can you list all active tasks?" with
# an invented task, count and due date — it treats a tool as an action needing
# permission, but a refusal token as simply the honest reply. Same model, same
# questions; the channel is what changed.
FRONT_REFUSAL = '{"cannot_answer": true}'

FRONT_SYSTEM = (
    "You are the voice of an assistant in a spoken conversation. Everything you "
    "say is read aloud: ONE short spoken sentence, no markdown, no lists, no "
    "emoji.\n"
    "Answer ONLY from the conversation itself. You have NO access to the user's "
    "notes, tasks, files, code, systems, calendar or history, and no memory of "
    "their work.\n"
    f"If answering would need any of that, reply with EXACTLY this and nothing "
    f"else:\n{FRONT_REFUSAL}\n"
    "This is not a failure and needs no apology or explanation — something else "
    "answers those, instantly, and the user never sees this exchange. Refusing "
    "costs a second; guessing puts an invented fact in the assistant's mouth. "
    "When unsure, refuse.\n"
    "Never say 'I'd have to ask', 'shall I check' or 'I don't have access' — "
    "return the refusal instead.\n"
    "Greetings, thanks, 'can you hear me' and small talk you CAN answer.\n"
    "You are ONE assistant throughout. Never name or speculate about which model "
    "or system is answering, and never describe the parts you are made of."
)

# Full-match, not substring: "hello" is small talk, "hello, what is my most
# important task" is not, and a substring test would route the second one here.
_CHITCHAT = re.compile(r"""^(
      (hi|hello|hey|yo)(\s+there)?
    | good\s+(morning|afternoon|evening)
    | (thanks|thank\s+you|cheers)(\s+(a\s+lot|very\s+much))?
    | how\s+are\s+you(\s+doing)?
    # Informal greetings that READ as questions — "yo what is up" trips the
    # factual backstop on "what" and would wake Claude to say hello.
    | (yo\s+)?(what'?s|what\s+is)\s+up
    | how'?s?\s+(it\s+going|things)
    | sup
    | (can|do)\s+you\s+hear\s+me(\s+now)?
    | are\s+you\s+(there|awake|ok|okay|still\s+there)
    | (say\s+that\s+again|repeat\s+that|come\s+again|pardon)
    | (never\s*mind|forget\s+it)
    | (speak\s+up|louder|slower|slow\s+down)
    | (good\s*night|bye|goodbye|see\s+you)
)$""", re.I | re.X)

# Matches both the well-formed block and the unclosed "<think …" MiniMax
# actually emitted, which a tag-shaped regex alone would miss.
_THINK = re.compile(r"<think\b.*?(?:</think>?|$)", re.S | re.I)

# Spoken text that asks permission or describes looking something up instead of
# having done it. The prompt forbids these and the model produces them anyway —
# observed "You want me to list the tools?" alongside a correct tool call. Said
# aloud it invites an answer, so the user replies "yes" into a turn that is
# already running. Discarded in favour of a neutral filler.
# The assistant is one thing to the user. Anything naming the machinery breaks
# that and is usually wrong as well — observed "I have one tool available called
# ask_claude", and elsewhere it introduced itself as Claude while running on
# MiniMax. Prompting against this failed three times; the reply is filtered
# instead, and a filtered reply becomes a consult.
_LEAK = re.compile(r"""(
      \bask_claude\b | \bminimax\b | \bclaude\b | \banthropic\b
    | \bsystem\s+prompt\b | \blanguage\s+model\b | \bmy\s+tools?\b
    | \btools?\s+available\b | \bi\s+am\s+an?\s+(ai|assistant|model)\b
)""", re.I | re.X)

_HEDGE = re.compile(r"""(
      \b(i'?d|i\s+would|i'?ll)\s+(have\s+to|need\s+to)\b
    | \bwant\s+me\s+to\b | \bshall\s+i\b | \bshould\s+i\b
    | \bdo\s+you\s+want\s+me\b | \byou\s+want\s+me\s+to\b
    | \blet\s+me\s+know\s+if\s+you\b
    # Refusal in prose rather than the contracted JSON. The model gets the
    # judgement right and the format wrong — observed "I do not have any context
    # about what finished", which an access-only pattern missed and the shim
    # then spoke, leaving the user with an apology instead of an answer. Any
    # admission of missing information means the same thing: send it to Claude.
    | \b(do\s+not|don'?t)\s+have\s+(any\s+)?(access|context|information|visibility|details|record)
    | \bno\s+(access|context|information|visibility|record)\s+(to|of|about)\b
    | \bi\s+(do\s+not|don'?t)\s+know\s+(what|which|when|where|who|about)\b
    | \bi\s+can'?t\s+(see|tell|access|find|check|look)\b
    | \b(not|isn'?t)\s+(sure|clear)\s+what\s+you'?re?\s+(referring|talking)\b
)""", re.I | re.X)

_front_history: dict[str, deque] = defaultdict(lambda: deque(maxlen=FRONT_HISTORY))
_front_lock = Lock()


def is_chitchat(text: str) -> bool:
    """Whole utterance is conversational filler with no factual content.

    Whole-utterance, not substring: "hello" is small talk, "hello, what is my
    most important task" is not, and a substring test would exempt the second
    from the factual backstop.
    """
    norm = re.sub(r"[.!?,]+$", "", text.strip().lower())
    norm = re.sub(r"\s+", " ", norm)
    return bool(_CHITCHAT.fullmatch(norm))


def front_route(key: str, prompt: str) -> tuple[str, bool]:
    """Ask the front model to answer or defer. Returns (spoken_text, want_claude).

    The PROXY owns the tool loop, not the model: when ask_claude is called we run
    it here and hand Claude's words to the caller verbatim. Feeding them back to
    the front model for a final answer — the ordinary agent loop — would let it
    reword facts about the user's vault, which is the one thing it must never do.

    Every failure path returns ("", True) so the turn continues to Claude. A front
    tier that swallows a question when the API is slow is worse than none.
    """
    with _front_lock:
        history = list(_front_history[key])
    body = json.dumps({
        "model": FRONT_MODEL,
        "messages": [{"role": "system", "content": FRONT_SYSTEM}] + history +
                    [{"role": "user", "content": prompt}],
        # No tools deliberately — see FRONT_REFUSAL. The tool form was measured
        # worse at the one job that matters, and two refusal mechanisms would be
        # two things to reason about when one of them misbehaves.
        "max_tokens": 120,
        "temperature": 0.7,
        # MiniMax emits reasoning inside `content`, not `reasoning_content`, so
        # without this the whole think-aloud is spoken. Only M3 honours the flag;
        # see patches/speech-to-speech-minimax-thinking.patch for the same fix in
        # the other client. Harmlessly ignored by non-MiniMax endpoints.
        "thinking": {"type": "disabled"},
        # The same job for OpenAI-shaped endpoints, and NOT redundant with the
        # key above — each is honoured by a disjoint set of providers.
        #
        # A local reasoning model reached through Ollama's /v1 endpoint ignores
        # `thinking` entirely and spends the whole max_tokens budget thinking,
        # returning EMPTY content with finish_reason "length". Measured
        # 2026-08-14 on gemma4:e2b-mlx: 2 of 6 chitchat prompts came back empty;
        # with this flag, 0 of 10. The failure is silent and lands in the worst
        # place — front_route returns ("", False) for a non-factual prompt, so
        # want_claude is False and the turn ends having said NOTHING, rather
        # than falling through to Claude. Same shape as the other "0 chars"
        # outages: nothing errors, /readiness stays 200.
        #
        # Ollama's own `"think": false` does nothing on the /v1 endpoint, and a
        # Modelfile `PARAMETER think` is rejected as unknown (0.32.7) — the
        # request body is the only lever.
        "reasoning_effort": "none",
    }).encode()
    req = urllib.request.Request(
        f"{FRONT_BASE_URL}/chat/completions", data=body,
        headers={"Content-Type": "application/json",
                 "Authorization": f"Bearer {FRONT_API_KEY}"})
    try:
        with urllib.request.urlopen(req, timeout=FRONT_TIMEOUT) as resp:
            data = json.loads(resp.read())
        msg = data["choices"][0]["message"]
        text = (msg.get("content") or "").strip()
        # Tool calls are no longer requested, but a model may still emit one;
        # treat it as the deferral it is rather than dropping the turn.
        called = bool(msg.get("tool_calls"))
    except Exception as e:
        print(f"  [{key}] front tier unavailable ({e}) — deferring to Claude", flush=True)
        return "", True
    # Belt and braces: the disable flag is honoured only by some models, and a
    # leaked think-block is not cosmetic — it gets read aloud.
    text = _THINK.sub("", text).strip()

    # The contracted refusal. Matched loosely — the model sometimes wraps it in
    # a code fence or adds a trailing word, and any of those still mean "I
    # cannot answer this".
    if "cannot_answer" in text:
        return "", True

    if called:
        # The tool call is right; the words alongside it may still ask permission
        # for work already under way. Drop those and let the caller supply a
        # neutral filler.
        if _LEAK.search(text) or _HEDGE.search(text):
            print(f"  [{key}] discarding hedged filler: {text[:50]!r}", flush=True)
            text = ""
        return text, True

    # No tool call. A hedge here is worse: it ends the turn having neither
    # answered nor looked anything up, so the user must ask twice. A leak is
    # worse still — it is answering a question about the user's setup from
    # nothing. Both become consults.
    if _HEDGE.search(text) or _LEAK.search(text):
        print(f"  [{key}] front hedged or leaked — consulting: {text[:44]!r}", flush=True)
        return "", True
    if looks_factual(prompt):
        # It chose to answer something it cannot know. Keep the pause-filler if
        # it produced one, discard any claim, and consult anyway.
        print(f"  [{key}] front answered a factual question — forcing consult", flush=True)
        return (text if _HOLDISH.match(text) else ""), True
    return text, False


def remember(key: str, user: str, assistant: str) -> None:
    """Keep the front model's view of the conversation current.

    Claude's answers go in here too. Without them 'say that again' reaches a
    model that never heard the thing it is being asked to repeat.
    """
    if not FRONT_API_KEY or not assistant:
        return
    with _front_lock:
        h = _front_history[key]
        h.append({"role": "user", "content": user[:500]})
        h.append({"role": "assistant", "content": assistant[:500]})

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


def transcript_dir(key: str = "") -> Path:
    """Where Claude Code keeps this working directory's session transcripts.

    The slug is the absolute path with every separator replaced by a dash — the
    same scheme `claude --resume` uses to find a session, which is why binding to
    an id from a DIFFERENT cwd would resolve to nothing.

    `key` resolves the cwd through `identity_for()`, same as a live turn — a
    second identity's transcripts live under ITS cwd, not this instance's
    default one. Empty `key` (the default) keeps every existing caller working
    unchanged against the instance's own default cwd.
    """
    cwd = identity_for(key)["cwd"] if key else CWD
    return Path.home() / ".claude/projects" / str(Path(cwd).resolve()).replace("/", "-")


def available_sessions(key: str = "", limit: int = 15) -> list[dict]:
    """Resumable transcripts for this cwd, newest first, labelled by first prompt.

    A bare uuid is unusable as a choice — you cannot tell the 90-turn voice
    conversation from a one-turn probe. The first user message is the cheapest
    thing that distinguishes them.
    """
    out = []
    for f in sorted(transcript_dir(key).glob("*.jsonl"),
                    key=lambda p: p.stat().st_mtime, reverse=True)[:limit]:
        label, turns = "", 0
        try:
            with f.open() as fh:
                for line in fh:
                    try:
                        d = json.loads(line)
                    except ValueError:
                        continue
                    if d.get("type") != "user":
                        continue
                    c = d.get("message", {}).get("content")
                    if isinstance(c, list):
                        c = " ".join(x.get("text", "") for x in c if isinstance(x, dict))
                    if isinstance(c, str) and c.strip():
                        turns += 1
                        label = label or " ".join(c.split())[:60]
        except OSError:
            continue
        out.append({"id": f.stem, "label": label, "turns": turns,
                    "age_minutes": round((time.time() - f.stat().st_mtime) / 60, 1)})
    return out


def bind_session(key: str, sid: str) -> dict:
    """Point a key at an EXISTING session id. Returns {} on success, else {error}.

    Two refusals, both learned rather than guessed:

    - An id with no transcript makes `claude --resume` fail with "No conversation
      found" on the NEXT turn, long after the bind looked like it worked. Verified
      2026-08-04 against a freshly generated uuid.
    - An id already held by another key would put two keys — each with its own
      lock — on one session file at once. Per-key locking is exactly what makes
      concurrent turns safe, and sharing an id defeats it.
    """
    if not (transcript_dir(key) / f"{sid}.jsonl").exists():
        return {"error": f"no transcript for {sid} in {transcript_dir(key)}"}
    with _sessions_lock:
        data = _load()
        for k, v in data.items():
            if k != key and v.get("id") == sid:
                return {"error": f"{sid} is already bound to {k}"}
        old = data.get(key, {}).get("id", "")
        data[key] = {"id": sid, "started": True, "created": time.time(),
                     "turns": data.get(key, {}).get("turns", 0), "last": time.time()}
        _save(data)
    drop_process(key)   # the running process still holds the OLD id
    return {"bound": key, "id": sid, "previous": old}


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
# Where the live transcript of the call is written. The assistant is NOT told
# this anywhere else, and without it a whole half of the conversation is
# invisible: text typed into the voice channel's chat never reaches the model —
# it goes to disk only. Observed 2026-08-04: a file path was pasted mid-call and
# captured correctly, then "can you check the file I posted in the chat?" was
# answered "I can't see it", because nothing had ever mentioned the file that
# contained it.
TRANSCRIPT_DIR = setting("SHIM_TRANSCRIPT_DIR", "transcript_dir", "").strip()

TRANSCRIPT_DIRECTIVE = (
    f"A live transcript of this call is written to {TRANSCRIPT_DIR}, one folder "
    "per channel per day — the most recently modified is this conversation, in "
    "`transcript.md`.\n"
    "It holds BOTH what everyone said aloud and everything typed into the voice "
    "channel's text chat, in order, with names. Typed messages reach you ONLY "
    "this way; they are never in your context.\n"
    "So when the user refers to anything from earlier — 'the link I posted', "
    "'the path I pasted', 'what we just discussed' — READ that file before "
    "answering. Do not say you cannot see it, and do not assume 'posted' means "
    "an attachment: it usually means a line in that transcript."
) if TRANSCRIPT_DIR else ""

VOICE_DIRECTIVE = (
    "SPOKEN OUTPUT MODE. Your reply is read aloud, not displayed. Speak the way a person "
    "speaks: full, flowing sentences in a natural conversational register. The OPENING "
    "is spoken, so it is never a clipped fragment or a list read out loud.\n"
    "This overrides any output-format rules in CLAUDE.md or memory: no status panels, no "
    "lines beginning with READY/DONE/ACTIVE/WAITING/BLOCKED, no 'You:' or 'Next:' lines, "
    "and no emoji anywhere. Markdown, bullets and code formatting are FORBIDDEN in the "
    "first two sentences (they are spoken) and FINE after them (they are read).\n"
    "NEVER put in the FIRST TWO SENTENCES: identifiers, hashes, session ids, byte counts, "
    "file paths, wikilinks, URLs, line numbers, timestamps or version strings. Those two "
    "sentences are the ones spoken aloud, and such things are noise when heard rather than "
    "read — say 'the transcript file' not its path, 'about thirty turns' not an exact "
    "count. AFTER them, write them out properly: that part is read, not heard, and a path "
    "or an id is exactly what the reader needs to copy.\n"
    "If you are about to look something up, SAY ONE SHORT SENTENCE FIRST — 'let me "
    "check that' — then do the lookup and answer. Speaking before the tool runs is what "
    "keeps the silence from feeling broken; your first sentence is spoken while the work "
    "happens.\n"
    "NEVER NARRATE THE WORK. No 'let me read that', no 'right, so that means', no "
    "explaining where you are about to look or what you just realised. The user "
    "hears a filler while you work and does not need a second one from you — say "
    "the answer and nothing else.\n"
    "SHAPE, NOT LENGTH. Only your FIRST TWO SENTENCES are spoken aloud; everything "
    "after them is read in the channel and never heard. So do not ration the answer — "
    "write it completely — but put the ANSWER FIRST. Those two sentences have to stand "
    "on their own as a spoken reply: the actual answer, no preamble, no 'let me "
    "explain', nothing that only makes sense once the rest has been read. A spoken "
    "answer cannot be skimmed or re-read, which is why the point goes at the front — "
    "not why the detail gets dropped.\n"
    "Then continue: the specifics, the list, the exact names, the caveat. That half is "
    "read at the reader's own pace, so it can carry what speech cannot. Structure it "
    "for reading — short paragraphs or a list — and never with an opening line that "
    "merely announces what follows."
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
    "uh", "um", "ah", "oh", "ooh", "erm", "eh", "alright", "right",
}


def is_filler(text: str) -> bool:
    words = re.findall(r"[\w'-]+", text.lower())
    return 0 < len(words) <= 3 and all(w in _FILLER_WORDS for w in words)


# ── wake phrase ────────────────────────────────────────────────────────────
# In a call the assistant hears every word an allowlisted speaker says — the
# allowlist decides WHO can drive it, never WHETHER a given sentence was meant
# for it. So in company it answered conversations addressed to other people.
#
# A LIST, not a phrase, and the reason is empirical: speech-to-text mangles
# short utterances, and this project's own transcripts have it turning "Wide
# Forest" into "White Forest". Each variant is a deliberate entry — no edit
# distance, no phonetic matching, nothing that widens the surface silently,
# because every variant added is a false-trigger risk accepted on purpose.
#
# Matched as a PREFIX. "so, hey bot, what's my task" deliberately does not
# count: a phrase-anywhere match wakes on any sentence that merely mentions
# the bot, which is exactly the failure this exists to prevent.
#
# Fail quiet: anything unmatched is treated as not addressed. A missed trigger
# costs one repeat; a false trigger interrupts a conversation with other people
# in the room. The two are not equally cheap.
#
# `.strip("\"'")`: the Makefile's `-include local.env` parses with MAKE
# semantics, so `export SHIM_WAKE_PHRASES="a,b"` can arrive with the quote
# characters still inside the value — making the first phrase `"hey bot`, which
# matches nothing anyone says. Same family as the `$HOME` and secret-in-argv
# traps this repo has already been bitten by twice.
WAKE_PHRASES = setting("SHIM_WAKE_PHRASES", "voice.wake_phrases", "hey bot,hey bought,hey but,hi bot").strip("\"'")
# Anchored to the start of a SENTENCE, not just the start of the utterance.
#
# speech-to-speech accumulates a turn across progressive finals, so one
# transcript grows into "Uh can you check my disk space? Hey bot, can you check
# my disk space?" — the phrase is in there, but never at position zero, and a
# whole-utterance prefix match rejected every retry. Observed live: three
# consecutive properly-addressed attempts all went QUIET.
#
# Still anchored, which is the point: "I told him the bot was broken" does not
# match, because the phrase has to OPEN a sentence rather than merely appear.
# Leading disfluencies are skipped, because people do not start a sentence on
# the wake phrase — they start on a hesitation. Three real failures in one call:
# "Uh hey bot, can you check my free disk space?", "Uh hey hey bot, did you hear
# me?", and a "so," lead-in. Requiring the phrase at the literal sentence start
# made the feature unusable in ordinary speech while looking correct in tests
# written from imagined utterances.
#
# The skippable set is `_FILLER_WORDS` — already defined above, and already the
# project's answer to "noises that are not content" — plus "hey", so a doubled
# "hey hey bot" lands. It does NOT widen what counts as a wake phrase: only
# noise may precede it, never a real word.
_WAKE_LEAD = r"(?:(?:" + "|".join(sorted(_FILLER_WORDS | {"hey"})) + r")[\s,.!?-]+){0,3}"
_WAKE_RE = re.compile(
    r"(?:\A|[.!?]\s+|\n)\W*"
    + _WAKE_LEAD
    + r"(?:"
    + "|".join(re.escape(p.strip()) for p in WAKE_PHRASES.split(",") if p.strip())
    + r")\b",
    re.I,
)


def is_addressed(text: str) -> bool:
    """Does a sentence in this utterance open with a wake phrase?

    `search`, not `match`, because the turn may have accumulated — see the
    regex above. Empty phrase list disables the gate.
    """
    if not WAKE_PHRASES.strip():
        return True
    return bool(_WAKE_RE.search(text))


def strip_wake_phrase(text: str) -> str:
    """Drop the address so the model receives the question, not the greeting.

    "Hey bot, what's my most important task?" reaches Claude as "what's my most
    important task?" — the phrase is how you got its attention, not part of what
    you asked. Left in, a bare "Hey bot." is a greeting the model will answer as
    one, and every real question carries a vocative it may echo back.

    Falls back to the original text when stripping would leave nothing, so a
    bare wake phrase still reaches the model as something rather than an empty
    prompt the endpoint would reject.
    """
    if not WAKE_PHRASES.strip():
        return text
    # Everything BEFORE the wake phrase is dropped along with it: on an
    # accumulated turn that leading text is whatever was said to the room
    # before the assistant was addressed, and feeding it to the model asks the
    # wrong question. Keep only from the phrase onward.
    m = _WAKE_RE.search(text)
    if not m:
        return text
    stripped = text[m.end() :].lstrip(" ,.:;-—")
    return stripped if stripped.strip() else text


_PANEL = re.compile(
    r"^\s*[\U0001F7E2\U0001F7E1\U0001F534\U0001F535\u26AA][^\n]*$"   # 🟢🟡🔴🔵⚪ …
    r"|^[^\w\n]{1,6}\s*(?:You|Next|Recommend)\s*:.*$"                    # 👤 You: / ⏰ Next:
    r"|^[^\w\n]{0,6}\s*(?:\*\*)?(?:READY|DONE|ACTIVE|WAITING|BLOCKED)\b[^\n]*$"
    # 📌 / 🎯 — the task and goal ANCHOR lines that sit above the panel. Missed
    # until a real call put "📌 No task anchor — read-only lookup" in the
    # channel: the icon set above covers the panel's own state line but not the
    # two lines that introduce it, so half a panel was stripped and half posted.
    r"|^\s*[\U0001F4CC\U0001F3AF][^\n]*$",                               # 📌 / 🎯
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
# Measured from the start of the turn, and small because the tool_use gate below
# already establishes that a wait is coming. This was 3s when the filler fired on
# time alone — a shorter threshold then interjected in front of answers that were
# already arriving at ~2.4s. Once a tool is running the answer is provably many
# seconds away, so there is nothing left to interrupt and the delay was pure
# cost: it was the largest single slice of the ~4s before the user heard anything.
HOLD_AFTER = setting("SHIM_HOLD_AFTER", "voice.hold_after", 0.5)
# Well inside speech-to-speech's 20s read timeout, and cheap: an empty SSE delta
# is a few dozen bytes and produces no speech.
KEEPALIVE_EVERY = setting("SHIM_KEEPALIVE_EVERY", "voice.keepalive_every", 8.0)
# Fallback for a turn that is slow WITHOUT using tools. Rare, so the threshold is
# generous: better to say nothing than to interject into an answer that is coming.
HOLD_MAX = setting("SHIM_HOLD_MAX", "voice.hold_max", 8.0)
# One filler covers a 6-15s turn. A vault question can take 30s — measured at
# 30.4s live — and past about ten seconds silence reads as failure again, which
# is exactly what the filler existed to prevent. Repeating it keeps the turn
# audibly alive. 0 disables.
PROGRESS_EVERY = setting("SHIM_PROGRESS_EVERY", "voice.progress_every", 12.0)
# Hard cap on how many sentences are SPOKEN. The voice directive asks for two and
# fresh sessions obey, but a long-running one does not: measured 741 characters,
# five or six sentences, on a session with hundreds of turns behind it. In-context
# precedent beats an instruction — the model imitates its own earlier answers,
# and every long answer makes the next one likelier. A directive cannot win that
# argument, so it is enforced here instead. 0 disables.
SPOKEN_MAX = setting("SHIM_SPOKEN_MAX", "voice.spoken_max", 2)
# Points at the written copy rather than offering to continue: the rest is
# already in the channel by the time this is heard, so "if you want it" invited
# the listener to ask for something they had already been given.
_MORE_LINE = "The details are in the chat."
# Two sentences each, for the same reason as _CHECK_LINES: speech-to-speech
# releases a sentence only once the next has started, so a lone line would wait
# for the answer and arrive just before it — useless.
_PROGRESS_LINES = (
    "Still looking. Won't be much longer.",
    "Still on it. Nearly there.",
    "Still working through this. One moment.",
    "Give me a little longer. Almost done.",
)
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

# Spoken when we KNOW a lookup is under way — the question was recognised as
# factual, or the model asked for the tool. Saying so is more use than "hang on":
# it tells the user the request landed and is being worked, which is the whole
# point of speaking early. Kept separate from _HOLD_LINES because the timer path
# fires on silence alone and cannot know what, if anything, is happening.
_CHECK_LINES = (
    "Let me check that. One second.",
    "I'll look that up. Won't be long.",
    "Checking that now. One moment.",
    "Let me find that. Just a second.",
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


# ── postable-shape detector ─────────────────────────────────────────────────
# "Truncated" alone misses the answer that is pure payload and never runs long
# enough to hit SPOKEN_MAX — the task's own evidence: "ARC-L1 Wide Forest
# Station", one sentence, never truncated, exactly the thing that needed to be
# written down. This is the second trigger, content shape rather than length.
_URL_RE = re.compile(r"https?://\S+")
_LIST_LINE_RE = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+\S", re.M)
# A hyphen/underscore token with a digit in it somewhere — "ARC-L1",
# "task_42", "v0.4.3" style identifiers. \w excludes hyphens, so the digit
# lookahead has to scan the whole allowed charset, not just \w*.
_CODE_RE = re.compile(r"\b(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9]+(?:[-_][A-Za-z0-9]+)+\b")
# Two or more consecutive Capitalized Words — catches a proper noun with no
# digit in it at all, e.g. "Wide Forest Station", which _CODE_RE cannot see.
_TITLE_RUN_RE = re.compile(r"\b(?:[A-Z][a-z]+\s+){1,}[A-Z][a-z]+\b")


# Asking for it in writing is an intent, and intent lives in the USER's turn —
# no amount of looking at the answer can see it. Found on a live call
# 2026-08-09: "can you check what we last bought and write it to the chat?" was
# answered in two sentences of plain prose, so neither trigger fired and
# nothing was posted. Correct by the letter of both triggers, and exactly wrong.
#
# Still a code-side decision, not a model judgement — and the failure mode is
# safe in the direction that matters: an unmatched phrasing just falls back to
# the other two triggers, it never posts something it shouldn't.
_CHAT_REQUEST_RE = re.compile(
    r"\b(?:write|put|post|type|send|drop|paste|share)\b[^.?!]{0,40}?"
    r"\b(?:in|into|to|on)\b\s+(?:the\s+)?(?:chat|channel|text)\b"
    r"|\bin\s+writing\b|\bwrite\s+(?:it|that|this|them)\s+down\b",
    re.I)


def _wants_chat_post(prompt: str) -> bool:
    """Did the user ASK for this in writing? Third trigger, read off their turn."""
    return bool(_CHAT_REQUEST_RE.search(prompt))


def _has_postable_shape(text: str) -> bool:
    """Would this answer be worth reading back later, even if never truncated?

    Deliberately a code-side detector, not a model judgement — see the task's
    `# Design`: asking the model to decide is a decision already reversed
    three times elsewhere in this file (routing, filler timing, length).
    """
    if _URL_RE.search(text) or _PATHISH.search(text) or _UUID.search(text):
        return True
    if _CODE_RE.search(text) or _TITLE_RUN_RE.search(text):
        return True
    return len(_LIST_LINE_RE.findall(text)) >= 2


def post_chat_message(text: str) -> None:
    """POST the full answer to the bot's chat-bridge route. Never raises.

    No channel id in the payload — the bot owns routing to whichever voice
    call is actually live (see `# Design`). Best-effort: a failure here must
    never take down a voice turn that has already been spoken.
    """
    if not CHAT_BRIDGE_TOKEN:
        print("  chat bridge: CHAT_BRIDGE_TOKEN not set — skipping post", flush=True)
        return
    try:
        body = json.dumps({"text": text}).encode()
        req = urllib.request.Request(
            CHAT_BRIDGE_URL, data=body, method="POST",
            headers={"Content-Type": "application/json",
                     "Authorization": f"Bearer {CHAT_BRIDGE_TOKEN}"})
        with urllib.request.urlopen(req, timeout=CHAT_BRIDGE_TIMEOUT) as resp:
            resp.read()
        print(f"  chat bridge: posted ({len(text)} chars)", flush=True)
    except Exception as e:
        print(f"  chat bridge: post failed ({e})", flush=True)


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
        # Persona/cwd/launcher/tools are resolved PER KEY, not read off the
        # module-level CWD/CLAUDE_SCRIPT/MCP_CONFIG/ALLOWED_TOOLS constants —
        # see `identity_for()`. That is the actual routing fix: a second
        # identity's key — `voice:<guildId>:<identity>` or
        # `thread:`/`channel:`/`dm:<id>:<identity>` — now spawns its own
        # process against its own cwd, rather than every turn landing in
        # this instance's one default persona.
        identity = identity_for(key)
        cwd = identity["cwd"]
        claude_script = identity["claude_script"]
        mcp_config = identity["mcp_config"]
        allowed_tools = identity["allowed_tools"]

        # A launcher, when configured, OWNS the environment flags: model,
        # effort, router base URL, --add-dir set, MCP config. Restating them
        # here is how the bot's Claude silently drifted from the desk's —
        # different model, no --add-dir, so a session resumed through `switch`
        # lost capabilities its own history showed it once had.
        cmd = ([claude_script] if claude_script else ["claude"]) + [
               "-p",
               "--input-format", "stream-json", "--output-format", "stream-json",
               # Without this, only COMPLETE assistant events arrive, so there is
               # nothing to stream and the whole reply lands at once — measured
               # first-token == total == 5.5s on a warm process. With it, text
               # arrives token-by-token and TTS can start on the first sentence.
               "--include-partial-messages",
               "--verbose", "--permission-mode", "auto"]
        # Only assert the MCP set when nothing else is: a launcher passes its
        # own --mcp-config, and while the CLI tolerates the flag twice, which
        # copy wins is not something to depend on.
        if not claude_script:
            cmd += ["--mcp-config", mcp_config, "--strict-mcp-config"]
        if CLAUDE_MODEL:
            cmd += ["--model", CLAUDE_MODEL]
        if not UNSAFE:
            cmd += ["--allowed-tools", allowed_tools]
        cmd += ["--resume", session_id] if resume else ["--session-id", session_id]
        if system:
            cmd += ["--append-system-prompt", system]

        self._key = key
        self._session_id = session_id
        self._cwd = cwd
        self._last_used = time.time()

        # stdout goes to a PTY, not a pipe. Claude Code block-buffers when it
        # is not on a terminal, so every event of a turn arrives at once at the
        # end — measured: acknowledgement and answer both landing at 32.4s. On a
        # PTY it line-buffers, and the same turn yields "let me check" at 3.0s
        # with the answer at 7.8s. That early sentence is what TTS speaks while
        # the tools run, instead of dead air.
        self._pty_main, pty_child = pty.openpty()
        self._proc = subprocess.Popen(
            cmd, cwd=cwd, stdin=subprocess.PIPE, stdout=pty_child,
            stderr=subprocess.DEVNULL, text=True, bufsize=1,
        )
        os.close(pty_child)
        self._out = os.fdopen(self._pty_main, "rb", 0)
        self._buf = b""
        # cwd logged unconditionally, not only when it differs from the
        # default — the whole point of per-key persona is that this line is
        # what proves a spoken turn was answered by the RIGHT identity, not
        # inferred from the reply. See the task's first Success Criterion.
        print(f"  [{key}] spawned claude ({'resume' if resume else 'new'} {session_id[:8]}) cwd={cwd}", flush=True)

    def alive(self) -> bool:
        return self._proc.poll() is None

    def interrupt(self) -> None:
        """Abandon the in-flight turn without killing the session.

        Verified: the turn ends within ~0.1s with a `result` carrying
        subtype 'error_during_execution', and the SAME process answers the next
        prompt normally — so the session is not desynchronised by this. That
        second property is what makes it safe; without it, waiting out the dead
        turn would be the lesser evil.
        """
        try:
            self._proc.stdin.write(json.dumps({
                "type": "control_request",
                "request_id": str(uuid.uuid4()),
                "request": {"subtype": "interrupt"},
            }) + "\n")
            self._proc.stdin.flush()
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

    def ask(self, prompt: str, on_text=None, is_gone=None,
            already_held=False) -> tuple[str, bool]:
        """Run one turn. `on_text` receives assistant text as it arrives.

        The `assistant` event carries the reply BEFORE `result` — measured 6.1s
        vs 8.7s on a plain question, and much wider when the turn uses tools,
        because `result` waits for every tool to finish. Waiting for `result`
        therefore throws away speech-ready text; emitting on `assistant` lets
        TTS start earlier and lets the model say "let me check" while it works,
        which is exactly what the voice prompt asks for and never got.

        Returns `(text, truncated)` — `truncated` is whether the SPOKEN_MAX cap
        actually cut something short (see `push()`), so a caller can tell "the
        full text has more than what was spoken" apart from "this is all of it".
        """
        msg = {"type": "user",
               "message": {"role": "user", "content": [{"type": "text", "text": prompt}]}}
        self._proc.stdin.write(json.dumps(msg) + "\n")
        self._proc.stdin.flush()

        seen: list[str] = []
        pending = ""       # partial text not yet handed to on_text
        streamed = False   # did any partial reach on_text this turn?
        # `already_held` means the front tier has spoken a filler for this turn.
        # Marking it held both stops us adding a second one and suppresses
        # Claude's own opening "let me check that" as a duplicate.
        held = already_held
        first_out = True   # next emitted sentence is the model's first
        gone = False       # listener hung up; abandon as soon as we notice
        tool_seen = False  # Claude reached for a tool, so a real wait is coming
        # When the listener last heard anything, filler included. A list so the
        # watcher thread can read a value the request thread updates.
        last_spoken = [time.monotonic()]
        spoken = 0         # sentences of real answer actually voiced
        truncated = False  # the "there's more" line has been said once

        def mark_spoken():
            last_spoken[0] = time.monotonic()

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
                # Suppressed as a duplicate of the filler we already spoke.
                # Deliberately does NOT set `streamed`: that flag means real
                # text reached the listener, and it silences the progress
                # watcher. Setting it here left a 34s turn with one filler and
                # then nothing, because the watcher believed we were mid-reply
                # while the only thing produced had just been thrown away.
                first_out = False
                return
            first_out = False

            # Past the cap: say so once, then stay quiet. Cutting mid-answer
            # without acknowledging it sounds like a fault; offering the rest is
            # what the directive asks for anyway, and the full text is still
            # returned to the caller and written to the transcript.
            nonlocal spoken, truncated
            # A sentence ending in a colon promises the answer rather than being
            # it. Counting those spent the budget on throat-clearing: "typed
            # messages only reach me through the transcript." / "Let me read
            # it:" hit the cap before a single word of the answer, so the user
            # heard the preamble and then "there's more if you want it".
            lead_in = part.rstrip().endswith(":")
            if lead_in:
                try:
                    on_text(part)
                    mark_spoken()
                    streamed = True
                except ClientGone:
                    gone = True
                return

            if SPOKEN_MAX > 0 and spoken >= SPOKEN_MAX:
                if truncated:
                    # Still producing, just not voicing it. Count it as speech
                    # anyway or the progress watcher decides we have gone quiet
                    # and interjects "still on it" after "there's more if you
                    # want it" — which sounds like the turn broke.
                    mark_spoken()
                    return
                truncated = True
                part = _MORE_LINE
            try:
                on_text(part)
            except ClientGone:
                gone = True
                return
            spoken += 1
            streamed = True
            mark_spoken()

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
                mark_spoken()
            except ClientGone:
                gone = True     # the write is also how we learn they left
            except Exception:
                pass            # a failed filler must never break the turn

        # Wait for EVIDENCE of work, not merely for time to pass. A bare timer
        # fires on any slow turn, so "thank you" was answered with "checking
        # now" — a holding line in front of a reply that needed no lookup at
        # all. A tool_use block is the signal that a wait is genuinely coming.
        hold_stop = Event()

        said_before: list[str] = []

        def speak_progress_line():
            nonlocal gone
            if gone or not on_text:
                return
            # Never the same line twice running. Random choice repeats about a
            # quarter of the time with four options, and hearing "still looking"
            # verbatim twice in a row sounds like the bot is stuck rather than
            # working.
            choices = [ln for ln in _PROGRESS_LINES if ln not in said_before[-1:]]
            line = random.choice(choices or list(_PROGRESS_LINES))
            said_before.append(line)
            try:
                on_text(line)
                mark_spoken()
            except ClientGone:
                gone = True
            except Exception:
                pass

        def hold_watch():
            """Keep the turn audible: speak whenever the listener has heard
            nothing for a while.

            The test is time since the last thing SPOKEN, not whether anything
            has been spoken at all. A turn commonly says "let me take a look",
            then works silently for another twenty seconds — an
            anything-yet test stops watching at the first word and leaves
            exactly the dead air it was added to prevent.
            """
            began = time.monotonic()
            opened = already_held          # front tier already spoke for us
            while not hold_stop.wait(0.4):
                if gone:
                    return
                now = time.monotonic()
                if not opened:
                    if (tool_seen and now - began >= HOLD_AFTER) or now - began >= HOLD_MAX:
                        speak_holding_line()
                        opened = True
                    continue
                if PROGRESS_EVERY > 0 and now - last_spoken[0] >= PROGRESS_EVERY:
                    speak_progress_line()

        # Runs even when the front tier already spoke: the first filler is then
        # skipped, but the progress lines still cover the long tail.
        if on_text and (HOLD_AFTER > 0 or PROGRESS_EVERY > 0):
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
                print(f"  [{self._key}] listener gone — interrupting turn", flush=True)
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
                self._last_used = time.time()
                final = str(event.get("result") or "").strip()
                # `result` repeats the last assistant text; return what was
                # already emitted so the caller does not say it twice.
                return (final if not seen else "\n".join(seen)), truncated
        stop_timer()
        raise TimeoutError(f"no result within {TIMEOUT}s")

    def close(self):
        try:
            self._proc.stdin.close()
        except Exception:
            pass
        try:
            self._out.close()
        except Exception:
            pass
        try:
            self._proc.terminate()
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


def ask_claude(key: str, system: str, prompt: str, on_text=None, is_gone=None,
               already_held=False) -> tuple[str, bool, bool]:
    """Ask over the persistent process, respawning once if it has died.

    Returns `(text, truncated, ok)`. `ok` is False on every error/timeout
    fallback path — those return a synthetic sentence like "(claude
    unavailable: ...)" for the ordinary text/voice reply, which is fine to
    speak or show inline, but the chat-bridge trigger must never mistake one
    for a real answer: `_has_postable_shape` can match a local filesystem
    path or an error class name inside the sentinel text and post it to the
    channel as if it were content. See do_POST's `if answer and ok and ...`.
    """
    for attempt in (1, 2):
        proc = get_process(key, system)
        began = time.monotonic()
        try:
            out, truncated = proc.ask(prompt, on_text=on_text, is_gone=is_gone,
                                       already_held=already_held)
            mark_started(key)
            print(f"  [{key}] {time.monotonic() - began:.1f}s, {len(out)} chars", flush=True)
            return out, truncated, True
        except (RuntimeError, BrokenPipeError, OSError) as e:
            print(f"  [{key}] process failed ({e}), attempt {attempt}", flush=True)
            drop_process(key)
            if attempt == 2:
                return f"(claude unavailable: {e})", False, False
        except TimeoutError as e:
            print(f"  [{key}] {e}", flush=True)
            return f"(timed out after {TIMEOUT}s)", False, False
    return "(claude unavailable)", False, False


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
            text, _truncated, _ok = ask_claude(key, system, prompt)
            return text
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
        self._h = handler
        self._id = f"chatcmpl-{uuid.uuid4().hex[:24]}"
        self._created = int(time.time())
        self._started = False
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
        if self._started:
            self._raw({})

    def _send(self, delta: dict, finish=None):
        if not self._started:
            self._h.send_response(200)
            self._h.send_header("Content-Type", "text/event-stream")
            self._h.send_header("Cache-Control", "no-cache")
            self._h.send_header("Connection", "close")
            self._h.end_headers()
            self._started = True
            self._raw({"role": "assistant", "content": ""})
        self._raw(delta, finish)

    def _raw(self, delta: dict, finish=None):
        chunk = {"id": self._id, "object": "chat.completion.chunk", "created": self._created,
                 "model": MODEL,
                 "choices": [{"index": 0, "delta": delta, "finish_reason": finish}]}
        with self._wlock:
            self._h.wfile.write(f"data: {json.dumps(chunk)}\n\n".encode())
            self._h.wfile.flush()

    def chunk(self, text: str):
        if text:
            self._send({"content": text})

    def finish(self):
        if not self._started:
            self._send({"content": ""})
        self._raw({}, finish="stop")
        self._h.wfile.write(b"data: [DONE]\n\n")
        self._h.wfile.flush()


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
        # A header means the bot made the call and knows its own conversation.
        # No header means speech-to-speech, which cannot send one — so the key
        # is whatever the bot last bound for voice, not a fixed default.
        return self.headers.get("X-Session-Key") or voice_key()

    def do_GET(self):
        path = self.path.rstrip("/")
        if path.endswith("/models"):
            return self._json(200, {"object": "list", "data": [
                {"id": MODEL, "object": "model", "owned_by": "anthropic"}]})
        if path.endswith("/sessions/available"):
            return self._json(200, {"available": available_sessions(self._key())})
        if path.endswith("/sessions"):
            now = time.time()
            # `live` is the difference between an id that answers immediately and
            # one that costs a cold spawn (~3s more) on its next turn: the mapping
            # outlives the process, so a persisted id says nothing about warmth.
            with _procs_lock:
                live = {k for k, p in _procs.items() if p.alive()}
            return self._json(200, {"sessions": [
                {"key": k, "id": v["id"], "turns": v.get("turns", 0),
                 "live": k in live,
                 "age_minutes": round((now - v.get("created", now)) / 60, 1)}
                for k, v in sorted(_load().items())
            ]})
        self._json(404, {"error": {"message": "not found"}})

    def do_POST(self):
        if self.path.rstrip("/").endswith("/sessions/bind"):
            key = self._key()
            try:
                n = int(self.headers.get("Content-Length") or 0)
                sid = (json.loads(self.rfile.read(n) or b"{}").get("id") or "").strip()
            except ValueError:
                return self._json(400, {"error": {"message": "bad json"}})
            if not sid:
                return self._json(400, {"error": {"message": "id required"}})
            res = bind_session(key, sid)
            if "error" in res:
                print(f"-> BIND [{key}] refused: {res['error']}", flush=True)
                return self._json(409, {"error": {"message": res["error"]}})
            print(f"-> BIND [{key}] {sid} (was {res['previous'] or 'none'})", flush=True)
            return self._json(200, res)

        # The bot calls this immediately before pushing a typed turn into its
        # s2s socket — see `_TYPED_TURN_HINTS`. Deliberately takes no body: the
        # text arrives the normal way, this only says which SURFACE asked.
        if self.path.rstrip("/").endswith("/voice/bind"):
            # The bot names the conversation spoken turns belong to. Sent on
            # join only — never unbound on leave, because no spoken turn exists
            # while no call is live, and leaving the pointer where it is means a
            # straggling turn lands in the conversation it was spoken into.
            key = self.headers.get("X-Session-Key") or DEFAULT_KEY
            previous = bind_voice_key(key)
            print(f"-> VOICE KEY [{key}] (was {previous})", flush=True)
            return self._json(200, {"key": key, "previous": previous})

        # Sticky, and sent whenever the room changes — not per turn. The bot is
        # the only side that can see who is in the voice channel; the shim is
        # the only side that runs the wake gate. Same out-of-band shape as
        # /voice/bind above, for the same reason: speech-to-speech owns the HTTP
        # call and can attach no headers of its own.
        if self.path.rstrip("/").endswith("/voice/solo"):
            solo = self.headers.get("X-Voice-Solo", "").strip().strip("\"'").lower()
            previous = set_solo(solo in ("1", "true", "yes", "on"))
            print(f"-> SOLO [{is_solo()}] (was {previous})", flush=True)
            return self._json(200, {"solo": is_solo(), "previous": previous})

        if self.path.rstrip("/").endswith("/turns/typed"):
            key = self._key()
            if self.headers.get("X-Turn-Typed", "").lower() == "false":
                clear_typed_turn(key)
                print(f"-> TYPED [{key}] hint cleared", flush=True)
                return self._json(200, {"typed": False, "key": key})
            mark_typed_turn(key)
            print(f"-> TYPED [{key}] next turn came from the keyboard", flush=True)
            return self._json(200, {"typed": True, "key": key})

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
        # Consumed here, once, at the top of the turn it belongs to — so an
        # abandoned or superseded turn cannot leave the flag behind for an
        # unrelated later one.
        typed_turn = take_typed_turn(key)

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
        # Mode follows the TRANSPORT, not the key. Once a voice channel's text
        # chat began sharing the spoken session (both key on `default`), keying
        # off the session alone made typed messages answer in speech: "It's the
        # fifth of August, twenty twenty-six" — numbers spelled out, capped at two
        # sentences — to something typed. An explicit header wins in both
        # directions; the keyless default only applies when nothing says
        # otherwise, which is exactly the speech-to-speech case (it owns the HTTP
        # call and can set no headers).
        mode = self.headers.get("X-Output-Mode", "").lower()
        voice = is_voice_turn(mode, key, low)
        print(f"-> {'VOICE' if voice else 'TEXT '} [{key}] {prompt[:70]!r}", flush=True)

        # Wake phrase: in a call the assistant hears everything said by an
        # allowlisted speaker, including whole conversations addressed to other
        # people, and answered all of it. Same silence mechanism as the filler
        # check above — empty content, so speech-to-speech synthesises nothing
        # and no filler line is ever spoken.
        #
        # VOICE ONLY, and never a typed turn. A typed message already had to
        # carry an @mention or arrive in a thread/DM to be answered at all, so
        # it is addressed by construction; demanding a wake phrase on top of
        # that would be asking the user to say it twice.
        # ALONE, the gate is off. "Better silent than too eager" was priced on a
        # false trigger interrupting a room; with no room there is nothing to
        # interrupt, and the cost of a miss (say it again) is unchanged. This
        # reverses only WHEN the gate is armed — how it matches is untouched.
        if voice and not typed_turn:
            solo = is_solo()
            if not solo and not is_addressed(prompt):
                print(f"-> QUIET [{key}] not addressed: {prompt[:60]!r}", flush=True)
                if req.get("stream"):
                    return self._stream("")
                return self._json(200, self._completion(""))
            # Addressed: hand on the question without the address. The full
            # utterance, wake phrase and all, is already in the transcript —
            # this only changes what the model is asked. Still stripped when
            # solo: saying "hey bot" out of habit should not change the
            # question the model is asked, and strip_wake_phrase is a no-op on
            # an utterance that carries no phrase.
            prompt = strip_wake_phrase(prompt)

        # The transcript directive is voice-only: it is the record of a call,
        # and a text surface already has its own history in the thread.
        parts = [p for p in (system, MEMORY_DIRECTIVE,
                             VOICE_DIRECTIVE if voice else TEXT_DIRECTIVE,
                             TRANSCRIPT_DIRECTIVE if voice else "",
                             CHAT_BRIDGE_DIRECTIVE
                             if (voice and CHAT_BRIDGE_TOKEN) else "") if p]
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

        # Front tier decides, proxy executes. The front model either answers pure
        # conversation itself — which never wakes Claude — or asks for the tool
        # and gives us a pause-filler to speak while Claude works. Voice only: a
        # text surface has no latency problem worth a second model.
        pre_spoken = False
        if voice and FRONT_API_KEY:
            # Three ways, cheapest first.
            #
            #   recognised chat  -> front answers                       ~1.0s
            #   plainly factual  -> Claude, filler decided locally      0.14s
            #   anything else    -> front under the refusal contract
            #
            # The middle case skips the round trip because the wording already
            # settles it: asking the model costs ~3s of silence to be told what
            # a regex knew for free.
            #
            # The third case is why this is not just an allowlist. A whitelist
            # cannot enumerate every way of being conversational — "yo what's
            # up" is chat, "did that finish" is not, and neither matches a
            # pattern worth writing. The refusal contract handles that band, and
            # handles it safely: 20 factual trials including subtle phrasings,
            # zero fabrications.
            #
            # The factual patterns stay as defence in depth rather than as the
            # gate. They were the gate once, and a single missing "s" —
            # \btask\b cannot match "tasks" — let an invented task, count and
            # due date be spoken as fact (2026-08-04 17:24).
            if FRONT_HEURISTICS and is_chitchat(prompt):
                said, want_claude = front_route(key, prompt)
            elif FRONT_HEURISTICS and looks_factual(prompt):
                said, want_claude = random.choice(_CHECK_LINES), True
            else:
                said, want_claude = front_route(key, prompt)
            # Models commonly return EITHER content OR tool calls, so asking for
            # a pause-filler alongside the call gets one only sometimes. Supply
            # our own when it does not — unless fillers are switched off, in
            # which case the pause is left bare on purpose.
            if want_claude and not said and HOLD_AFTER > 0:
                said = random.choice(_CHECK_LINES)
            if said and live:
                try:
                    writer.chunk(strip_markdown(said) + " ")
                    pre_spoken = True
                except (BrokenPipeError, ConnectionResetError):
                    dead = True
            if not want_claude:
                said = strip_markdown(said)
                print(f"-> FRONT [{key}] {said[:60]!r}", flush=True)
                remember(key, prompt, said)
                if live:
                    writer.finish()
                    return
                return self._stream(said) if req.get("stream") else \
                    self._json(200, self._completion(said))
            print(f"-> ASK   [{key}] front deferred{' (said filler)' if said else ''}",
                  flush=True)

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
                answer, truncated, ok = ask_claude(
                    key, "\n\n".join(parts), prompt,
                    on_text=on_text if live else None,
                    is_gone=(lambda: peer_hung_up(self.connection)) if live else None,
                    already_held=pre_spoken)
        finally:
            stop_keepalive.set()

        if live:
            # Claude's answer is what the user heard, so it is what the front
            # tier must believe it said — otherwise "say that again" is answered
            # by a model with no idea what came before.
            remember(key, prompt, strip_markdown(answer))
            if not dead:
                try:
                    writer.finish()
                except (BrokenPipeError, ConnectionResetError):
                    self.close_connection = True
            # The chat bridge: post the FULL answer, not what was spoken.
            # Two triggers, either is enough — see `# Design`, "What still
            # needs deciding during implementation": length alone misses a
            # short pure-payload answer that never hit SPOKEN_MAX. `ok` guards
            # against posting a sentinel failure string as if it were content
            # — "(claude unavailable: ...)" routinely contains a local path or
            # an error-class name that _has_postable_shape happily matches.
            #
            # Every decision is logged WITH ITS REASON, including the decision
            # not to post. Without it a non-post and a broken bridge look
            # identical from the outside — the same class of blindness that made
            # the 2026-08-04 Discord outage take four restarts to diagnose,
            # where a filtered event and an event that never arrived were
            # indistinguishable until both were logged before filtering.
            if not answer or not ok:
                reason = "no answer" if not answer else "failed turn"
                print(f"  chat bridge: not posting ({reason})", flush=True)
            else:
                # `typed_turn` first, and unconditional: asking from the
                # keyboard is the strongest possible signal that the answer is
                # wanted in a form you can keep. The other three are
                # inferences about the answer; this one is a fact about the
                # question. Spoken turns keep the inferences, so a spoken
                # "hello" still does not litter the channel.
                why = ("the question was typed" if typed_turn
                       else "asked for it in writing" if _wants_chat_post(prompt)
                       else "spoken reply was truncated" if truncated
                       else "answer has postable shape" if _has_postable_shape(answer)
                       else "")
                if why:
                    print(f"  chat bridge: posting — {why}", flush=True)
                    # strip_panels, same as the text branch below. The bridge
                    # posts into a Discord channel, which is a chat window and
                    # not a terminal — its docstring says "applied to BOTH
                    # surfaces", and this path was the one place that skipped
                    # it, so "📌 No task anchor" and "⏰ Next:" lines were
                    # landing in the channel verbatim.
                    post_chat_message(strip_panels(answer))
                else:
                    print("  chat bridge: not posting (short, plain, "
                          "and not requested)", flush=True)
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
    print(f"  claude   {CLAUDE_SCRIPT or 'claude (bare — no launcher configured)'}")
    print(f"  config   {CONFIG_FILE if _CFG else str(CONFIG_FILE) + ' (absent, using env + defaults)'}")
    if IDENTITIES:
        for guild_id, overrides in sorted(IDENTITIES.items()):
            print(f"  identity {guild_id} -> cwd={overrides.get('cwd', CWD)}")
    else:
        print("  identities  none configured — every key resolves to the default persona")
    ThreadingHTTPServer((HOST, PORT), Handler).serve_forever()
