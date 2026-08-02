#!/usr/bin/env python3
"""Convert Discord's 48 kHz stereo capture to the 16 kHz mono speech-to-speech wants.

Run inside the speech-to-speech venv (soxr + soundfile already live there):

    cd ~/Documents/workspaces/speech-to-speech
    uv run --python 3.13 python ~/Documents/workspaces/discord-voice-spike/to16k.py <in.wav>

Why not `pcm[::3]`: Discord PCM is stereo *interleaved*, so striding by 3 walks
alternating channels rather than downsampling; and decimating without a low-pass
filter aliases everything above 8 kHz back into the band. Mix to mono first,
then let soxr do a filtered resample.
"""

from __future__ import annotations

import sys
from pathlib import Path

import numpy as np
import soundfile as sf
import soxr

TARGET_RATE = 16000  # speech-to-speech PIPELINE_SAMPLE_RATE


def main(src: str) -> int:
    data, rate = sf.read(src, dtype="float32", always_2d=True)
    print(f"in : {src}\n     {rate} Hz, {data.shape[1]} ch, {len(data)/rate:.1f}s")

    mono = data.mean(axis=1) if data.shape[1] > 1 else data[:, 0]
    out = soxr.resample(mono, rate, TARGET_RATE, quality="HQ") if rate != TARGET_RATE else mono

    dst = str(Path(src).with_suffix("")) + f"-{TARGET_RATE//1000}k-mono.wav"
    sf.write(dst, out, TARGET_RATE, subtype="PCM_16")

    peak = float(np.abs(out).max()) if len(out) else 0.0
    print(f"out: {dst}\n     {TARGET_RATE} Hz, 1 ch, {len(out)/TARGET_RATE:.1f}s, peak {peak:.3f}")
    if peak < 0.01:
        print("!!   near-silent — capture probably failed (check selfDeaf:false)")
        return 1
    return 0


if __name__ == "__main__":
    if len(sys.argv) != 2:
        print(__doc__)
        sys.exit(2)
    sys.exit(main(sys.argv[1]))
