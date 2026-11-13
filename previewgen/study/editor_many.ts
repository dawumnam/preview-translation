// Usage: bun --env-file=<.env> previewgen/study/editor_many.ts <id>:<windows.json>+<shots.json> ... [--only one|many] [--save <dir>]
// Does the editor step get better with examples from more previews? The machine log of a full episode
// (main pass and picture-only pass, all lines) is edited two times: with example pairs from one episode
// (1023), and with pairs from seven episodes (the test stretches of dev_eval.ts). No pair is from the
// episode under test.
import fs from "fs";
import { usageReport } from "../../src/llm";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows, placeTc, RHYTHM } from "../assemble";
import { editLines, type EditExample } from "../editor";
import type { GenFile } from "../gen";
import { loadGt, type PreviewLine } from "../gt";
import { score } from "../score";
import { DEV } from "./dev_eval";

const args = process.argv.slice(2);
const flag = (n: string) => (args.indexOf(`--${n}`) >= 0 ? args[args.indexOf(`--${n}`) + 1] : undefined);
const only = flag("only");
const saveDir = flag("save");

function machine(main: string, extra: string | undefined): { lines: PreviewLine[]; cuts: number[]; dur: number } {
  const gen = JSON.parse(fs.readFileSync(main, "utf-8")) as GenFile;
  let merged = mergeWindows(gen.windows, gen.cuts);
  if (extra && fs.existsSync(extra)) merged = joinShots(merged, mergeWindows((JSON.parse(fs.readFileSync(extra, "utf-8")) as GenFile).windows, gen.cuts), gen.cuts);
  return { lines: applyStyle(merged, HOUSE_STYLE), cuts: gen.cuts, dur: Math.max(...gen.windows.map((w) => w.end)) };
}

const TITLES: Record<string, string[]> = {
  "1023": ["scenery shots; the host walks into a house and speaks to the camera, several takes; he meets a local woman", "the host meets an old man; they walk through his house and talk through the interpreter"],
  "1104": ["street scenery; the host goes into a restaurant and orders; a kitchen where bread is made"],
  "1105": ["goodbye at a house; scenery shots; the host arrives at a guest house and gets a room"],
  "1025": ["the host and an old man gather walnuts and talk"],
  "1028": ["a meal at a table with several people; talk through the interpreter"],
  "1029": ["women pick flowers in a garden and arrange them"],
  "1024": ["the host walks up through a cave town and speaks to the camera"],
};
function examplesOf(ids: string[]): EditExample[] {
  const out: EditExample[] = [];
  for (const id of ids) {
    const m = machine(`exp/previewgen/p5/${id}_v6.json`, `exp/previewgen/p5/${id}_pic.json`);
    const gt = loadGt(`exp/previewgen/gt/${id}.hwpx`).filter((l) => l.kind !== "scene" && l.kind !== "note");
    DEV[id].forEach(([a, b], k) => out.push({ title: TITLES[id][k], machine: m.lines.filter((l) => l.tc! >= a && l.tc! < b), human: gt.filter((l) => l.tcPrev >= a && l.tcPrev < b) }));
  }
  return out;
}
const sets: [string, EditExample[]][] = [
  ["one", examplesOf(["1023"])],
  ["many", examplesOf(["1023", "1104", "1105", "1025", "1028", "1029", "1024"])],
];
const pc = (a: number, b: number) => `${b ? Math.round((100 * a) / b) : 0}%`;
const show = (name: string, lines: PreviewLine[], id: string, cuts: number[], dur: number) => {
  const s = score(lines, loadGt(`exp/previewgen/gt/${id}.hwpx`), [[0, dur + 1]], false, cuts);
  const r = s.shot.matched / s.shot.ref;
  const q = s.shot.matched / Math.max(1, s.shot.gen);
  console.log(`  ${id} ${name.padEnd(46)} ${String(s.shot.gen).padStart(3)} shot lines for ${s.shot.ref} (${(s.shot.gen / s.shot.ref).toFixed(2)} times) | found ${pc(s.shot.matched, s.shot.ref)} (cut ${pc(s.shotAt.cutFound, s.shotAt.cutRef)}, inside ${pc(s.shotAt.insideFound, s.shotAt.insideRef)}) | right place ${pc(s.shot.matched, s.shot.gen)} | balance ${Math.round((200 * r * q) / (r + q))}% | TC lines found ${pc(s.tc.within5, s.tc.ref)}, right place ${pc(s.tc.genNearRef5, s.tc.gen)} (${s.tc.gen} for ${s.tc.ref})`);
};

await Promise.all(
  args
    .filter((a) => /^\d{4}:/.test(a))
    .map(async (a) => {
      const id = a.slice(0, 4);
      const [main, extra] = a.slice(5).split("+");
      const alone = machine(main, undefined);
      const all = machine(main, extra);
      const results: [string, PreviewLine[]][] = [
        ["main pass alone, clock", placeTc(alone.lines, RHYTHM)],
        ["both passes, all lines, clock", placeTc(all.lines, RHYTHM)],
      ];
      await Promise.all(
        sets
          .filter(([name]) => !only || only === name)
          .map(async ([name, ex]) => {
            const r = await editLines(all.lines, ex, "gemini-4-argon", (c) => placeTc(c, RHYTHM), 420, "LOW");
            results.push([`editor, pairs from ${name === "one" ? "one episode (25 min)" : "seven episodes (85 min)"}${r.failed ? `, ${r.failed} chunks with no answer` : ""}`, r.lines]);
            if (saveDir) fs.writeFileSync(`${saveDir}/${id}_editor_${name}.json`, JSON.stringify({ lines: r.lines, cuts: all.cuts, dur: all.dur }, null, 1));
          }),
      );
      for (const [name, lines] of results) show(name, lines, id, all.cuts, all.dur);
    }),
);
console.log(JSON.stringify(usageReport()));
