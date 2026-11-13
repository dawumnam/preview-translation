"""Study cut detection from colour-histogram distance.

Usage: python -I histstudy.py <feat.npz> <gt_all.json> <gt key part> [probe seconds ...]
"""
import json
import sys

import numpy as np

feat = np.load(sys.argv[1])
fps = int(feat["fps"])
dh, dg, dh2 = feat["dh"], feat["dg"], feat["dh2"]
gt = json.load(open(sys.argv[2], encoding="utf-8"))
rows = gt[[k for k in gt if sys.argv[3] in k][0]]
dur = len(dh) / fps
shots = np.array([r["sec"] for r in rows if r["type"] == "shot" and r.get("sec") is not None and r["sec"] <= dur + 5 and "영상종료" not in r.get("text", "")])
timed = np.array([r["sec"] for r in rows if r.get("sec") is not None and r["sec"] <= dur + 5])


def detect(sig, a_min, ratio, half_s=2.0, guard_s=0.3, min_gap=1.0):
    n = len(sig)
    half, guard = int(half_s * fps), int(guard_s * fps)
    out = []
    cand = np.where(sig >= a_min)[0]
    for i in cand:
        lo, hi = max(0, i - half), min(n, i + half + 1)
        # local maximum
        if sig[i] < sig[max(0, i - guard):min(n, i + guard + 1)].max():
            continue
        nb = np.concatenate([sig[lo:max(lo, i - guard)], sig[min(hi, i + guard + 1):hi]])
        base = np.median(nb) if len(nb) else 0.0
        p90 = np.percentile(nb, 90) if len(nb) else 0.0
        if sig[i] >= ratio * max(base, 0.01) and sig[i] >= 1.5 * p90:
            t = i / fps
            if not out or t - out[-1] >= min_gap:
                out.append(t)
    return np.array(out)


def report(name, cuts):
    hit = np.mean([np.any((cuts >= s - 12) & (cuts <= s + 2)) for s in shots])
    cut_any = np.mean([np.any((timed >= c - 2) & (timed <= c + 12)) for c in cuts]) if len(cuts) else 0
    cut_shot = np.mean([np.any((shots >= c - 2) & (shots <= c + 12)) for c in cuts]) if len(cuts) else 0
    print(f"{name}: {len(cuts)} cuts | human shot lines with a cut before them {hit:.0%} | cuts followed by a human shot line {cut_shot:.0%}, by any human TC {cut_any:.0%}")


print(f"{len(shots)} human shot lines, {dur / 60:.0f} min")
for a_min, ratio in [(0.25, 3), (0.2, 3), (0.15, 3), (0.12, 3), (0.1, 3), (0.1, 4), (0.08, 4), (0.06, 4), (0.06, 6), (0.05, 5)]:
    report(f"hist a>={a_min} x{ratio}", detect(dh, a_min, ratio))
for a_min, ratio in [(0.05, 3), (0.04, 3), (0.03, 4)]:
    report(f"grid a>={a_min} x{ratio}", detect(dg, a_min, ratio))

for probe in sys.argv[4:]:
    s = float(probe)
    i0, i1 = int((s - 6) * fps), int((s + 6) * fps)
    seg = dh[i0:i1]
    k = np.argsort(seg)[-4:][::-1]
    print(f"probe {s:.0f}s: top hist distances " + ", ".join(f"{seg[j]:.2f}@{(i0 + j) / fps:.1f}" for j in k) + f" | median {np.median(seg):.3f}")
