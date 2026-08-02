#!/usr/bin/env python3
"""Minimal OpenAI-Realtime client that probes a speech-to-speech server.

Sends a WAV of speech, collects the audio reply, and reports every event type
the server emitted. Deliberately dependency-light (websockets + stdlib) so it
stays usable as the reference for the Discord voice bot's protocol handling.

    python scripts/realtime_probe.py /tmp/s2s-test.wav

Expects 16 kHz mono int16 input — the pipeline rate
(api/openai_realtime/service.py: PIPELINE_SAMPLE_RATE = 16000), NOT the 24 kHz
that OpenAI's hosted Realtime uses.
"""

from __future__ import annotations

import asyncio
import base64
import json
import sys
import time
import wave
from collections import Counter

import websockets

URL = "ws://127.0.0.1:8765/v1/realtime"
CHUNK_MS = 20
RATE = 16000
IDLE_TIMEOUT = 30.0  # give up if the server goes quiet this long
TAIL_SILENCE_MS = 1500  # VAD needs silence to close the turn


def read_wav(path: str) -> bytes:
    with wave.open(path, "rb") as w:
        assert w.getsampwidth() == 2, f"want int16, got {w.getsampwidth()*8}-bit"
        assert w.getnchannels() == 1, f"want mono, got {w.getnchannels()} channels"
        if w.getframerate() != RATE:
            print(f"!! input is {w.getframerate()} Hz, server expects {RATE}")
        return w.readframes(w.getnframes())


async def main(wav_path: str) -> int:
    pcm = read_wav(wav_path)
    frame = int(RATE * 2 * CHUNK_MS / 1000)  # bytes per chunk (int16 = 2 bytes)
    seen: Counter[str] = Counter()
    audio_out = bytearray()
    transcripts: list[str] = []

    print(f"connecting {URL}")
    async with websockets.connect(URL, max_size=None) as ws:
        print(f"connected, streaming {len(pcm)/2/RATE:.1f}s of audio")
        sent_at = time.monotonic()

        for i in range(0, len(pcm), frame):
            await ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(pcm[i:i + frame]).decode(),
            }))
            await asyncio.sleep(CHUNK_MS / 1000)  # pace like a real mic

        # Trailing silence is NOT optional: server-side VAD closes the turn on
        # silence, and a real mic never stops sending. Without it the final turn
        # never ends. Do not send commit/response.create either — that races the
        # VAD-driven response and shows up as "speech during pending response".
        silence = b"\x00" * frame
        for _ in range(int(TAIL_SILENCE_MS / CHUNK_MS)):
            await ws.send(json.dumps({
                "type": "input_audio_buffer.append",
                "audio": base64.b64encode(silence).decode(),
            }))
            await asyncio.sleep(CHUNK_MS / 1000)
        print(f"audio + {TAIL_SILENCE_MS}ms silence sent, waiting for reply…")

        first_audio: float | None = None
        while True:
            try:
                raw = await asyncio.wait_for(ws.recv(), timeout=IDLE_TIMEOUT)
            except asyncio.TimeoutError:
                print(f"\n!! idle {IDLE_TIMEOUT}s — stopping")
                break

            evt = json.loads(raw)
            etype = evt.get("type", "?")
            seen[etype] += 1

            if etype.endswith("audio.delta") and evt.get("delta"):
                if first_audio is None:
                    first_audio = time.monotonic() - sent_at
                    print(f"   first audio after {first_audio:.2f}s")
                audio_out += base64.b64decode(evt["delta"])
            elif "transcript" in etype and evt.get("transcript"):
                transcripts.append(evt["transcript"])
                print(f"   transcript: {evt['transcript']!r}")
            elif etype in ("response.done", "response.completed"):
                print("   response done")
                break
            elif etype == "error":
                print(f"   ERROR: {evt}")

    out = "/tmp/s2s-reply.wav"
    if audio_out:
        with wave.open(out, "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(RATE)
            w.writeframes(bytes(audio_out))

    print("\n--- events seen ---")
    for name, n in seen.most_common():
        print(f"  {n:4d}  {name}")
    print("\n--- verdict ---")
    print(f"  speech_started emitted : {'YES' if any('speech_started' in e for e in seen) else 'NO'}")
    print(f"  audio returned         : {len(audio_out)} bytes"
          + (f" -> {out} ({len(audio_out)/2/RATE:.1f}s)" if audio_out else " (NONE)"))
    print(f"  transcripts            : {transcripts or 'none'}")
    return 0 if audio_out else 1


if __name__ == "__main__":
    sys.exit(asyncio.run(main(sys.argv[1] if len(sys.argv) > 1 else "/tmp/s2s-test.wav")))
