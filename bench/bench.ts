// Benchmark for the translation pipeline, built from earlier episodes.
//
// There is no human reference translation. But the scripts themselves state
// the content of many foreign-language lines in Korean:
//   A  "<local> @@(조)" directly followed by "코 <Korean interpretation>"
//   B  "<피|큐> <Korean question>" directly followed by "코 @@(조)"
// That Korean line is the answer key ("gist"). For a test run the pipeline
// gets the script with those lines hidden, so it cannot copy them, and a text
// model then grades each translation against its gist (2 same content,
// 1 same topic, 0 unrelated). The score moves when hearing or turn placement
// gets better or worse.
//
//   bun bench/bench.ts build                      → bench/work/bench.json
//   bun bench/bench.ts run <name> [id,id,...]     run the pipeline (answer keys hidden), then score
//   bun bench/bench.ts score <name>               score again (3 judge votes for each line)
//   bun bench/bench.ts delivered                  score the translations.json listed as "delivered"
//   bun bench/bench.ts compare <a> <b>            same / detail / different on every line of two runs
//
// bench/episodes.json lists the episodes (see episodes.example.json).
import fs from "fs";
import path from "path";
import { extractHwpx } from "../src/hwpx";
import { callJson, usageReport } from "../src/llm";
import { runEpisode } from "../src/pipeline";
import { parseScript, type ScriptLine } from "../src/script";

const DIR = import.meta.dir;
const WORK = path.join(DIR, "work");
const JUDGE = process.env.JUDGE_MODEL || "gemini-3.8-flash";
fs.mkdirSync(WORK, { recursive: true });

interface Episode {
  id: string;
  /** .hwpx script (already converted). */
  script: string;
  media: string;
  /** translations.json of an earlier delivery, for `delivered` and `compare`. */
  delivered?: string;
}
interface Item {
  id: string; // "<episode>:<marker>"
  ep: string;
  marker: number;
  type: "A" | "B";
  speaker: string;
  gold: string;
  /** Script line that holds the answer key. */
  keyLine: number;
}
type Results = Record<string, { ko: string; confidence?: string; start?: number; end?: number }>;

