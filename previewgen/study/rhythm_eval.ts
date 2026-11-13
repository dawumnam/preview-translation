// Usage: bun previewgen/study/rhythm_eval.ts <id> <windows.json> [<shots.json>] [--grid] [--set minGap,noteGap,hostGap,foreignGap,otherGap,pause]
// The TC rhythm rule (placeTc) against the human preview, with no model call.
import fs from "fs";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows, placeTc, RHYTHM, type RhythmOptions } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt } from "../gt";
import { score, type Score } from "../score";

const args = process.argv.slice(2);
const id = args[0];
const files = args.slice(1).filter((a) => a.endsWith(".json"));
const gen = JSON.parse(fs.readFileSync(files[0], "utf-8")) as GenFile;
let merged = mergeWindows(gen.windows, gen.cuts);
if (files[1]) merged = joinShots(merged, mergeWindows((JSON.parse(fs.readFileSync(files[1], "utf-8")) as GenFile).windows, gen.cuts), gen.cuts);
const styled = applyStyle(merged, HOUSE_STYLE);
const gt = loadGt(`exp/previewgen/gt/${id}.hwpx`);
const dur = Math.max(...gen.windows.map((w) => w.end));

export interface Row {
  shotR: number;
  shotP: number;
  shotGen: number;
  tcR5: number;
  tcP5: number;
  tcR10: number;
  tcGen: number;
  cutR: number;
  insideR: number;
}
function row(s: Score): Row {
  return {
    shotR: s.shot.matched / s.shot.ref,
    shotP: s.shot.matched / Math.max(1, s.shot.gen),
    shotGen: s.shot.gen,
    tcR5: s.tc.within5 / s.tc.ref,
    tcP5: s.tc.genNearRef5 / Math.max(1, s.tc.gen),
    tcR10: s.tc.within10 / s.tc.ref,
    tcGen: s.tc.gen,
    cutR: s.shotAt.cutFound / Math.max(1, s.shotAt.cutRef),
    insideR: s.shotAt.insideFound / Math.max(1, s.shotAt.insideRef),
  };
}
const f1 = (p: number, r: number) => (p + r ? (2 * p * r) / (p + r) : 0);
const pc = (x: number) => `${Math.round(100 * x)}%`;
const show = (name: string, r: Row, s: Score) =>
  console.log(
    `${name.padEnd(34)} shot lines: found ${pc(r.shotR)} (at a cut ${pc(r.cutR)}, inside ${pc(r.insideR)}), right place ${pc(r.shotP)}, ${r.shotGen} lines (human ${s.shot.ref}) | TC lines: found@5s ${pc(r.tcR5)}, @10s ${pc(r.tcR10)}, right place@5s ${pc(r.tcP5)}, ${r.tcGen} TCs (human ${s.tc.ref})`,
  );

const base = score(styled, gt, [[0, dur + 1]], false, gen.cuts);
show("before (TC on speech after 8 s)", row(base), base);

const evalSet = (o: RhythmOptions) => {
  const s = score(placeTc(styled, o), gt, [[0, dur + 1]], false, gen.cuts);
  return { s, r: row(s) };
};
const setArg = args.indexOf("--set");
const params: RhythmOptions = setArg >= 0 ? (() => { const [minGap, noteGap, hostGap, foreignGap, otherGap, pause] = args[setArg + 1].split(",").map(parseFloat); return { minGap, noteGap, hostGap, foreignGap, otherGap, pause }; })() : RHYTHM;
const one = evalSet(params);
show(`rhythm ${Object.values(params).join(",")}`, one.r, one.s);
// Share of speech lines that show a TC (human, nine episodes: Korean 44%, foreign 25%).
{
  const placed = placeTc(styled, params);
  const ko = placed.filter((l) => l.kind === "speech" && l.use !== "direct");
  const fo = placed.filter((l) => l.kind === "foreign");
  const hk = gt.filter((l) => l.kind === "speech" && !/^디렉/.test(l.text.trim()));
  const hf = gt.filter((l) => l.kind === "foreign");
  console.log(`   speech lines with a TC: Korean ${pc(ko.filter((l) => l.showTc).length / ko.length)} (human here ${pc(hk.filter((l) => l.tc !== undefined).length / hk.length)}), foreign ${pc(fo.filter((l) => l.showTc).length / fo.length)} (human here ${pc(hf.filter((l) => l.tc !== undefined).length / hf.length)})`);
}

if (args.includes("--grid")) {
  const results: { o: RhythmOptions; r: Row }[] = [];
  for (const minGap of [5, 6, 7])
    for (const noteGap of [0, 6, 8, 10, 12])
      for (const hostGap of [6, 8, 10, 12])
        for (const foreignGap of [8, 12, 15, 20])
          for (const otherGap of [12, 16, 20, 25])
            for (const pause of [6, 8, 10, 99]) {
              const o = { minGap, noteGap, hostGap, foreignGap, otherGap, pause };
              results.push({ o, r: evalSet(o).r });
            }
  const key = (x: { r: Row }) => f1(x.r.tcP5, x.r.tcR5) + f1(x.r.shotP, x.r.shotR);
  results.sort((a, b) => key(b) - key(a));
  console.log(`\nbest of ${results.length} settings by F1 of TC lines (5 s) + F1 of shot lines:`);
  for (const x of results.slice(0, 8))
    console.log(`  ${Object.values(x.o).join(",").padEnd(18)} shot found ${pc(x.r.shotR)} right ${pc(x.r.shotP)} (${x.r.shotGen}) | TC found@5 ${pc(x.r.tcR5)} right@5 ${pc(x.r.tcP5)} (${x.r.tcGen}) | sum F1 ${key(x).toFixed(3)}`);
  // The effect of each parameter, the others at the best setting.
  const best = results[0].o;
  for (const name of Object.keys(best) as (keyof RhythmOptions)[]) {
    const vals = [...new Set(results.map((x) => x.o[name]))].sort((a, b) => a - b);
    const line = vals.map((v) => {
      const x = results.find((y) => (Object.keys(best) as (keyof RhythmOptions)[]).every((k) => (k === name ? y.o[k] === v : y.o[k] === best[k])))!;
      return `${v}: shot ${pc(x.r.shotR)}/${pc(x.r.shotP)} TC ${pc(x.r.tcR5)}/${pc(x.r.tcP5)}`;
    });
    console.log(`  ${name}: ${line.join(" | ")}`);
  }
}
