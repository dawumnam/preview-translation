"""Speech activity of a video: the stretches in which someone speaks, from a voice-activity detector (no AI model call).

The two audio channels carry different microphones, so each channel is tested on its own
and a frame counts as speech when one of them has speech.

Usage: python -I vad.py <video> <out.json> [mode 0-3, default 2]
"""
import json
import subprocess
import sys

import numpy as np
import webrtcvad

video, out = sys.argv[1], sys.argv[2]
mode = int(sys.argv[3]) if len(sys.argv) > 3 else 2
SR, FRAME_MS = 16000, 30
N = SR * FRAME_MS // 1000

raw = subprocess.run(["ffmpeg", "-v", "error", "-i", video, "-vn", "-ac", "2", "-ar", str(SR), "-f", "s16le", "-"], stdout=subprocess.PIPE, check=True).stdout
pcm = np.frombuffer(raw, dtype=np.int16).reshape(-1, 2)
frames = len(pcm) // N
vad = webrtcvad.Vad(mode)
speech = np.zeros(frames, dtype=bool)
for ch in range(2):
    data = np.ascontiguousarray(pcm[: frames * N, ch]).tobytes()
    for i in range(frames):
        if vad.is_speech(data[i * N * 2:(i + 1) * N * 2], SR):
            speech[i] = True

# Smooth: a break under 0.45 s inside speech is speech; a burst under 0.25 s is not speech.
def runs(x):
    d = np.diff(np.concatenate([[0], x.astype(np.int8), [0]]))
    return list(zip(np.where(d == 1)[0], np.where(d == -1)[0]))

fill = int(0.45 / (FRAME_MS / 1000))
for a, b in runs(~speech):
    if 0 < a and b < frames and b - a <= fill:
        speech[a:b] = True
short = int(0.25 / (FRAME_MS / 1000))
for a, b in runs(speech):
    if b - a < short:
        speech[a:b] = False
segs = [[round(a * FRAME_MS / 1000, 2), round(b * FRAME_MS / 1000, 2)] for a, b in runs(speech)]
json.dump({"duration": round(frames * FRAME_MS / 1000, 2), "mode": mode, "segments": segs}, open(out, "w"))
print(out, f"{len(segs)} speech stretches, speech {speech.mean():.0%} of {frames * FRAME_MS / 1000 / 60:.0f} min")
