// Usage: bun previewgen/study/shotunion.ts <reference.hwpx> <gen1.json> [<gen2.json> ...]
// Shot lines of several runs joined: how many human shot lines are found, at what count of lines?
import fs from "fs";
import { applyStyle, HOUSE_STYLE, mergeWindows } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt } from "../gt";

const [gtPath, ...genPaths] = process.argv.slice(2);
const gens = genPaths.map((p) => JSON.parse(fs.readFileSync(p, "utf-8")) as GenFile);
const ranges = gens[0].windows.map((w) => [w.start, w.end] as [number, number]);
const inRange = (t: number) => ranges.some(([a, b]) => t >= a && t < b);
const cuts = gens.find((g) => g.cuts?.length)?.cuts ?? [];
const shotsOf = (g: GenFile) => applyStyle(mergeWindows(g.windows, g.cuts ?? []), HOUSE_STYLE).filter((l) => l.kind === "shot" && inRange(l.tc!)).map((l) => l.tc!);
const ref = loadGt(gtPath).filter((l) => l.kind === "shot" && l.tc !== undefined && inRange(l.tcPrev) && l.text !== "영상종료");

function evalSet(name: string, mine: number[]) {
  for (const [b, a] of [[10, 5], [15, 8]]) {
    const st = { cut: [0, 0], inside: [0, 0] };
    for (const r of ref) {
      const k = cuts.some((c) => c >= r.tc! - 12 && c <= r.tc! + 2) ? "cut" : "inside";
      st[k][1]++;
      if (mine.some((t) => t >= r.tc! - b && t <= r.tc! + a)) st[k][0]++;
    }
    const supported = mine.filter((t) => ref.some((r) => t >= r.tc! - b && t <= r.tc! + a)).length;
    const p = (x: number, y: number) => `${Math.round((100 * x) / Math.max(1, y))}%`;
    console.log(`${name} | -${b}/+${a} s | at a cut ${p(st.cut[0], st.cut[1])} | inside a take ${p(st.inside[0], st.inside[1])} | all ${p(st.cut[0] + st.inside[0], ref.length)} | lines ${mine.length} (human ${ref.length}), with a human line near ${p(supported, mine.length)}`);
  }
}

const each = gens.map(shotsOf);
each.forEach((m, i) => evalSet(`run ${i + 1}`, m));
// Union: a line of a later run is added when no line of the union is within 6 s of it.
const union: number[] = [];
for (const m of each) for (const t of m) if (!union.some((u) => Math.abs(u - t) <= 6)) union.push(t);
union.sort((a, b) => a - b);
evalSet("union", union);
// Lines that at least two runs have.
if (each.length >= 2) {
  const two = union.filter((u) => each.filter((m) => m.some((t) => Math.abs(t - u) <= 6)).length >= 2);
  evalSet("in two runs or more", two);
}
