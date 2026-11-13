// Usage: bun previewgen/study/selector.ts
// A learned choice of the shot lines: logistic regression on the features of candidates.ts,
// fitted on one episode and tested on the other. No model call.
import { loadGt } from "../gt";
import { score } from "../score";
import { candidates, type Candidate } from "./candidates";

const RUNS: Record<string, string> = { "1022": "exp/previewgen/out/1022_preview_work", "1023": "exp/previewgen/out2/1023_preview_work" };
const data = Object.fromEntries(Object.entries(RUNS).map(([id, dir]) => [id, candidates(id, dir)]));

const lg = (x: number) => Math.log(1 + Math.max(0, Math.min(x, 600)));
export function features(c: Candidate): number[] {
  return [
    1,
    c.atCut ? 1 : 0,
    !c.atCut && c.inMain && c.inPicture ? 1 : 0,
    !c.atCut && c.inMain && !c.inPicture ? 1 : 0,
    !c.atCut && c.cls === "thing" ? 1 : 0,
    !c.atCut && (c.cls === "code" || c.cls === "move") ? 1 : 0,
    c.talkBefore > 0 ? 1 : 0,
    c.talkAfter > 0 ? 1 : 0,
    c.talkBefore > 0 && c.talkAfter > 0 ? 1 : 0,
    lg(c.sincePrevLine),
    lg(c.sincePrevShot),
    lg(c.sinceCut),
    lg(c.toNextCut),
    lg(c.toNextLine),
  ];
}
const NAMES = ["bias", "at a cut", "inside, both passes", "inside, pass with sound only", "inside, a thing", "inside, code or move", "talk before", "talk after", "talk before and after", "log s since line before", "log s since shot line before", "log s since cut", "log s to next cut", "log s to next line"];

function fit(xs: number[][], ys: number[], l2 = 0.05, steps = 4000, rate = 0.05): number[] {
  const w = new Array(xs[0].length).fill(0);
  for (let s = 0; s < steps; s++) {
    const g = new Array(w.length).fill(0);
    xs.forEach((x, k) => {
      const p = 1 / (1 + Math.exp(-x.reduce((a, v, i) => a + v * w[i], 0)));
      x.forEach((v, i) => (g[i] += (p - ys[k]) * v));
    });
    w.forEach((_, i) => (w[i] -= rate * (g[i] / xs.length + (i ? l2 * w[i] : 0))));
  }
  return w;
}
const prob = (w: number[], c: Candidate) => 1 / (1 + Math.exp(-features(c).reduce((a, v, i) => a + v * w[i], 0)));
const pc = (x: number) => `${Math.round(100 * x)}%`;

for (const [train, test] of [["1023", "1022"], ["1022", "1023"], ["1022", "1022"], ["1023", "1023"]]) {
  const tr = data[train];
  const te = data[test];
  const w = fit(tr.cands.map(features), tr.cands.map((c) => (c.human ? 1 : 0)));
  console.log(`\nfitted on ${train}, tested on ${test}`);
  console.log(`  weights: ${NAMES.map((n, i) => `${n} ${w[i].toFixed(2)}`).join(" | ")}`);
  const gt = loadGt(`exp/previewgen/gt/${test}.hwpx`);
  // The limit of the fit episode that gives as many lines as its writer made.
  const trP = tr.cands.map((c) => prob(w, c)).sort((a, b) => b - a);
  const limit = trP[Math.min(trP.length - 1, tr.humanShots - 1)];
  const p = te.cands.map((c) => prob(w, c));
  const evalAt = (name: string, keep: (c: Candidate, k: number) => boolean) => {
    const drop = new Set(te.cands.filter((c, k) => !keep(c, k)).map((c) => c.i));
    const s = score(te.lines.filter((_, i) => !drop.has(i)), gt, [[0, te.dur + 1]], false, te.cuts);
    const r = s.shot.matched / s.shot.ref;
    const q = s.shot.matched / Math.max(1, s.shot.gen);
    console.log(`  ${name.padEnd(44)} ${s.shot.gen} lines (${(s.shot.gen / s.shot.ref).toFixed(2)} times) | found ${pc(r)} (at a cut ${pc(s.shotAt.cutFound / s.shotAt.cutRef)}, inside ${pc(s.shotAt.insideFound / Math.max(1, s.shotAt.insideRef))}) | at a human line ${pc(q)} | F1 ${pc((2 * r * q) / (r + q))}`);
  };
  evalAt("all candidates", () => true);
  evalAt("cuts + notes of both passes", (c) => c.atCut || (c.inMain && c.inPicture));
  evalAt("cuts + notes of the pass with sound", (c) => c.atCut || c.inMain);
  evalAt(`fit, limit of ${train} at its human count`, (_, k) => p[k] >= limit);
  const sorted = [...p].sort((a, b) => b - a);
  for (const f of [1.0, 1.15, 1.3]) {
    const n = Math.min(sorted.length, Math.round(te.humanShots * f));
    evalAt(`fit, best ${n} (${f} times the human count)`, (_, k) => p[k] >= sorted[n - 1]);
  }
}
