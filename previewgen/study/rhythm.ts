// Usage: bun previewgen/study/rhythm.ts
// Where do the human shot lines stand that are not at a cut? How long after the line before them?
import fs from "fs";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

function cutsOf(id: string): number[] {
  // Spike detector on the ffmpeg scene score (see cutstudy.ts): min 0.03, 3 times the second highest neighbour.
  const text = fs.readFileSync(`${ROOT}/scores/${id}.txt`, "utf-8");
  const t: number[] = [];
  const s: number[] = [];
  let cur = 0;
  for (const line of text.split("\n")) {
    if (line.startsWith("frame:")) cur = parseFloat(line.slice(line.lastIndexOf("pts_time:") + 9));
    else if (line.startsWith("lavfi.scene_score=")) {
      t.push(cur);
      s.push(parseFloat(line.slice(18)));
    }
  }
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] < 0.03) continue;
    const nb: number[] = [];
    for (let k = Math.max(0, i - 12); k <= Math.min(s.length - 1, i + 12); k++) if (k !== i) nb.push(s[k]);
    nb.sort((a, b) => a - b);
    if (s[i] >= 3 * Math.max(nb[nb.length - 2] ?? 0, 0.002) && (!out.length || t[i] - out[out.length - 1] >= 1)) out.push(t[i]);
  }
  return out;
}

const q = (xs: number[], p: number) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length * p)];
const all = { atCut: 0, notCut: 0, repeat: 0, gaps: [] as number[], gapsAtCut: [] as number[], afterSpeech: 0, afterShot: 0 };
const shotOnlyGaps: number[] = [];
const anyGaps: number[] = [];
for (const id of ids) {
  const cuts = cutsOf(id);
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  let prevTc: number | undefined;
  let prevKind = "";
  let prevShotText = "";
  for (const l of gt) {
    if (l.tc === undefined) continue;
    const gap = prevTc === undefined ? NaN : l.tc - prevTc;
    if (Number.isFinite(gap)) anyGaps.push(gap);
    if (l.kind === "shot" && l.text !== "영상종료") {
      const atCut = cuts.some((c) => c >= l.tc! - 12 && c <= l.tc! + 2);
      if (atCut) {
        all.atCut++;
        if (Number.isFinite(gap)) all.gapsAtCut.push(gap);
      } else {
        all.notCut++;
        if (Number.isFinite(gap)) all.gaps.push(gap);
        if (l.text.replace(/\s/g, "") === prevShotText.replace(/\s/g, "")) all.repeat++;
        if (prevKind === "shot") all.afterShot++;
        else all.afterSpeech++;
      }
      if (prevKind === "shot" && Number.isFinite(gap)) shotOnlyGaps.push(gap);
      prevShotText = l.text;
    }
    prevTc = l.tc;
    prevKind = l.kind;
  }
}
console.log(`human shot lines at a cut: ${all.atCut}; not at a cut: ${all.notCut} (same text as the shot line before: ${all.repeat}; line before is a shot line: ${all.afterShot}, a speech line: ${all.afterSpeech})`);
console.log(`seconds since the TC before, shot lines NOT at a cut: p10 ${q(all.gaps, 0.1)} p25 ${q(all.gaps, 0.25)} p50 ${q(all.gaps, 0.5)} p75 ${q(all.gaps, 0.75)} p90 ${q(all.gaps, 0.9)}`);
console.log(`seconds since the TC before, shot lines at a cut:     p10 ${q(all.gapsAtCut, 0.1)} p25 ${q(all.gapsAtCut, 0.25)} p50 ${q(all.gapsAtCut, 0.5)} p75 ${q(all.gapsAtCut, 0.75)} p90 ${q(all.gapsAtCut, 0.9)}`);
console.log(`gap between two TCs of any kind: p50 ${q(anyGaps, 0.5)} p75 ${q(anyGaps, 0.75)} p90 ${q(anyGaps, 0.9)} p95 ${q(anyGaps, 0.95)} p99 ${q(anyGaps, 0.99)}; share above 30 s ${(anyGaps.filter((g) => g > 30).length / anyGaps.length * 100).toFixed(0)}%, above 45 s ${(anyGaps.filter((g) => g > 45).length / anyGaps.length * 100).toFixed(0)}%, above 60 s ${(anyGaps.filter((g) => g > 60).length / anyGaps.length * 100).toFixed(1)}%`);
