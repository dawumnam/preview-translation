// Usage: bun previewgen/study/silence_study.ts
// Do the human TC lines follow the speech activity of the sound? Nine previews, no model call.
// Idea: the writer notes the picture when nobody speaks, and puts a TC where speech starts again after a silence.
import fs from "fs";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;

function cutsOf(id: string): number[] {
  const out: number[] = [];
  let cur = 0;
  for (const line of fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8").split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=") && parseFloat(line.slice(18)) >= 0.1 && (!out.length || cur - out[out.length - 1] >= 1)) out.push(cur);
  }
  return out;
}

/** Speech stretches joined when the break between them is under `join` seconds. */
function bursts(segs: [number, number][], join: number): [number, number][] {
  const out: [number, number][] = [];
  for (const [a, b] of segs) {
    if (out.length && a - out[out.length - 1][1] < join) out[out.length - 1][1] = b;
    else out.push([a, b]);
  }
  return out;
}

const speechShare = (segs: [number, number][], a: number, b: number) => {
  let s = 0;
  for (const [x, y] of segs) {
    if (y <= a) continue;
    if (x >= b) break;
    s += Math.min(b, y) - Math.max(a, x);
  }
  return s / Math.max(0.001, b - a);
};

const onsetStat: Record<string, [number, number]> = {}; // silence bin → [human TC lines of speech at such an onset, ...]
const speechTc = { n: 0, atOnset1: 0, atOnset2: 0, atOnset3: 0, atOnset5: 0, mid: 0 };
const onsets: Record<number, [number, number, number]> = {}; // min silence → [onsets, with a human TC of any kind within 5 s, with a speech TC]
const shotIn = { cut: { n: 0, quiet: 0 }, inside: { n: 0, quiet: 0 } };
const quietLen: Record<string, { n: number; withShot: number; shots: number; sec: number }> = {};
const talkLen: Record<string, { n: number; shots: number; sec: number; insideShots: number }> = {};
let totalSec = 0;
let quietSec = 0;

