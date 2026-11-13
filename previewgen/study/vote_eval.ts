// Usage: bun previewgen/study/vote_eval.ts <tag of the base run> <tag> <tag> ... [--dir exp/previewgen/p5]
// Several runs of the watch step on the test stretches: a note inside a take stays when at least k runs have a
// shot line within 6 s of it. The speech lines and the lines at a cut come from the base run. No model call.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, mergeWindows, placeTc } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt, type PreviewLine } from "../gt";
import { score } from "../score";
import { DEV } from "./dev_eval";

const args = process.argv.slice(2);
const di = args.indexOf("--dir");
const dir = di >= 0 ? args.splice(di, 2)[1] : "exp/previewgen/p5";
const tags = args;
const pc = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;
const load = (id: string, tag: string) => {
  const gen = JSON.parse(fs.readFileSync(`${dir}/${id}_${tag}.json`, "utf-8")) as GenFile;
  return { lines: applyStyle(mergeWindows(gen.windows, gen.cuts), HOUSE_STYLE), cuts: gen.cuts };
};

for (let k = 1; k <= tags.length; k++) {
  for (const mode of ["base", "union"] as const) {
    if (mode === "union" && k === 1) continue;
    const sum = { ref: 0, gen: 0, hit: 0, inRef: 0, inHit: 0 };
    for (const id of Object.keys(DEV)) {
      const runs = tags.map((t) => load(id, t));
      const base = runs[0];
      const notes = (r: { lines: PreviewLine[] }) => r.lines.filter((l) => l.kind === "shot" && l.tcDoc === undefined);
      const votes = (t: number) => runs.filter((r) => r.lines.some((l) => l.kind === "shot" && Math.abs(l.tc! - t) <= 6)).length;
      let lines: PreviewLine[];
      if (mode === "base") lines = base.lines.filter((l) => !(l.kind === "shot" && l.tcDoc === undefined) || votes(l.tc!) >= k);
      else {
        // Notes of all runs with k votes, one for each cluster of 6 s; the text of the first run that has it.
        const pool = runs.flatMap((r) => notes(r)).filter((l) => votes(l.tc!) >= k).sort((a, b) => a.tc! - b.tc!);
        const kept: PreviewLine[] = [];
        for (const l of pool) if (!kept.length || l.tc! - kept[kept.length - 1].tc! > 6) kept.push(l);
        lines = [...base.lines.filter((l) => !(l.kind === "shot" && l.tcDoc === undefined)), ...kept.filter((n) => !base.lines.some((l) => l.kind === "shot" && l.tcDoc !== undefined && Math.abs(l.tc! - n.tc!) <= 6))]
          .map((l, i) => ({ l, i }))
          .sort((a, b) => Math.floor(a.l.tc!) - Math.floor(b.l.tc!) || a.i - b.i)
          .map((x) => x.l);
      }
      const s = score(placeTc(lines), loadGt(`exp/previewgen/gt/${id}.hwpx`), DEV[id], false, base.cuts);
      sum.ref += s.shot.ref; sum.gen += s.shot.gen; sum.hit += s.shot.matched; sum.inRef += s.shotAt.insideRef; sum.inHit += s.shotAt.insideFound;
    }
    const r = sum.hit / sum.ref;
    const q = sum.hit / sum.gen;
    console.log(`${mode === "base" ? `notes of ${tags[0]} with` : "notes of all runs with"} ${k} of ${tags.length} votes`.padEnd(40) + ` ${sum.gen} lines for ${sum.ref} (${(sum.gen / sum.ref).toFixed(2)} times) | found ${pc(sum.hit, sum.ref)} (inside ${pc(sum.inHit, sum.inRef)}) | at a human line ${pc(sum.hit, sum.gen)} | F1 ${Math.round((200 * r * q) / (r + q))}%`);
  }
}
