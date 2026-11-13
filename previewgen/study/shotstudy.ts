// Usage: bun previewgen/study/shotstudy.ts [ids...]
// 1. A cut detector that adapts to the footage (dark scenes give low scores), against the fixed limit.
// 2. The human shot lines by what they describe, apart for lines at a cut and lines inside a take.
import fs from "fs";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = process.argv.slice(2).length ? process.argv.slice(2) : ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

export function loadScores(id: string): { t: Float64Array; s: Float32Array } {
  const ts: number[] = [];
  const ss: number[] = [];
  let cur = 0;
  for (const line of fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8").split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=")) {
      ts.push(cur);
      ss.push(parseFloat(line.slice(18)));
    }
  }
  return { t: Float64Array.from(ts), s: Float32Array.from(ss) };
}

export function cutsFixed(t: Float64Array, s: Float32Array, th = 0.1): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) if (s[i] >= th && (!out.length || t[i] - out[out.length - 1] >= 1)) out.push(t[i]);
  return out;
}

/**
 * A frame is a cut when its score is the highest in the half second around it,
 * is at least `floor`, and is `ratio` times the usual score of the 2 s before
 * and after it (the 75th percentile of those frames, so that a moving camera
 * does not count as a cut).
 */
export function cutsAdaptive(t: Float64Array, s: Float32Array, floor = 0.035, ratio = 6, fixed = 0.1): number[] {
  const out: number[] = [];
  const half = 60; // frames: 2 s at 30 fps
  const guard = 15;
  const buf: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] < floor) continue;
    let isMax = true;
    for (let k = Math.max(0, i - guard); k <= Math.min(s.length - 1, i + guard); k++) if (s[k] > s[i]) isMax = false;
    if (!isMax) continue;
    buf.length = 0;
    for (let k = Math.max(0, i - half); k <= Math.min(s.length - 1, i + half); k++) if (Math.abs(k - i) > 2) buf.push(s[k]);
    buf.sort((a, b) => a - b);
    const usual = buf[Math.floor(buf.length * 0.75)] ?? 0;
    if (s[i] >= fixed || s[i] >= ratio * Math.max(usual, 0.003)) {
      if (!out.length || t[i] - out[out.length - 1] >= 1) out.push(t[i]);
    }
  }
  return out;
}

const MOVE = /(^|[\s,])(pan|tu|td|tr|줌|zoom|zi|zo|팔로우|follow)($|[\s,])|->|→/i;
const FRAME = /(^|[\s,])(sk|cs|bs|fs|ls|ts|ws|2s|3s|ins|fw|os)($|[\s,])|아웃포커싱|고속/i;
const PEOPLE = /큐|[가-힣]남|[가-힣]여|할|사람|아이|딸|주인|가족|자매/;

if (import.meta.main) {
  const fmt = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
  const tot: Record<string, { cuts: number; shotRef: number; shotHit: number; cutShot: number; cutAny: number }> = {};
  const types: Record<string, [number, number]> = {}; // type → [at cut, inside]
  const examples: Record<string, string[]> = {};
  for (const id of ids) {
    const { t, s } = loadScores(id);
    const dur = t[t.length - 1];
    const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
    const shots = gt.filter((l) => l.kind === "shot" && l.tc !== undefined && l.tc <= dur + 5 && l.text !== "영상종료");
    const timed = gt.filter((l) => l.tc !== undefined && l.tc <= dur + 5).map((l) => l.tc!);
    const detectors: [string, number[]][] = [
      ["fixed 0.10", cutsFixed(t, s)],
      ["adaptive floor 0.035 x6", cutsAdaptive(t, s, 0.035, 6)],
      ["adaptive floor 0.025 x8", cutsAdaptive(t, s, 0.025, 8)],
      ["adaptive floor 0.02 x10", cutsAdaptive(t, s, 0.02, 10)],
      ["adaptive floor 0.02 x6", cutsAdaptive(t, s, 0.02, 6)],
    ];
    for (const [name, cuts] of detectors) {
      const a = (tot[name] ??= { cuts: 0, shotRef: 0, shotHit: 0, cutShot: 0, cutAny: 0 });
      a.cuts += cuts.length;
      a.shotRef += shots.length;
      a.shotHit += shots.filter((l) => cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2)).length;
      a.cutShot += cuts.filter((c) => shots.some((l) => l.tc! >= c - 2 && l.tc! <= c + 12)).length;
      a.cutAny += cuts.filter((c) => timed.some((x) => x >= c - 2 && x <= c + 12)).length;
    }
    const cuts = cutsAdaptive(t, s, 0.025, 8);
    for (const l of shots) {
      const atCut = cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2);
      const type = MOVE.test(l.text) ? "camera move (pan, tu, td, tr, A -> B)" : FRAME.test(l.text) ? "framing code only (sk, cs, bs, fs ...)" : PEOPLE.test(l.text) ? "people: who does what" : "thing or place, no code";
      (types[type] ??= [0, 0])[atCut ? 0 : 1]++;
      if (!atCut && (examples[type] ??= []).length < 14 && Math.random() < 0.05) examples[type].push(`${id} ${l.raw.trim().replace(/\t/g, " ")}`);
    }
  }
  console.log("1. Cut detectors");
  for (const [name, a] of Object.entries(tot))
    console.log(`  ${name.padEnd(26)} ${String(a.cuts).padStart(5)} cuts | human shot lines with a cut in the 12 s before: ${fmt(a.shotHit, a.shotRef)} | cuts followed by a human shot line ${fmt(a.cutShot, a.cuts)}, by any human TC ${fmt(a.cutAny, a.cuts)}`);
  console.log("\n2. Human shot lines by what they describe (cuts: adaptive floor 0.025 x8)");
  let c0 = 0;
  let c1 = 0;
  for (const [type, [a, b]] of Object.entries(types)) {
    console.log(`  ${type.padEnd(42)} at a cut ${String(a).padStart(4)} | inside a take ${String(b).padStart(4)} (${Math.round((100 * b) / (a + b))}% of this type)`);
    c0 += a;
    c1 += b;
  }
  console.log(`  ${"all".padEnd(42)} at a cut ${String(c0).padStart(4)} | inside a take ${String(c1).padStart(4)}`);
  console.log("\n3. Examples of lines inside a take");
  for (const [type, ex] of Object.entries(examples)) console.log(`  ${type}:\n${ex.map((e) => `    ${e.slice(0, 60)}`).join("\n")}`);
}
