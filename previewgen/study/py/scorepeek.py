"""Print the highest scene scores near given times. Usage: python -I scorepeek.py <scores.txt> <t1> [<t2> ...]"""
import sys

times, vals = [], []
cur = None
with open(sys.argv[1], encoding="utf-8") as f:
    for line in f:
        if line.startswith("frame:"):
            cur = float(line.rsplit("pts_time:", 1)[1])
        elif line.startswith("lavfi.scene_score=") and cur is not None:
            times.append(cur)
            vals.append(float(line.split("=", 1)[1]))
for a in sys.argv[2:]:
    t = float(a)
    near = sorted(((v, x) for x, v in zip(times, vals) if abs(x - t) <= 3), reverse=True)[:4]
    base = sorted(v for x, v in zip(times, vals) if abs(x - t) <= 10)
    print(f"{int(t) // 60}:{int(t) % 60:02d}: top " + ", ".join(f"{v:.3f}@{x:.2f}" for v, x in near) + f" | median in +-10 s {base[len(base) // 2]:.4f}")
