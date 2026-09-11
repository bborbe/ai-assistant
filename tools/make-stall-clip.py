#!/usr/bin/env python3
"""Render the stall filler to PCM in the SAME voice the bot speaks in.

The bot plays this clip into the voice channel during a stall (see
`speakStallClip` in src/voice.js), so it has to sound like the assistant — a
filler in a different voice is worse than the silence it replaces. The voice is
therefore not chosen here; it is copied from what the local stack actually runs.

scripts/s2s-minimax launches speech-to-speech with `--tts qwen3 --device mps`
and no voice flags at all, so every voice setting resolves to
Qwen3TTSHandlerArguments' defaults: a CustomVoice model with speaker "Aiden",
`ref_audio` unset. The `ref_audio` override in speech-to-speech's own
scripts/benchmark_tts.py is NOT the live config — using it here would clone a
different voice and the filler would not match the answers around it.

Output is 16 kHz mono s16le PCM: what speech-to-speech emits, and what
src/voice.js's `up()` already knows how to convert to Discord's 48 kHz stereo.

Run it inside the speech-to-speech venv (the model lives there):

    cd ~/Documents/workspaces/speech-to-speech
    uv run --python 3.13 python \\
      ~/Documents/workspaces/ai-assistant/tools/make-stall-clip.py \\
      ~/Documents/workspaces/ai-assistant/src/stall-clip.pcm

The first run loads the MLX model (~60s); later runs are fast. Re-run it only
when the line or the live voice config changes — the committed .pcm is the
artifact, and nothing at bot runtime regenerates it.
"""

from __future__ import annotations

import sys
from pathlib import Path
from queue import Queue
from threading import Event

import numpy as np

from speech_to_speech.pipeline.messages import TTSInput
from speech_to_speech.TTS.qwen3_tts_handler import Qwen3TTSHandler

# One sentence, unlike the shim's two-sentence _PROGRESS_LINES. Those are two
# because speech-to-speech releases a sentence to TTS only once the NEXT one has
# started (base_openai_compatible_language_model.py:404), so a lone line is held
# as incomplete text until the answer begins. This clip never goes through TTS
# at play time — it is pre-rendered audio written straight to the pump — so that
# constraint does not apply, and a shorter clip means a shorter bounded delay if
# the answer arrives while it is still playing.
LINE = "One moment — still getting the audio ready."

# speech-to-speech's PIPELINE_SAMPLE_RATE, and the rate `up()` expects.
SAMPLE_RATE = 16000

# Qwen3TTSHandlerArguments' defaults, which is what the launcher's bare
# `--tts qwen3` resolves to. `ref_audio` is deliberately absent.
SETUP_KWARGS = {
    "device": "mps",
    "model_name": "Qwen/Qwen3-TTS-12Hz-1.7B-CustomVoice",
    "speaker": "Aiden",
    "mlx_quantization": "6bit",
    "language": "auto",
}


def main() -> int:
    out_path = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("src/stall-clip.pcm")

    # Left unset, exactly as speech-to-speech's own benchmark does: the handler
    # only stores this event, so setting it would be a guess about semantics
    # rather than a copy of the tested path.
    handler = Qwen3TTSHandler(
        Event(),
        queue_in=Queue(),
        queue_out=Queue(),
        setup_args=(Event(),),
        setup_kwargs=SETUP_KWARGS,
    )

    chunks = [
        chunk
        for chunk in handler.process(TTSInput(text=LINE, language_code="en"))
        if chunk is not None
    ]
    if not chunks:
        print("handler yielded no audio — nothing written", file=sys.stderr)
        return 1

    audio = np.concatenate([np.asarray(c).reshape(-1) for c in chunks])
    pcm = (np.clip(audio, -1.0, 1.0) * 32767.0).astype("<i2").tobytes()

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_bytes(pcm)
    print(f"wrote {out_path} — {len(pcm)} bytes, {len(audio) / SAMPLE_RATE:.2f}s @ {SAMPLE_RATE} Hz")
    print(f"line: {LINE!r}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
