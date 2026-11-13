"""Frame features for cut and change detection at 10 fps.

Saves, for each frame:
  dh   colour-histogram distance to the frame before (0..1): a spike is a hard cut
  bh   distance between the mean histogram of the 1.5 s before and of the 1.5 s after (0..1),
       with 0.5 s left out on each side: high when the picture after is another picture than before
  bg   the same for a 8x6 grid of mean colours
  luma mean brightness

Usage: python -I histcuts.py <video> <out.npz>
"""
import subprocess
import sys

import numpy as np

W, H, FPS = 64, 36, 10


def box_mean(x, n):
    """Mean of the n rows ending at each row (inclusive)."""
    c = np.cumsum(np.vstack([np.zeros((1, x.shape[1]), dtype=np.float64), x.astype(np.float64)]), axis=0)
    out = np.empty_like(x, dtype=np.float32)
    idx = np.arange(len(x))
    lo = np.maximum(0, idx - n + 1)
    out[:] = ((c[idx + 1] - c[lo]) / (idx - lo + 1)[:, None]).astype(np.float32)
    return out


def main():
    video, out = sys.argv[1], sys.argv[2]
    cmd = ["ffmpeg", "-v", "error", "-i", video, "-an", "-vf", f"fps={FPS},crop=iw:iw*9/16,scale={W}:{H}", "-pix_fmt", "rgb24", "-f", "rawvideo", "-"]
    p = subprocess.Popen(cmd, stdout=subprocess.PIPE, bufsize=1 << 24)
    size = W * H * 3
    hists, grids, lumas = [], [], []
    while True:
        buf = p.stdout.read(size * 600)
        if not buf:
            break
        n = len(buf) // size
        fr = np.frombuffer(buf[: n * size], dtype=np.uint8).reshape(n, H, W, 3)
        q = (fr >> 5).astype(np.int32)  # 3 bits for each channel: 512 colours
        idx = (q[..., 0] << 6) | (q[..., 1] << 3) | q[..., 2]
        h = np.zeros((n, 512), dtype=np.float32)
        for i in range(n):
            h[i] = np.bincount(idx[i].ravel(), minlength=512)
        hists.append(h / (W * H))
        g = fr.reshape(n, 6, H // 6, 8, W // 8, 3).mean(axis=(2, 4)).reshape(n, -1).astype(np.float32) / 255.0
        grids.append(g)
        lumas.append(fr.mean(axis=(1, 2, 3)).astype(np.float32) / 255.0)
    hist = np.concatenate(hists)
    grid = np.concatenate(grids)
    luma = np.concatenate(lumas)
    n = len(hist)
    dh = np.zeros(n, dtype=np.float32)
    dh[1:] = np.abs(hist[1:] - hist[:-1]).sum(axis=1) / 2.0

    win, gap = int(1.5 * FPS), int(0.5 * FPS)

    def before_after(x):
        m = box_mean(x, win)  # m[i] = mean of x[i-win+1 .. i]
        d = np.zeros(n, dtype=np.float32)
        # before: frames [t-gap-win+1 .. t-gap], after: frames [t+gap .. t+gap+win-1]
        for t in range(gap + win, n - gap - win):
            d[t] = np.abs(m[t - gap] - m[t + gap + win - 1]).sum()
        return d

    bh = before_after(hist) / 2.0
    bg = before_after(grid) / grid.shape[1]
    np.savez_compressed(out, fps=FPS, dh=dh, bh=bh, bg=bg, luma=luma)
    print(out, n, "frames")


main()