for (const id of ids) {
  const vad = JSON.parse(fs.readFileSync(`${ROOT}/vad/${id}.json`, "utf-8")) as { duration: number; segments: [number, number][] };
  const segs = vad.segments;
  const cuts = cutsOf(id);
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`).filter((l) => l.kind !== "scene" && l.kind !== "note" && l.tc !== undefined && l.tc <= vad.duration);
  const tcs = gt.map((l) => l.tc!);
  const speechLines = gt.filter((l) => l.kind === "speech" || l.kind === "foreign");
  const shots = gt.filter((l) => l.kind === "shot" && l.text !== "영상종료");
  totalSec += vad.duration;

  // 1. Is a speech line with a TC at the start of speech after a silence?
  for (const l of speechLines) {
    const t = l.tc!;
    speechTc.n++;
    // The speech stretch that starts nearest to the TC (the writer's TC is to the second, and can come a little late).
    let best = -1;
    for (let i = 0; i < segs.length; i++) {
      if (segs[i][0] > t + 2.5) break;
      if (segs[i][0] >= t - 4) if (best < 0 || Math.abs(segs[i][0] - t) < Math.abs(segs[best][0] - t)) best = i;
    }
    if (best < 0) {
      speechTc.mid++;
      continue;
    }
    const silence = best > 0 ? segs[best][0] - segs[best - 1][1] : 99;
    if (silence >= 1) speechTc.atOnset1++;
    if (silence >= 2) speechTc.atOnset2++;
    if (silence >= 3) speechTc.atOnset3++;
    if (silence >= 5) speechTc.atOnset5++;
  }

  // 2. Of all starts of speech after a silence of X seconds: how many have a human TC?
  for (const minSil of [1, 2, 3, 5, 8]) {
    const o = (onsets[minSil] ??= [0, 0, 0]);
    for (let i = 1; i < segs.length; i++) {
      if (segs[i][0] - segs[i - 1][1] < minSil) continue;
      // Speech that goes on for a moment, not a single word or a noise.
      if (speechShare(segs, segs[i][0], segs[i][0] + 3) < 0.5) continue;
      o[0]++;
      if (tcs.some((x) => x >= segs[i][0] - 2.5 && x <= segs[i][0] + 5)) o[1]++;
      if (speechLines.some((l) => l.tc! >= segs[i][0] - 2.5 && l.tc! <= segs[i][0] + 5)) o[2]++;
    }
  }

  // 3. Shot lines: do they stand where nobody speaks?
  for (const l of shots) {
    const k = cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2) ? "cut" : "inside";
    shotIn[k].n++;
    if (speechShare(segs, l.tc! - 1, l.tc! + 5) < 0.2) shotIn[k].quiet++;
  }

  // 4. Quiet stretches (no speech; single words of under 1.5 s do not end them) and talk stretches (breaks under 4 s joined).
  const talk = bursts(segs.filter(([a, b]) => b - a >= 1.0), 4);
  let prevEnd = 0;
  const quiet: [number, number][] = [];
  for (const [a, b] of talk) {
    if (a - prevEnd > 0) quiet.push([prevEnd, a]);
    prevEnd = b;
  }
  if (vad.duration - prevEnd > 0) quiet.push([prevEnd, vad.duration]);
  const bin = (len: number) => (len < 8 ? "under 8 s" : len < 15 ? "8-15 s" : len < 30 ? "15-30 s" : len < 60 ? "30-60 s" : len < 120 ? "60-120 s" : "120 s or more");
  for (const [a, b] of quiet) {
    quietSec += b - a;
    const q = (quietLen[bin(b - a)] ??= { n: 0, withShot: 0, shots: 0, sec: 0 });
    const inside = shots.filter((l) => l.tc! >= a - 1 && l.tc! < b);
    q.n++;
    q.sec += b - a;
    q.shots += inside.length;
    if (inside.length) q.withShot++;
  }
  for (const [a, b] of talk) {
    const q = (talkLen[bin(b - a)] ??= { n: 0, shots: 0, sec: 0, insideShots: 0 });
    const inside = shots.filter((l) => l.tc! >= a + 1 && l.tc! < b);
    q.n++;
    q.sec += b - a;
    q.shots += inside.length;
    q.insideShots += inside.filter((l) => !cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2)).length;
  }
}

console.log(`Sound: ${(totalSec / 3600).toFixed(1)} h; quiet stretches (no talk) are ${Math.round((100 * quietSec) / totalSec)}% of the time`);
console.log(`\n1. Human speech lines with a TC: ${speechTc.n}`);
console.log(`   a start of speech within -4/+2.5 s of the TC: ${pct(speechTc.n - speechTc.mid, speechTc.n)}`);
console.log(`   ... after a silence of 1 s or more: ${pct(speechTc.atOnset1, speechTc.n)}; 2 s: ${pct(speechTc.atOnset2, speechTc.n)}; 3 s: ${pct(speechTc.atOnset3, speechTc.n)}; 5 s: ${pct(speechTc.atOnset5, speechTc.n)}`);
console.log(`\n2. Starts of speech after a silence (speech goes on for 1.5 s of the next 3 s):`);
for (const [k, [n, any, sp]] of Object.entries(onsets)) console.log(`   silence of ${k} s or more: ${n} starts; a human TC line of any kind within -2.5/+5 s: ${pct(any, n)}; a human speech line with a TC: ${pct(sp, n)}`);
console.log(`\n3. Human shot lines in a quiet moment (speech in under 20% of the 6 s around the TC):`);
console.log(`   at a cut: ${pct(shotIn.cut.quiet, shotIn.cut.n)}; inside a take: ${pct(shotIn.inside.quiet, shotIn.inside.n)}`);
console.log(`\n4. Quiet stretches, by length: how many hold a human shot line, and seconds for each shot line`);
for (const k of ["under 8 s", "8-15 s", "15-30 s", "30-60 s", "60-120 s", "120 s or more"]) {
  const q = quietLen[k];
  if (q) console.log(`   ${k.padEnd(14)} ${String(q.n).padStart(5)} stretches, ${Math.round(q.sec / 60)} min; with a shot line: ${pct(q.withShot, q.n)}; ${q.shots} shot lines, one for each ${q.shots ? Math.round(q.sec / q.shots) : "-"} s`);
}
console.log(`\n5. Talk stretches, by length: human shot lines inside them`);
for (const k of ["under 8 s", "8-15 s", "15-30 s", "30-60 s", "60-120 s", "120 s or more"]) {
  const q = talkLen[k];
  if (q) console.log(`   ${k.padEnd(14)} ${String(q.n).padStart(5)} stretches, ${Math.round(q.sec / 60)} min; ${q.shots} shot lines (${q.insideShots} not at a cut), one for each ${q.shots ? Math.round(q.sec / q.shots) : "-"} s`);
}
