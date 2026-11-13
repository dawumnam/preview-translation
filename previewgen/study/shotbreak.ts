// Usage: bun previewgen/study/shotbreak.ts <gen.json> <reference.hwpx> [tolBefore=10] [tolAfter=5]
// Human shot lines found or not, apart for lines at a camera cut and lines inside a take.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, mergeWindows } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt, renderLine } from "../gt";

const [genPath, gtPath, tb = "10", ta = "5"] = process.argv.slice(2);
const before = parseFloat(tb);
const after = parseFloat(ta);
const gen = JSON.parse(fs.readFileSync(genPath, "utf-8")) as GenFile;
const ranges = gen.windows.map((w) => [w.start, w.end] as [number, number]);
const inRange = (t: number) => ranges.some(([a, b]) => t >= a && t < b);
const lines = applyStyle(mergeWindows(gen.windows, gen.cuts ?? []), HOUSE_STYLE);
const mine = lines.filter((l) => l.kind === "shot" && inRange(l.tc!)).map((l) => l.tc!);
const cuts = gen.cuts ?? [];
const ref = loadGt(gtPath).filter((l) => l.kind === "shot" && l.tc !== undefined && inRange(l.tcPrev) && l.text !== "영상종료");
const stat = { cut: { n: 0, hit: 0 }, inside: { n: 0, hit: 0 } };
const missed: string[] = [];
for (const r of ref) {
  const atCut = cuts.some((c) => c >= r.tc! - 12 && c <= r.tc! + 2);
  const hit = mine.some((t) => t >= r.tc! - before && t <= r.tc! + after);
  const k = atCut ? "cut" : "inside";
  stat[k].n++;
  if (hit) stat[k].hit++;
  else missed.push(`${atCut ? "C" : " "} ${renderLine(r)}`);
}
const pct = (a: number, b: number) => `${a}/${b} (${b ? Math.round((100 * a) / b) : 0}%)`;
console.log(`window -${before}/+${after} s | human shot lines at a cut: found ${pct(stat.cut.hit, stat.cut.n)} | inside a take: found ${pct(stat.inside.hit, stat.inside.n)} | all ${pct(stat.cut.hit + stat.inside.hit, stat.cut.n + stat.inside.n)} | generated ${mine.length}`);
if (process.argv.includes("--list")) console.log(missed.join("\n"));
