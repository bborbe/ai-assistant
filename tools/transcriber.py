#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["mlx-audio", "soundfile", "soxr", "numpy"]
# ///
"""Watch for voice segments and append a merged, speaker-labelled transcript.

    make transcriber          # or: uv run tools/transcriber.py

Dependencies are declared inline (PEP 723), so `uv run` resolves them itself —
no shared venv and no dependency on a speech-to-speech checkout being present.
The Parakeet weights come from the shared HuggingFace cache, so nothing is
downloaded twice.

Deliberately a SEPARATE process from the bot: STT is slow and
occasionally fails, and neither should ever stall a live conversation. If this
is not running, segments simply pile up on disk and can be transcribed later —
the audio is never lost.

Segments are named `<epoch_ms>-<name>-<userId>.wav`, so ordering the transcript
is a filename sort rather than anything cleverer. Discord already separated the
speakers (one stream per SSRC), which is the expensive half of diarization.
"""

from __future__ import annotations

import os
import re
import sys
import time
from datetime import datetime, timezone
from pathlib import Path

import mlx.core as mx
import numpy as np
import soundfile as sf
import soxr

ROOT = Path(os.environ.get("TRANSCRIPT_DIR", Path.home() / "Documents/transcripts"))
POLL_SECONDS = float(os.environ.get("TRANSCRIBER_POLL", "2"))
STT_RATE = 16000
KEEP_AUDIO = os.environ.get("TRANSCRIBER_KEEP_AUDIO") == "1"

# MLX keeps freed Metal buffers in a cache instead of returning them to the OS.
# Every utterance is a different length, so each allocation is a new size class
# the cache cannot reuse — it accrues one bucket per distinct shape and grows
# without bound. Measured 2026-08-10: this process sat at 9.3 GB while IDLE for a
# model that is ~1.2 GB, the rest being cache retained from a meeting transcribed
# hours earlier. The live pipeline, running both STT and TTS per turn, grew about
# 18 GB/hour and took the laptop into 66 GB of swap.
#
# `phys_footprint` is the only metric that shows this: `ps` RSS reads ~20x low
# because it does not count MPS/MLX unified-memory allocations.
CACHE_LIMIT_MB = int(os.environ.get("TRANSCRIBER_CACHE_LIMIT_MB", "512"))


def _mx_fn(name: str):
    """MLX moved these from `mx.metal.*` to top level; support both."""
    return getattr(mx, name, None) or getattr(getattr(mx, "metal", None), name, None)


def _clear_mlx_cache() -> None:
    """Return cached buffers to the OS. Cheap; the next allocation re-warms."""
    fn = _mx_fn("clear_cache")
    if fn:
        fn()


def _cap_mlx_cache() -> None:
    """Hard ceiling, belt to `clear_cache`'s braces.

    Worth having independently: it bounds the growth even on a path that forgets
    to clear, which is exactly how this bug happened upstream — the local-LLM
    path clears after every generation, the STT path never does.
    """
    fn = _mx_fn("set_cache_limit")
    if fn:
        fn(CACHE_LIMIT_MB * 1024 * 1024)
        print(f"mlx cache limit {CACHE_LIMIT_MB} MB", flush=True)

# .wav = captured audio needing STT. .txt = already-known text (the bot's own
# replies, handed over verbatim by speech-to-speech). Both carry the same
# epoch-ms prefix, so a filename sort interleaves them chronologically.
SEGMENT = re.compile(r"^(\d+)-(.+)-(\d+)\.(wav|txt)$")

_model = None


def model():
    """Load Parakeet lazily — importing MLX costs seconds we should not pay
    until there is actually something to transcribe.

    Same loader speech-to-speech uses on Apple Silicon (`mlx_audio.stt.generate`,
    see STT/parakeet_tdt_handler.py `_setup_mlx`), so the model is already in the
    HF cache and the transcript matches what the live pipeline hears.
    """
    global _model
    if _model is None:
        from mlx_audio.stt.generate import load_model

        name = os.environ.get("STT_MODEL", "mlx-community/parakeet-tdt-0.6b-v3")
        print(f"loading {name} …", flush=True)
        _model = load_model(name)
    return _model


