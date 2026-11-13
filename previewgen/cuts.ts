// Cuts and quiet moments of the video, found with ffmpeg alone (no model).
//
// The footage is raw camera files joined end to end, so a cut is the start of
// a new camera file. The preview has a shot line at nearly every cut: on 1023,
// 9 of 10 cuts are followed by a shot line of the human writer within 12 s.
import { execFile } from "child_process";
import fs from "fs";
import { promisify } from "util";
import { SAMPLE_RATE } from "../src/audio";

const execFileAsync = promisify(execFile);

/** Times (seconds) at which the picture jumps. About 12 s of work for a 100-minute proxy. */
export async function detectCuts(media: string, cachePath: string, threshold = 0.1): Promise<number[]> {
  if (fs.existsSync(cachePath)) return JSON.parse(fs.readFileSync(cachePath, "utf-8")).cuts;
  const scores = `${cachePath}.scores.txt`;
  await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", media, "-an", "-vf", `scale=240:-2,select='gte(scene,${threshold})',metadata=print:file=${scores}`, "-f", "null", "-"],
    { maxBuffer: 1 << 20 },
  );
  const cuts: number[] = [];
  for (const line of fs.readFileSync(scores, "utf-8").split("\n")) {
    const m = line.match(/pts_time:([\d.]+)/);
    if (!m) continue;
    const t = parseFloat(m[1]);
    // A flash or a fast move can give two high frames in a row: keep one for each second.
    if (!cuts.length || t - cuts[cuts.length - 1] >= 1) cuts.push(Math.round(t * 100) / 100);
  }
  fs.rmSync(scores, { force: true });
  fs.writeFileSync(cachePath, JSON.stringify({ media, threshold, cuts }));
  return cuts;
}

/** Loudness (dB, RMS) of each `step` seconds of the decoded soundtrack. */
export function loudness(pcmPath: string, step = 0.5): Float32Array {
  const buf = fs.readFileSync(pcmPath);
  const samples = new Int16Array(buf.buffer, buf.byteOffset, Math.floor(buf.byteLength / 2));
  const n = Math.floor(SAMPLE_RATE * step);
  const out = new Float32Array(Math.floor(samples.length / n));
  for (let k = 0; k < out.length; k++) {
    let sum = 0;
    for (let i = k * n; i < (k + 1) * n; i++) sum += samples[i] * samples[i];
    out[k] = 10 * Math.log10(sum / n / (32768 * 32768) + 1e-12);
  }
  return out;
}

export interface PlannedWindow {
  start: number;
  end: number;
  /** True when the window starts at a cut (a new camera file), false when it starts inside a take. */
  startsAtCut: boolean;
  /** Cuts inside the window, in seconds from the start of the video. */
  cuts: number[];
}

/**
 * Windows of about `target` seconds that cover the video. A window ends at a
 * cut when there is one near the target length. Inside a long take it ends at
 * the quietest moment near the target, so that no sentence is cut in two.
 */
export function planWindows(duration: number, cuts: number[], loud: Float32Array, loudStep: number, target = 300, from = 0, to = duration): PlannedWindow[] {
  const out: PlannedWindow[] = [];
  let start = from;
  let atCut = from === 0 || cuts.some((c) => Math.abs(c - from) < 0.5);
  while (start < to - 1) {
    let end = Math.min(to, start + target);
    let endAtCut = false;
    if (end < to) {
      const near = cuts.filter((c) => c >= start + target * 0.6 && c <= start + target * 1.15);
      if (near.length) {
        // The cut nearest to the target length.
        end = near.reduce((a, b) => (Math.abs(b - (start + target)) < Math.abs(a - (start + target)) ? b : a));
        endAtCut = true;
      } else {
        let best = end;
        let bestDb = Infinity;
        for (let t = start + target - 20; t <= start + target + 20; t += loudStep) {
          const k = Math.floor(t / loudStep);
          if (k < 1 || k + 1 >= loud.length) continue;
          const db = Math.max(loud[k - 1], loud[k], loud[k + 1]);
          if (db < bestDb) {
            bestDb = db;
            best = t;
          }
        }
        end = Math.round(best * 10) / 10;
      }
      // A short rest at the end of the video joins the last window.
      if (to - end < target * 0.25) {
        end = to;
        endAtCut = false;
      }
    }
    out.push({ start, end, startsAtCut: atCut, cuts: cuts.filter((c) => c > start + 1.5 && c < end - 1) });
    start = end;
    atCut = endAtCut;
  }
  return out;
}
