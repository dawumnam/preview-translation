// Usage: bun previewgen/study/dev_eval.ts <name>=<id>:<gen.json>[+<shots.json>],<id>:<gen.json>... [more variants] [--notes <gap s>] [--list <id>]
// Scores variants of the watch step on the same stretches of several episodes, and the sum over them.
// The stretches are fixed below. No model call.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows, placeTc, RHYTHM } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt } from "../gt";
import { score, type Score } from "../score";

export const DEV: Record<string, [number, number][]> = {
  "1023": [[600, 1500], [3120, 3720]],
  "1104": [[1800, 2400]],
  "1105": [[4650, 5250]],
  "1025": [[4800, 5400]],
  "1028": [[5400, 6000]],
  "1029": [[5600, 6200]],
  "1024": [[2000, 2600]],
};
const args = process.argv.slice(2);
const flag = (n: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
const noteGap = flag("notes") ? parseFloat(flag("notes")!) : 0;
const listId = flag("list");
const pc = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;

for (const v of args.filter((a) => a.includes("="))) {
  const [name, spec] = [v.slice(0, v.indexOf("=")), v.slice(v.indexOf("=") + 1)];
  const sum = { ref: 0, gen: 0, hit: 0, cutRef: 0, cutHit: 0, inRef: 0, inHit: 0, koRef: 0, koHit: 0, foRef: 0, foGen: 0, foHit: 0, tcRef: 0, tc5: 0, tcGen: 0, tcGen5: 0 };
  console.log(`\n== ${name}`);
  for (const part of spec.split(",")) {
    const [id, files] = [part.slice(0, part.indexOf(":")), part.slice(part.indexOf(":") + 1)];
    const [main, extra] = files.split("+");
    const gen = JSON.parse(fs.readFileSync(main, "utf-8")) as GenFile;
    let merged = mergeWindows(gen.windows, gen.cuts);
    if (extra) merged = joinShots(merged, mergeWindows((JSON.parse(fs.readFileSync(extra, "utf-8")) as GenFile).windows, gen.cuts), gen.cuts);
    const lines = placeTc(applyStyle(merged, HOUSE_STYLE), { ...RHYTHM, noteGap });
    const s: Score = score(lines, loadGt(`exp/previewgen/gt/${id}.hwpx`), DEV[id], listId === id, gen.cuts);
    const r = s.shot.matched / Math.max(1, s.shot.ref);
    const q = s.shot.matched / Math.max(1, s.shot.gen);
    console.log(`  ${id}: shot lines ${s.shot.gen} for ${s.shot.ref} (${(s.shot.gen / s.shot.ref).toFixed(2)} times) | found ${pc(s.shot.matched, s.shot.ref)} (cut ${s.shotAt.cutFound}/${s.shotAt.cutRef}, inside ${s.shotAt.insideFound}/${s.shotAt.insideRef}) | at a human line ${pc(s.shot.matched, s.shot.gen)} | F1 ${Math.round((200 * r * q) / (r + q || 1))}% | Korean ${pc(s.korean.refFound, s.korean.refLines)} | @@ ${pc(s.foreign.matched, s.foreign.ref)}/${pc(s.foreign.matched, s.foreign.gen)}`);
    sum.ref += s.shot.ref; sum.gen += s.shot.gen; sum.hit += s.shot.matched;
    sum.cutRef += s.shotAt.cutRef; sum.cutHit += s.shotAt.cutFound; sum.inRef += s.shotAt.insideRef; sum.inHit += s.shotAt.insideFound;
    sum.koRef += s.korean.refLines; sum.koHit += s.korean.refFound;
    sum.foRef += s.foreign.ref; sum.foGen += s.foreign.gen; sum.foHit += s.foreign.matched;
    sum.tcRef += s.tc.ref; sum.tc5 += s.tc.within5; sum.tcGen += s.tc.gen; sum.tcGen5 += s.tc.genNearRef5;
  }
  const r = sum.hit / sum.ref;
  const q = sum.hit / sum.gen;
  console.log(`  ALL : shot lines ${sum.gen} for ${sum.ref} (${(sum.gen / sum.ref).toFixed(2)} times) | found ${pc(sum.hit, sum.ref)} (cut ${pc(sum.cutHit, sum.cutRef)}, inside ${pc(sum.inHit, sum.inRef)}) | at a human line ${pc(sum.hit, sum.gen)} | F1 ${Math.round((200 * r * q) / (r + q))}% | Korean ${pc(sum.koHit, sum.koRef)} | @@ ${pc(sum.foHit, sum.foRef)}/${pc(sum.foHit, sum.foGen)} | TC lines: found ${pc(sum.tc5, sum.tcRef)}, right place ${pc(sum.tcGen5, sum.tcGen)} (${sum.tcGen} for ${sum.tcRef})`);
}
