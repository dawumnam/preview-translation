"""One figure that explains the camera-file layout on a real stretch of episode 1022 (16:00 to 17:20).

Usage: python -I cutfigure.py <video.mp4> <scene scores .txt> <out.png>
"""
import os
import subprocess
import sys
import tempfile

from PIL import Image, ImageDraw, ImageFont

video, scores_path, out = sys.argv[1], sys.argv[2], sys.argv[3]
T0, T1 = 960.0, 1040.0  # 16:00 to 17:20
PX = 25  # pixels for each second
ML, MR = 40, 40
W = ML + int((T1 - T0) * PX) + MR
H = 760
STEP = 5  # seconds between two frames of the strip

FONTS = ["/System/Library/Fonts/AppleSDGothicNeo.ttc", "/System/Library/Fonts/Supplemental/AppleGothic.ttf", "/Library/Fonts/Arial Unicode.ttf"]


def font(size):
    for f in FONTS:
        if os.path.exists(f):
            return ImageFont.truetype(f, size)
    return ImageFont.load_default()


def x_of(t):
    return ML + (t - T0) * PX


def clock(t):
    t = int(t)
    return f"{t // 60}:{t % 60:02d}"


# --- the scene score of each frame in the window, and the cuts as the pipeline finds them (score >= 0.1, one for each second)
times, vals = [], []
cur = None
with open(scores_path, encoding="utf-8") as f:
    for line in f:
        if line.startswith("frame:"):
            cur = float(line.rsplit("pts_time:", 1)[1])
        elif line.startswith("lavfi.scene_score=") and cur is not None:
            times.append(cur)
            vals.append(float(line.split("=", 1)[1]))
cuts_all = []
for t, v in zip(times, vals):
    if v >= 0.1 and (not cuts_all or t - cuts_all[-1] >= 1):
        cuts_all.append(t)
cuts_all = [round(c, 2) for c in cuts_all]
cuts = [c for c in cuts_all if T0 <= c <= T1]
prev_cut = max(c for c in cuts_all if c < T0)
next_cut = min(c for c in cuts_all if c > T1)
print("cuts in the window:", [round(c, 2) for c in cuts], "| cut before:", round(prev_cut, 2), "| cut after:", round(next_cut, 2))

img = Image.new("RGB", (W, H), "white")
d = ImageDraw.Draw(img)
INK, GREY, RED, BLUE = (25, 25, 30), (120, 120, 128), (200, 40, 40), (40, 90, 200)

d.text((ML, 16), "Episode 1022, 16:00 to 17:20: the video, the human preview, and the suggested layout", font=font(28), fill=INK)

# --- 1. frames
y = 70
d.text((ML, y), "1. The video: one frame every 5 seconds. The picture jumps where a new camera recording starts.", font=font(18), fill=INK)
fy = y + 34
fw, fh = STEP * PX, int(STEP * PX * 9 / 16)
with tempfile.TemporaryDirectory() as td:
    t = T0
    while t < T1:
        p = os.path.join(td, f"{int(t)}.png")
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(t), "-i", video, "-frames:v", "1", "-vf", f"crop=iw:iw*9/16,scale={fw - 4}:{fh}", p], check=True)
        img.paste(Image.open(p).convert("RGB"), (int(x_of(t)) + 2, fy))
        d.text((int(x_of(t)) + 4, fy + fh + 3), clock(t), font=font(14), fill=GREY)
        t += STEP

# --- 2. score graph
gy0 = fy + fh + 44
d.text((ML, gy0), "2. What the code measures: how much each frame differs from the frame before it. A jump above the limit is a new recording.", font=font(18), fill=INK)
gt, gb = gy0 + 34, gy0 + 34 + 130
d.rectangle([ML, gt, W - MR, gb], outline=(210, 210, 215))
YMAX = 0.5
yv = lambda v: gb - min(YMAX, v) / YMAX * (gb - gt)
lim = yv(0.1)
for xx in range(ML, W - MR, 12):
    d.line([xx, lim, xx + 6, lim], fill=GREY)
d.text((W - MR - 70, lim - 20), "limit 0.1", font=font(14), fill=GREY)
d.text((ML + 4, gt + 2), "0.5 or more", font=font(13), fill=GREY)
pts = [(x_of(t), yv(v)) for t, v in zip(times, vals) if T0 <= t <= T1]
d.line(pts, fill=BLUE, width=2)

# --- 3. blocks
by0 = gb + 30
d.text((ML, by0), "3. The camera recordings that the code finds: one block for each. The blocks cover the video with no gap.", font=font(18), fill=INK)
bt, bb = by0 + 34, by0 + 34 + 44
edges = [T0] + cuts + [T1]
fills = [(232, 232, 236), (214, 230, 250), (250, 232, 205), (214, 240, 220), (245, 222, 235)]
bounds = [prev_cut] + cuts + [next_cut]
for i in range(len(edges) - 1):
    a, b = edges[i], edges[i + 1]
    d.rectangle([x_of(a), bt, x_of(b), bb], fill=fills[i % len(fills)], outline=(150, 150, 160))
    length = bounds[i + 1] - bounds[i]
    label = f"{int(round(length)) // 60}:{int(round(length)) % 60:02d}"
    if i == 0:
        label = f"(started at {clock(prev_cut)})"
    elif i == len(edges) - 2:
        label = f"{label}  (goes on to {clock(next_cut)})  →"
    d.text((x_of(a) + 8, bt + 11), label, font=font(17), fill=INK)

# --- 4. human lines
hy0 = bb + 30
d.text((ML, hy0), "4. Human preview: the lines with a timecode in this stretch. The recordings at 16:22 and 16:36 have no line.", font=font(18), fill=INK)
ht = hy0 + 36
human = [(967, "1607  활활 타는 장작"), (1020, "1700  집으로 들어가는 큐 후면")]
d.line([ML, ht + 30, W - MR, ht + 30], fill=(210, 210, 215))
for t, text in human:
    d.line([x_of(t), ht + 22, x_of(t), ht + 38], fill=INK, width=3)
    d.text((x_of(t) + 8, ht), text, font=font(18), fill=INK)
for a, b in [(cuts[1], cuts[2]), (cuts[2], cuts[3])]:
    d.text(((x_of(a) + x_of(b)) / 2 - 34, ht + 2), "(no line)", font=font(16), fill=RED)

# --- 5. suggested lines
sy0 = ht + 62
d.text((ML, sy0), "5. Suggested layout: one ■ line for each recording, at its exact start, with its length. Notes and speech go below it.", font=font(18), fill=INK)
st = sy0 + 36
suggested = ["1605  ■ 화덕 sk (0:17)", "1622  ■ 식당 앞에 서있는 큐 후면 (0:14)", "1636  ■ 식당 앞에 서있는 큐 후면 (0:13)", "1648  ■ 식당으로 들어가는 큐 후면 (1:30)"]
for i, (c, text) in enumerate(zip(cuts, suggested)):
    yy = st + (i % 2) * 34
    d.line([x_of(c), st - 6, x_of(c), yy + 22], fill=RED, width=2)
    d.text((x_of(c) + 8, yy), text, font=font(18), fill=INK)

# --- the cuts as red lines through rows 1 to 3, with their times
for c in cuts:
    for top, bottom in [(fy - 6, fy + fh + 2), (gt, gb), (bt - 5, bb + 5)]:
        d.line([x_of(c), top, x_of(c), bottom], fill=RED, width=2)
    d.text((x_of(c) + 6, gt + 20), f"jump at {clock(c)}", font=font(15), fill=RED)

img.save(out)
print(out, img.size)