def transcribe(path: Path) -> str:
    """48 kHz stereo on disk -> 16 kHz mono for STT.

    Mix to mono first, then resample with soxr. Striding would both scramble the
    interleaved channels and alias.
    """
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    mono = data.mean(axis=1)
    if rate != STT_RATE:
        mono = soxr.resample(mono, rate, STT_RATE, quality="HQ")
    if float(np.abs(mono).max() or 0) < 0.005:
        return ""  # silence or a click that slipped the length filter
    try:
        result = model().generate(mx.array(mono))
        return (getattr(result, "text", "") or "").strip()
    finally:
        # In `finally` on purpose: a segment that raises still allocated, and the
        # error path is exactly where a leak would go unnoticed.
        _clear_mlx_cache()


def process(session_dir: Path) -> int:
    segments = session_dir / "segments"
    if not segments.is_dir():
        return 0
    done = 0
    # Sort by filename: the epoch prefix makes that chronological across speakers.
    for wav in sorted([*segments.glob("*.wav"), *segments.glob("*.txt")], key=lambda p: p.name):
        m = SEGMENT.match(wav.name)
        if not m:
            continue
        # Skip files still being written — a stable size across one poll is a
        # good-enough proxy for "closed", and avoids transcribing half an utterance.
        size = wav.stat().st_size
        time.sleep(0.05)
        if wav.stat().st_size != size:
            continue

        epoch_ms, speaker, _, kind = m.groups()
        if kind == "txt":
            text = wav.read_text().strip()   # verbatim, no recognition step
        else:
            try:
                text = transcribe(wav)
            except Exception as e:  # a bad segment must not kill the watcher
                print(f"  !! {wav.name}: {e}", flush=True)
                text = ""

        if text:
            # UTC, matching the folder date. Mixing the two puts local times
            # inside a UTC-dated folder, which reads as an hours-long gap.
            ts = datetime.fromtimestamp(int(epoch_ms) / 1000, timezone.utc)
            line = f"- `{ts:%H:%M:%S}Z` **{speaker}**: {text}\n"
            (session_dir / "transcript.md").open("a").write(line)
            print(f"  {ts:%H:%M:%S}Z {speaker}: {text[:70]}", flush=True)

        if kind == "txt":
            wav.unlink(missing_ok=True)
        elif KEEP_AUDIO:
            archive = session_dir / "audio"
            archive.mkdir(exist_ok=True)
            wav.rename(archive / wav.name)
        else:
            wav.unlink(missing_ok=True)
        done += 1
    return done


def _memory_line() -> str:
    """What MLX is holding, in the log, per batch of work.

    Nothing in this stack reported its own memory, so unbounded growth was only
    discovered when the machine ran out. `active` is live tensors, `cache` is the
    reusable pool — it is the second number that used to climb forever.
    """
    parts = []
    for label, name in (("active", "get_active_memory"), ("cache", "get_cache_memory")):
        fn = _mx_fn(name)
        if fn:
            parts.append(f"{label} {fn() / 1024 / 1024:.0f} MB")
    return "  [mlx " + ", ".join(parts) + "]" if parts else ""


def main() -> int:
    ROOT.mkdir(parents=True, exist_ok=True)
    _cap_mlx_cache()
    print(f"transcriber watching {ROOT}", flush=True)
    while True:
        try:
            total = sum(process(d) for d in sorted(ROOT.iterdir()) if d.is_dir())
            if total:
                print(f"  ({total} segment(s)){_memory_line()}", flush=True)
        except KeyboardInterrupt:
            return 0
        except Exception as e:
            print(f"!! watcher error: {e}", flush=True)
        time.sleep(POLL_SECONDS)


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(0)
