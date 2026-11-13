// Usage: bun previewgen/study/self_agree.ts <tag a> <tag b>
// Two runs of the watch step on the test stretches against each other: how many shot lines of run A have a
// shot line of run B at the same place (the same rule as for the human preview: 10 s before to 5 s after)?
// No model call.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, mergeWindows } from "../assemble";
import type { GenFile } from "../gen";
import type { GtLine } from "../gt";
import { score } from "../score";
import { DEV } from "./dev_eval";

const [a, b] = process.argv.slice(2);
const load = (id: string, tag: string) => {
  const gen = JSON.parse(fs.readFileSync(`exp/previewgen/p5/${id}_${tag}.json`, "utf-8")) as GenFile;
  return { lines: applyStyle(mergeWindows(gen.windows, gen.cuts), HOUSE_STYLE), cuts: gen.cuts };
};
const sum = { ref: 0, gen: 0, hit: 0, cutRef: 0, cutHit: 0, inRef: 0, inHit: 0 };
for (const id of Object.keys(DEV)) {
  const ra = load(id, a);
  const rb = load(id, b);
  // Run A as the reference: its lines in the shape of a human preview. The shown time of a line at a cut is cut + 2 s.
  const ref: GtLine[] = ra.lines.map((l, i) => {
    const tc = l.tcDoc ?? l.tc!;
    return { ...l, tc, tcPrev: tc, tcNext: ra.lines[i + 1]?.tc ?? tc + 5, no: i, scene: "", raw: "" } as GtLine;
  });
  const s = score(rb.lines, ref, DEV[id], false, ra.cuts);
  sum.ref += s.shot.ref; sum.gen += s.shot.gen; sum.hit += s.shot.matched;
  sum.cutRef += s.shotAt.cutRef; sum.cutHit += s.shotAt.cutFound; sum.inRef += s.shotAt.insideRef; sum.inHit += s.shotAt.insideFound;
}
const pc = (x: number, y: number) => `${Math.round((100 * x) / y)}%`;
const r = sum.hit / sum.ref;
const q = sum.hit / sum.gen;
console.log(`run ${a}: ${sum.ref} shot lines; run ${b}: ${sum.gen} shot lines`);
console.log(`lines of ${a} with a line of ${b} at the same place: ${pc(sum.hit, sum.ref)} (at a cut ${pc(sum.cutHit, sum.cutRef)}, inside a take ${pc(sum.inHit, sum.inRef)})`);
console.log(`lines of ${b} with a line of ${a} at the same place: ${pc(sum.hit, sum.gen)} | F1 ${Math.round((200 * r * q) / (r + q))}%`);
