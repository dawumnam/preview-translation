// Usage: bun previewgen/study/scene_signals.ts
// What stands at the writer's scene starts: a slate, a camera cut, a long take before, a change of the kind of footage?
// Nine human previews, no model call.
import { loadGt } from "../gt";
import { ALL_IDS, cutsOf, ROOT } from "./lib";

let scenes = 0;
let slateBefore = 0;
let slates = 0;
let slateIsScene = 0;
let atCut = 0;
let firstIsShot = 0;
const gapsBefore: number[] = [];
const rows: string[] = [];
for (const id of ALL_IDS) {
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const cuts = cutsOf(id);
  const starts = gt.filter((l) => l.kind === "scene" && Number.isFinite(l.tcNext)).map((l) => ({ t: l.tcNext, title: l.text, no: l.no }));
  const slate = gt.filter((l) => l.kind === "shot" && /슬레이트|슬레/.test(l.text) && l.tc !== undefined).map((l) => l.tc!);
  const tcs = gt.filter((l) => l.tc !== undefined && l.kind !== "scene").map((l) => l.tc!);
  for (const s of starts) {
    scenes++;
    const sl = slate.some((x) => x >= s.t - 90 && x <= s.t + 5);
    if (sl) slateBefore++;
    const c = cuts.some((x) => Math.abs(x - s.t) <= 6 || (x <= s.t && s.t - x <= 12));
    if (c) atCut++;
    const first = gt.find((l) => l.no > s.no && l.kind !== "scene" && l.kind !== "note");
    if (first?.kind === "shot") firstIsShot++;
    const before = tcs.filter((x) => x < s.t);
    gapsBefore.push(before.length ? s.t - before[before.length - 1] : 0);
    rows.push(`${id} ${String(Math.floor(s.t / 60)).padStart(3)}:${String(Math.floor(s.t % 60)).padStart(2, "0")} ${sl ? "slate" : "     "} ${c ? "cut" : "   "} first line: ${(first?.kind ?? "").padEnd(7)} ${s.title}`);
  }
  for (const x of slate) {
    slates++;
    if (starts.some((s) => s.t >= x - 5 && s.t <= x + 90)) slateIsScene++;
  }
}
console.log(rows.join("\n"));
const pc = (a: number, b: number) => `${a}/${b} (${Math.round((100 * a) / b)}%)`;
console.log(`\nscene starts with a slate line in the 90 s before: ${pc(slateBefore, scenes)}`);
console.log(`slate lines with a scene start in the 90 s after: ${pc(slateIsScene, slates)}`);
console.log(`scene starts at a camera cut: ${pc(atCut, scenes)}`);
console.log(`scene starts whose first line is a shot line: ${pc(firstIsShot, scenes)}`);
gapsBefore.sort((a, b) => a - b);
console.log(`seconds from the last TC before the scene to its start: median ${gapsBefore[Math.floor(gapsBefore.length / 2)]}, p75 ${gapsBefore[Math.floor(gapsBefore.length * 0.75)]}, p90 ${gapsBefore[Math.floor(gapsBefore.length * 0.9)]}`);
