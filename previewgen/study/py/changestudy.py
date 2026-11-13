"""How many human shot lines stand at a picture change (cut or new framing)?

Usage: python -I changestudy.py <feat dir> <gt_all.json> [ids...]
"""
import json
import math
import sys

import numpy as np

feat_dir, gt_path = sys.argv[1], sys.argv[2]
ids = sys.argv[3:] or ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"]
gt = json.load(open(gt_path, encoding="utf-8"))


def peaks(sig, fps, th, half_s=1.0, min_gap=2.0):
    half = int(half_s * fps)
    out = []
    for i in np.where(sig >= th)[0]:
        lo, hi = max(0, i - half), min(len(sig), i + half + 1)
        if sig[i] < sig[lo:hi].max():
            continue
        t = i / fps
        if not out or t - out[-1] >= min_gap:
            out.append(t)
    return np.array(out)


configs = [("bh", th) for th in (0.5, 0.4, 0.3, 0.25, 0.2, 0.15)] + [("bg", th) for th in (0.12, 0.09, 0.07, 0.05)] + [("mix", th) for th in (0.4, 0.3, 0.25, 0.2)]
tot = {c: dict(n=0, hit=0, cuts=0, cut_any=0, cut_shot=0, chance=0.0) for c in configs}
for vid in ids:
    f = np.load(f"{feat_dir}/{vid}.npz")
    fps = int(f["fps"])
    bh, bg = f["bh"], f["bg"]
    dur = len(bh) / fps
    rows = gt[[k for k in gt if f"gt_{vid}" in k][0]]
    shots = np.array([r["sec"] for r in rows if r["type"] == "shot" and r.get("sec") is not None and r["sec"] <= dur + 5 and "영상종료" not in r.get("text", "")])
    timed = np.array([r["sec"] for r in rows if r.get("sec") is not None and r["sec"] <= dur + 5])
    for c in configs:
        name, th = c
        sig = bh if name == "bh" else bg if name == "bg" else np.maximum(bh, bg * 3.0)
        cp = peaks(sig, fps, th)
        a = tot[c]
        a["n"] += len(shots)
        a["hit"] += sum(bool(np.any((cp >= s - 12) & (cp <= s + 2))) for s in shots)
        a["cuts"] += len(cp)
        a["cut_any"] += sum(bool(np.any((timed >= x - 2) & (timed <= x + 12))) for x in cp)
        a["cut_shot"] += sum(bool(np.any((shots >= x - 2) & (shots <= x + 12))) for x in cp)
        a["chance"] += len(shots) * (1 - math.exp(-len(cp) * 14 / dur))
print(f"{tot[configs[0]]['n']} human shot lines in {len(ids)} episodes")
for c in configs:
    a = tot[c]
    print(f"{c[0]} >= {c[1]}: {a['cuts']} changes ({a['cuts'] / a['n']:.1f} for each human shot line) | human shot lines with a change before them {a['hit'] / a['n']:.0%} (by chance {a['chance'] / a['n']:.0%}) | changes followed by a human shot line {a['cut_shot'] / a['cuts']:.0%}, by any human TC {a['cut_any'] / a['cuts']:.0%}")
