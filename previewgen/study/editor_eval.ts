// Usage: bun --env-file=<.env> previewgen/study/editor_eval.ts <target id> <target work dir> <example id> <example work dir> [--model m] [--thinking L] [--save file.json] [--ranges a-b,c-d]
// The editor step (previewgen/editor.ts) on a finished run, with examples from another finished run.
import fs from "fs";
import path from "path";
import { usageReport } from "../../src/llm";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows, placeTc, RHYTHM } from "../assemble";
import { editLines, type EditExample } from "../editor";
import type { GenFile } from "../gen";
import { loadGt, type PreviewLine } from "../gt";
import { formatScore, score } from "../score";

const [tid, tdir, eid, edir] = process.argv.slice(2);
const arg = (n: string, d?: string) => (process.argv.indexOf(`--${n}`) >= 0 ? process.argv[process.argv.indexOf(`--${n}`) + 1] : d);
const ROOT = "exp/previewgen";

function machineOf(dir: string): { lines: PreviewLine[]; cuts: number[]; dur: number } {
  const gen = JSON.parse(fs.readFileSync(path.join(dir, "windows.json"), "utf-8")) as GenFile;
  let merged = mergeWindows(gen.windows, gen.cuts);
  const shots = path.join(dir, "shots.json");
  if (fs.existsSync(shots)) merged = joinShots(merged, mergeWindows((JSON.parse(fs.readFileSync(shots, "utf-8")) as GenFile).windows, gen.cuts), gen.cuts);
  return { lines: applyStyle(merged, HOUSE_STYLE), cuts: gen.cuts, dur: Math.max(...gen.windows.map((w) => w.end)) };
}

// Examples: stretches of the example episode, of different kinds of footage.
const EXAMPLE_RANGES: Record<string, [number, number, string][]> = {
  "1023": [
    [0, 300, "the host walks and speaks to the camera, several takes"],
    [604, 905, "scenery shots with no talk"],
    [1437, 1740, "the host meets a local woman; interview through the interpreter"],
    [3759, 4080, "an old man shows his storeroom; talk through the interpreter"],
  ],
  "1022": [
    [0, 300, "food shots, then the host in the car speaks to the camera"],
    [1280, 1640, "a woman makes bread; few words"],
    [3227, 3560, "interview with the woman through the interpreter"],
    [4440, 4740, "the host eats and talks with the woman"],
  ],
};
const ex = machineOf(edir);
const exGt = loadGt(`${ROOT}/gt/${eid}.hwpx`).filter((l) => l.kind !== "scene" && l.kind !== "note");
const examples: EditExample[] = EXAMPLE_RANGES[eid].map(([a, b, title]) => ({
  title,
  machine: ex.lines.filter((l) => l.tc! >= a && l.tc! < b),
  human: exGt.filter((l) => l.tcPrev >= a && l.tcPrev < b),
}));

const target = machineOf(tdir);
const gt = loadGt(`${ROOT}/gt/${tid}.hwpx`);
const ranges: [number, number][] = arg("ranges") ? arg("ranges")!.split(",").map((r) => r.split("-").map(parseFloat) as [number, number]) : [[0, target.dur + 1]];
const inRange = (t: number) => ranges.some(([a, b]) => t >= a && t < b);
const machine = target.lines.filter((l) => inRange(l.tc!));

const short = (s: ReturnType<typeof score>) => formatScore(s).split("\n").filter((l) => /^(Korean lines|Foreign|Shot|  of these|TC lines)/.test(l)).join("\n");
console.log(`--- ${tid}: machine log, TC on speech after 8 s (before)`);
console.log(short(score(machine, gt, ranges, false, target.cuts)));
console.log(`--- ${tid}: clock rule`);
console.log(short(score(placeTc(machine, RHYTHM), gt, ranges, false, target.cuts)));

const t0 = performance.now();
const r = await editLines(machine, examples, arg("model", "gemini-4-argon")!, (c) => placeTc(c, RHYTHM), 420, arg("thinking", "LOW") as "LOW");
console.log(`--- ${tid}: editor with examples from ${eid} (${((performance.now() - t0) / 1000).toFixed(0)} s, chunks with no answer: ${r.failed})`);
console.log(short(score(r.lines, gt, ranges, false, target.cuts)));
console.log(JSON.stringify(usageReport()));
if (arg("save")) fs.writeFileSync(arg("save")!, JSON.stringify({ lines: r.lines, cuts: target.cuts, dur: target.dur }, null, 1));
