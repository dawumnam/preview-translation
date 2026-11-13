// Usage: bun previewgen/study/candidates.ts <id> <work dir> [--json out.json]
// Each shot line of the machine log as a candidate: does the writer have a shot line at its place?
// Prints the share of candidates with a human line, by feature. No model call.
import fs from "fs";
import path from "path";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt, type PreviewLine } from "../gt";
import { score } from "../score";

export interface Candidate {
  i: number; // position in the machine lines
  tc: number;
  text: string;
  human: boolean; // the writer has a shot line at this place
  atCut: boolean;
  inMain: boolean; // the pass with picture and sound has a shot line within 6 s
  inPicture: boolean; // the picture-only pass has one within 6 s
  sinceCut: number;
  toNextCut: number;
  sincePrevLine: number; // seconds since the line before (any kind)
  sincePrevShot: number;
  toNextLine: number;
  talkBefore: number; // speech lines in the 10 s before
  talkAfter: number; // speech lines in the 10 s after
  cls: "code" | "move" | "thing" | "people";
}

const CODE = /^(sk|cs|bs|fs|ws|ls|ms|2s|3s|gs|os|ins|고속|슬레이트|tu|td|pan|tr|zi|zo|줌인|줌아웃|\s|,|\/|-|>|→)+$/i;
const MOVE = /(^|\s)(tu|td|pan|tr|zi|zo|줌인|줌아웃|팔로우|follow)(\s|$)/i;
const PEOPLE = /(큐|코|피|카감|남|여|할|아이|사람|주민|직원|상인|손님|일행|들)/;

export function classOf(text: string): Candidate["cls"] {
  const t = text.trim();
  if (CODE.test(t)) return MOVE.test(t) ? "move" : "code";
  if (PEOPLE.test(t) && /(는|은|인|한|던|며|고)(\s|$)/.test(t)) return "people";
  if (MOVE.test(t)) return "move";
  return PEOPLE.test(t) ? "people" : "thing";
}

export function candidates(id: string, dir: string): { cands: Candidate[]; humanShots: number; humanFound: number; lines: PreviewLine[]; cuts: number[]; dur: number } {
  // `dir` is the work directory of a run, or one output file of gen.ts.
  const single = dir.endsWith(".json");
  const gen = JSON.parse(fs.readFileSync(single ? dir : path.join(dir, "windows.json"), "utf-8")) as GenFile;
  const base = mergeWindows(gen.windows, gen.cuts);
  const shotsFile = single ? dir.replace(/\.json$/, "_shots.json") : path.join(dir, "shots.json");
  const extra = fs.existsSync(shotsFile) ? mergeWindows((JSON.parse(fs.readFileSync(shotsFile, "utf-8")) as GenFile).windows, gen.cuts) : [];
  const lines = applyStyle(joinShots(base, extra, gen.cuts), HOUSE_STYLE);
  const dur = Math.max(...gen.windows.map((w) => w.end));
  const gt = loadGt(`exp/previewgen/gt/${id}.hwpx`);
  const s = score(lines, gt, [[0, dur + 1]], false, gen.cuts);
  const hit = new Set((s.shotPairs ?? []).map(([, j]) => j));
  const mainShots = base.filter((l) => l.kind === "shot").map((l) => l.tc!);
  const pictureShots = extra.filter((l) => l.kind === "shot").map((l) => l.tc!);
  const near = (xs: number[], t: number) => xs.some((x) => Math.abs(x - t) <= 6);
  const talk = lines.filter((l) => l.kind !== "shot" && l.use !== "direct").map((l) => l.tc!);
  const cands: Candidate[] = [];
  let prevShot = -Infinity;
  lines.forEach((l, i) => {
    if (l.kind !== "shot") return;
    const t = l.tc!;
    const before = gen.cuts.filter((c) => c <= t + 0.01);
    const after = gen.cuts.filter((c) => c > t + 0.01);
    cands.push({
      i,
      tc: t,
      text: l.text,
      human: hit.has(i),
      atCut: l.tcDoc !== undefined,
      inMain: near(mainShots, t),
      inPicture: near(pictureShots, t),
      sinceCut: before.length ? t - before[before.length - 1] : t,
      toNextCut: after.length ? after[0] - t : dur - t,
      sincePrevLine: i > 0 ? t - lines[i - 1].tc! : 99,
      sincePrevShot: t - prevShot,
      toNextLine: i + 1 < lines.length ? lines[i + 1].tc! - t : 99,
      talkBefore: talk.filter((x) => x >= t - 10 && x < t).length,
      talkAfter: talk.filter((x) => x >= t && x <= t + 10).length,
      cls: classOf(l.text),
    });
    prevShot = t;
  });
  return { cands, humanShots: s.shot.ref, humanFound: s.shot.matched, lines, cuts: gen.cuts, dur };
}

if (import.meta.main) {
  const [id, dir] = process.argv.slice(2);
  const { cands, humanShots, humanFound } = candidates(id, dir);
  const pc = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
  const rate = (name: string, f: (c: Candidate) => boolean, of: Candidate[] = cands) => {
    const x = of.filter(f);
    console.log(`  ${name.padEnd(46)} with a human line: ${pc(x.filter((c) => c.human).length, x.length)}`);
  };
  console.log(`${id}: ${cands.length} machine shot lines, ${humanShots} human shot lines (${humanFound} found)`);
  rate("all", () => true);
  rate("at a cut", (c) => c.atCut);
  const inside = cands.filter((c) => !c.atCut);
  rate("inside a take", () => true, inside);
  console.log(" inside a take, by pass:");
  rate("both passes", (c) => c.inMain && c.inPicture, inside);
  rate("pass with sound only", (c) => c.inMain && !c.inPicture, inside);
  rate("picture-only pass only", (c) => !c.inMain && c.inPicture, inside);
  console.log(" inside a take, by kind of note:");
  for (const k of ["people", "thing", "code", "move"] as const) rate(k, (c) => c.cls === k, inside);
  console.log(" inside a take, by talk around the note (speech lines in the 10 s before / after):");
  rate("no talk before, no talk after", (c) => !c.talkBefore && !c.talkAfter, inside);
  rate("talk before only", (c) => c.talkBefore > 0 && !c.talkAfter, inside);
  rate("talk after only", (c) => !c.talkBefore && c.talkAfter > 0, inside);
  rate("talk before and after", (c) => c.talkBefore > 0 && c.talkAfter > 0, inside);
  console.log(" inside a take, by seconds since the shot line before:");
  for (const [a, b] of [[0, 8], [8, 15], [15, 25], [25, 40], [40, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} s`, (c) => c.sincePrevShot >= a && c.sincePrevShot < b, inside);
  console.log(" inside a take, by seconds since the line before (any kind):");
  for (const [a, b] of [[0, 3], [3, 6], [6, 10], [10, 20], [20, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} s`, (c) => c.sincePrevLine >= a && c.sincePrevLine < b, inside);
  console.log(" inside a take, by seconds since the cut:");
  for (const [a, b] of [[0, 10], [10, 30], [30, 60], [60, 180], [180, 1e9]]) rate(`${a} to ${b > 1e8 ? "…" : b} s`, (c) => c.sinceCut >= a && c.sinceCut < b, inside);
  const j = process.argv.indexOf("--json");
  if (j >= 0) fs.writeFileSync(process.argv[j + 1], JSON.stringify(cands, null, 1));
}
