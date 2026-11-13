// Usage: bun previewgen/study/cutstudy.ts [ids...]
// How well do cut detectors on the per-frame scene score explain the human shot lines?
import fs from "fs";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

function loadScores(id: string): { t: Float64Array; s: Float32Array } {
  const text = fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8");
  const ts: number[] = [];
  const ss: number[] = [];
  let cur = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=")) {
      ts.push(cur);
      ss.push(parseFloat(line.slice(18)));
    }
  }
  return { t: Float64Array.from(ts), s: Float32Array.from(ss) };
}

/** Absolute threshold. */
function cutsAbs(t: Float64Array, s: Float32Array, th: number): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) if (s[i] >= th && (!out.length || t[i] - out[out.length - 1] >= 1)) out.push(t[i]);
  return out;
}

/** A frame whose score stands out from the frames around it. */
function cutsSpike(t: Float64Array, s: Float32Array, min: number, ratio: number, half = 12): number[] {
  const out: number[] = [];
  const buf: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] < min) continue;
    buf.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(s.length - 1, i + half); k++) if (k !== i) buf.push(s[k]);
    buf.sort((a, b) => a - b);
    // The second highest neighbour: one other high frame (a flash, the frame after the cut) is allowed.
    const ref = buf[buf.length - 2] ?? 0;
    if (s[i] >= ratio * Math.max(ref, 0.002) && (!out.length || t[i] - out[out.length - 1] >= 1)) out.push(t[i]);
  }
  return out;
}

const fmt = (x: number) => `${(100 * x).toFixed(0)}%`;
const total: Record<string, { shotRef: number; shotHit: number; cuts: number; cutHit: number; cutShot: number }> = {};
for (const id of ids) {
  const { t, s } = loadScores(id);
  const dur = t[t.length - 1];
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const shots = gt.filter((l) => l.kind === "shot" && l.tc !== undefined && l.tc <= dur + 5 && l.text !== "영상종료").map((l) => l.tc!);
  const timed = gt.filter((l) => l.tc !== undefined && l.tc <= dur + 5).map((l) => l.tc!);
  const detectors: [string, number[]][] = [
    ["abs 0.10", cutsAbs(t, s, 0.1)],
    ["abs 0.05", cutsAbs(t, s, 0.05)],
    ["abs 0.03", cutsAbs(t, s, 0.03)],
    ["spike 0.03 x3", cutsSpike(t, s, 0.03, 3)],
    ["spike 0.02 x4", cutsSpike(t, s, 0.02, 4)],
    ["spike 0.015 x4", cutsSpike(t, s, 0.015, 4)],
    ["spike 0.012 x5", cutsSpike(t, s, 0.012, 5)],
    ["spike 0.010 x6", cutsSpike(t, s, 0.01, 6)],
  ];
  const row: string[] = [];
  for (const [name, cuts] of detectors) {
    let hit = 0;
    for (const tc of shots) if (cuts.some((c) => c >= tc - 12 && c <= tc + 2)) hit++;
    let cutHit = 0;
    let cutShot = 0;
    for (const c of cuts) {
      if (timed.some((tc) => tc >= c - 2 && tc <= c + 12)) cutHit++;
      if (shots.some((tc) => tc >= c - 2 && tc <= c + 12)) cutShot++;
    }
    const a = (total[name] ??= { shotRef: 0, shotHit: 0, cuts: 0, cutHit: 0, cutShot: 0 });
    a.shotRef += shots.length;
    a.shotHit += hit;
    a.cuts += cuts.length;
    a.cutHit += cutHit;
    a.cutShot += cutShot;
    row.push(`${name}: ${cuts.length} cuts, shot lines with a cut ${fmt(hit / shots.length)}, cuts with a human TC ${fmt(cutHit / Math.max(1, cuts.length))}`);
  }
  console.log(`${id} (${shots.length} human shot lines, ${(dur / 60).toFixed(0)} min)\n  ${row.join("\n  ")}`);
}
console.log("\nALL");
for (const [name, a] of Object.entries(total))
  console.log(`  ${name}: ${a.cuts} cuts | human shot lines with a cut before them ${fmt(a.shotHit / a.shotRef)} (${a.shotHit}/${a.shotRef}) | cuts followed by a human shot line ${fmt(a.cutShot / a.cuts)}, by any human TC ${fmt(a.cutHit / a.cuts)}`);