const episodes = (): Episode[] => {
  const f = path.join(DIR, "episodes.json");
  if (!fs.existsSync(f)) {
    console.error(`Missing ${f}. Copy episodes.example.json and set the paths.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(f, "utf-8"));
};
const readJson = <T>(f: string): T => JSON.parse(fs.readFileSync(f, "utf-8"));
const benchFile = path.join(WORK, "bench.json");
const resultsFile = (name: string) => path.join(WORK, `${name}.results.json`);

function keyLines(lines: ScriptLine[]): Omit<Item, "id" | "ep">[] {
  const korean = (l?: ScriptLine) =>
    !!l && l.kind === "dialogue" && /[가-힣]{2,}/.test(l.text) && l.text.replace(/[?？\s]/g, "").length >= 6;
  const out: Omit<Item, "id" | "ep">[] = [];
  for (const l of lines) {
    if (l.kind !== "marker") continue;
    const next = lines[l.no + 1];
    const prev = lines[l.no - 1];
    if (l.speaker !== "코" && korean(next) && next.speaker === "코" && next.tc === undefined)
      out.push({ marker: l.marker!.index, type: "A", speaker: l.speaker ?? "", gold: next.text, keyLine: next.no });
    else if (l.speaker === "코" && korean(prev) && /^(피|큐)$/.test(prev.speaker ?? ""))
      out.push({ marker: l.marker!.index, type: "B", speaker: "코", gold: prev.text, keyLine: prev.no });
  }
  return out;
}

function build() {
  const items: Item[] = [];
  for (const e of episodes()) {
    const hw = extractHwpx(e.script);
    const found = keyLines(parseScript(hw.xml, hw.boldIds).lines);
    for (const k of found) items.push({ id: `${e.id}:${k.marker}`, ep: e.id, ...k });
    console.log(`${e.id}: ${found.length} lines with an answer key (A ${found.filter((k) => k.type === "A").length}, B ${found.filter((k) => k.type === "B").length})`);
  }
  fs.writeFileSync(benchFile, JSON.stringify(items, null, 1));
  console.log(`${items.length} items → ${benchFile}`);
}

const SCORE_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { id: { type: "STRING" }, why: { type: "STRING" }, score: { type: "INTEGER" } },
    required: ["id", "why", "score"],
    propertyOrdering: ["id", "why", "score"],
  },
};

async function judgeOnce(items: { id: string; type: string; gold: string; ko: string }[], seed: number): Promise<Map<string, number>> {
  // A different order for each vote, so a line is never graded next to the same neighbours twice.
  const order = items.map((it, i) => ({ it, k: Math.sin((i + 1) * (seed + 1) * 12.9898) })).sort((a, b) => a.k - b.k).map((x) => x.it);
  const scores = new Map<string, number>();
  const batches: (typeof items)[] = [];
  for (let i = 0; i < order.length; i += 20) batches.push(order.slice(i, i + 20));
  await Promise.all(
    batches.map(async (batch) => {
      const prompt = `You grade a system that listens to raw footage of a Korean travel programme and translates foreign-language lines into Korean.
For each item:
- GIST is a Korean line from the production script, written by a person who was there. For type A it is the on-site interpreter's Korean summary of what a local just said. For type B it is the Korean question that the interpreter then passed on in the local language.
- OUT is the system's Korean translation of that one line.

Score:
2 = OUT carries the same main content as GIST. The interpreter summarises, so OUT may have more detail or other wording.
1 = same topic, but the key content differs, or OUT has only a fragment of it.
0 = unrelated, contradictory, or empty.
Judge meaning only, not style. Give a very short reason.

${batch.map((it) => `### id=${it.id} type=${it.type}\nGIST: ${it.gold}\nOUT: ${it.ko || "(empty)"}`).join("\n\n")}`;
      const r = await callJson<{ id: string; score: number }[]>({
        model: JUDGE, parts: [{ text: prompt }], schema: SCORE_SCHEMA, thinkingLevel: "LOW", temperature: 0, attempts: 4, label: "judge",
      });
      for (const s of r.value ?? []) scores.set(s.id, s.score);
    }),
  );
  return scores;
}

async function score(name: string, results: Results) {
  const bench = readJson<Item[]>(benchFile).filter((b) => results[b.id]);
  const items = bench.map((b) => ({ id: b.id, type: b.type, gold: b.gold, ko: results[b.id].ko ?? "" }));
  // One judge call is noisy (the same text can get 1 or 2). Three votes, middle value.
  const votes = await Promise.all([0, 1, 2].map((s) => judgeOnce(items, s)));
  const final = new Map<string, number>();
  for (const it of items) {
    const v = votes.map((m) => m.get(it.id) ?? 0).sort((a, b) => a - b);
    final.set(it.id, v[1]);
  }
  fs.writeFileSync(path.join(WORK, `${name}.scores.json`), JSON.stringify(Object.fromEntries(final), null, 1));
  const of = (t?: string) => bench.filter((b) => !t || b.type === t).map((b) => final.get(b.id)!);
  const mean = (xs: number[]) => (xs.length ? (xs.reduce((a, b) => a + b, 0) / (2 * xs.length)).toFixed(3) : "-");
  const all = of();
  console.log(
    `${name}: n=${all.length} full=${all.filter((x) => x === 2).length} partial=${all.filter((x) => x === 1).length} zero=${all.filter((x) => x === 0).length} score=${mean(all)} (A ${mean(of("A"))}, B ${mean(of("B"))})`,
  );
  const byConf = new Map<string, number[]>();
  for (const b of bench) {
    const c = results[b.id].confidence ?? "-";
    byConf.set(c, [...(byConf.get(c) ?? []), final.get(b.id)!]);
  }
  if (byConf.size > 1 || !byConf.has("-"))
    console.log(`  by confidence: ${[...byConf].map(([c, xs]) => `${c} n=${xs.length} full=${Math.round((100 * xs.filter((x) => x === 2).length) / xs.length)}%`).join(", ")}`);
}

async function run(name: string, only?: string[]) {
  const bench = readJson<Item[]>(benchFile);
  const eps = episodes().filter((e) => !only || only.includes(e.id));
  const t0 = performance.now();
  const results: Results = fs.existsSync(resultsFile(name)) ? readJson<Results>(resultsFile(name)) : {};
  const reports = await Promise.all(
    eps.map(async (e) => {
      const dir = path.join(WORK, name, e.id);
      fs.mkdirSync(dir, { recursive: true });
      const script = path.join(dir, `${e.id}.hwpx`);
      fs.copyFileSync(e.script, script);
      const hide = new Set(bench.filter((b) => b.ep === e.id).map((b) => b.keyLine));
      return runEpisode({ script, media: e.media, fresh: true, mask: () => hide });
    }),
  );
  for (const r of reports) {
    for (const t of readJson<any[]>(path.join(r.workDir, "translations.json")))
      results[`${r.id}:${t.markerIndex}`] = { ko: t.translation, confidence: t.confidence, start: t.speech_start, end: t.speech_end };
    const s = r.seconds;
    console.log(
      `${r.id}: ${r.markers} lines in ${s.total} s (decode ${s.decode}, brief ${s.brief}, listen ${s.listen}, compare ${s.compare}, third ${s.focused ?? 0}); high/medium/low ${r.confidence.high}/${r.confidence.medium}/${r.confidence.low}; billable ${r.billableSec} s; verify ${r.verify}`,
    );
  }
  fs.writeFileSync(resultsFile(name), JSON.stringify(results, null, 1));
  console.log(`wall ${((performance.now() - t0) / 1000).toFixed(0)} s; ${JSON.stringify(usageReport())}`);
  await score(name, results);
}

function deliveredResults(): Results {
  const out: Results = {};
  for (const e of episodes()) {
    if (!e.delivered) continue;
    for (const t of readJson<any[]>(e.delivered))
      out[`${e.id}:${t.markerIndex}`] = { ko: t.translation, confidence: t.confidence, start: t.speech_start, end: t.speech_end };
  }
  return out;
}
const load = (name: string): Results => (name === "delivered" ? deliveredResults() : readJson<Results>(resultsFile(name)));

const VERDICT_SCHEMA = {
  type: "ARRAY",
  items: {
    type: "OBJECT",
    properties: { id: { type: "STRING" }, verdict: { type: "STRING", enum: ["same", "detail", "different"] } },
    required: ["id", "verdict"],
  },
};

async function compare(a: string, b: string) {
  const A = load(a);
  const B = load(b);
  const ids = Object.keys(A).filter((id) => B[id]);
  const verdicts = new Map<string, string>();
  const batches: string[][] = [];
  for (let i = 0; i < ids.length; i += 30) batches.push(ids.slice(i, i + 30));
  await Promise.all(
    batches.map(async (batch) => {
      const prompt = `Two systems each translated the same spoken foreign-language line of a TV programme into Korean. For each pair decide:
- "same": both say the same thing (wording, politeness level, spelling of names and filler words may differ).
- "detail": the same core message, but one has an extra sentence or detail the other lacks, or a small factual detail differs.
- "different": the messages differ in substance, or one is empty and the other is not.

${batch.map((id) => `### ${id}\nA: ${A[id].ko || "(empty)"}\nB: ${B[id].ko || "(empty)"}`).join("\n\n")}`;
      const r = await callJson<{ id: string; verdict: string }[]>({
        model: JUDGE, parts: [{ text: prompt }], schema: VERDICT_SCHEMA, thinkingLevel: "LOW", temperature: 0, attempts: 4, label: "compare",
      });
      for (const v of r.value ?? []) verdicts.set(v.id, v.verdict);
    }),
  );
  const n = (v: string) => ids.filter((id) => verdicts.get(id) === v).length;
  const pct = (x: number) => `${((100 * x) / ids.length).toFixed(1)}%`;
  console.log(`${a} vs ${b}: n=${ids.length} same=${n("same")} (${pct(n("same"))}) detail=${n("detail")} (${pct(n("detail"))}) different=${n("different")} (${pct(n("different"))})`);
  fs.writeFileSync(path.join(WORK, `compare_${a}_${b}.json`), JSON.stringify(Object.fromEntries(verdicts), null, 1));
}

const [cmd, x, y] = process.argv.slice(2);
if (cmd === "build") build();
else if (cmd === "run" && x) await run(x, y?.split(","));
else if (cmd === "score" && x) await score(x, load(x));
else if (cmd === "delivered") await score("delivered", deliveredResults());
else if (cmd === "compare" && x && y) await compare(x, y);
else {
  console.error("Usage: bun bench/bench.ts build | run <name> [ids] | score <name> | delivered | compare <a> <b>");
  process.exit(1);
}
