"""Build a labeled contact sheet. Usage: python -I sheet.py <video> <out.png> <start_s> <end_s> <step_s> [cols] [width]"""
import subprocess, sys, tempfile, os, glob
from PIL import Image, ImageDraw

def tc(sec):
    sec = int(sec)
    h, m, s = sec // 3600, (sec % 3600) // 60, sec % 60
    return f"{h}{m:02d}{s:02d}" if h else f"{m:02d}{s:02d}"

def main():
    video, out = sys.argv[1], sys.argv[2]
    start, end, step = float(sys.argv[3]), float(sys.argv[4]), float(sys.argv[5])
    cols = int(sys.argv[6]) if len(sys.argv) > 6 else 6
    width = int(sys.argv[7]) if len(sys.argv) > 7 else 240
    with tempfile.TemporaryDirectory() as td:
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-ss", str(start), "-t", str(end - start), "-i", video,
                        "-vf", f"fps=1/{step},crop=iw:ih*0.85:0:ih*0.075,scale={width}:-2", os.path.join(td, "f_%04d.jpg")], check=True)
        files = sorted(glob.glob(os.path.join(td, "f_*.jpg")))
        ims = [Image.open(f).convert("RGB") for f in files]
    w, h = ims[0].size
    rows = (len(ims) + cols - 1) // cols
    sheet = Image.new("RGB", (cols * w, rows * h), "black")
    d = ImageDraw.Draw(sheet)
    for i, im in enumerate(ims):
        x, y = (i % cols) * w, (i // cols) * h
        sheet.paste(im, (x, y))
        label = tc(start + i * step)
        d.rectangle([x, y, x + 8 * len(label) + 6, y + 14], fill="black")
        d.text((x + 3, y + 1), label, fill="yellow")
    sheet.save(out)
    print(out, len(ims), "frames", sheet.size)

main()
