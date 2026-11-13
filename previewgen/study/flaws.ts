// Usage: bun previewgen/study/flaws.ts
// Facts about the structure of the human previews, and how far two runs of the model agree with each other.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, mergeWindows } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt } from "../gt";

const ROOT = "exp/previewgen";
const ids = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];

console.log("episode | scenes | shot lines | speech lines, with a TC | 디렉 lines | minutes for each scene (min..max)");
for (const id of ids) {
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const end = Math.max(...gt.filter((l) => l.tc !== undefined).map((l) => l.tc!));
  const scenes = gt.filter((l) => l.kind === "scene" && Number.isFinite(l.tcNext));
  const lens = scenes.map((s, i) => ((i + 1 < scenes.length ? scenes[i + 1].tcNext : end) - s.tcNext) / 60);
  const speech = gt.filter((l) => l.kind === "speech" || l.kind === "foreign");
  const direct = gt.filter((l) => l.kind === "speech" && /^디렉/.test(l.text.trim())).length;
  console.log(
    `${id} | ${scenes.length} | ${gt.filter((l) => l.kind === "shot").length} | ${speech.length}, ${Math.round((100 * speech.filter((l) => l.tc !== undefined).length) / speech.length)}% | ${direct} | ${Math.min(...lens).toFixed(1)}..${Math.max(...lens).toFixed(1)}`,
  );
}

// Two runs of the model on 1023 (prompts 2 and 3): do they put shot lines at the same places?
const load = (p: string) => JSON.parse(fs.readFileSync(p, "utf-8")) as GenFile;
const a = load(`${ROOT}/p2/1023_full_v2.json`);
const b = load(`${ROOT}/p2/1023_full_v3.json`);
const cuts = b.cuts ?? [];
const shots = (g: GenFile) => applyStyle(mergeWindows(g.windows, g.cuts ?? []), HOUSE_STYLE).filter((l) => l.kind === "shot").map((l) => l.tc!);
const [sa, sb] = [shots(a), shots(b)];
function agree(x: number[], y: number[]) {
  const st = { cut: [0, 0], inside: [0, 0] };
  for (const t of x) {
    const k = cuts.some((c) => Math.abs(c - t) <= 2.5) ? "cut" : "inside";
    st[k][1]++;
    if (y.some((u) => Math.abs(u - t) <= 8)) st[k][0]++;
  }
  return st;
}
const p = (v: number[]) => `${v[0]}/${v[1]} (${Math.round((100 * v[0]) / Math.max(1, v[1]))}%)`;
const ab = agree(sa, sb);
const ba = agree(sb, sa);
console.log(`\ntwo runs of the model on 1023, shot lines of one run that the other run has within 8 s:`);
console.log(`  at a camera cut: ${p(ab.cut)} and ${p(ba.cut)} | inside a take: ${p(ab.inside)} and ${p(ba.inside)}`);
console.log(`  cuts in 1023: ${cuts.length}; with a shot line of run 2: ${cuts.filter((c) => sa.some((t) => Math.abs(t - c) <= 2.5)).length}, of run 3: ${cuts.filter((c) => sb.some((t) => Math.abs(t - c) <= 2.5)).length}`);
