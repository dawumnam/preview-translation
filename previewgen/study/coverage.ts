// Usage: bun --env-file=<.env> previewgen/study/coverage.ts <id> <work dir>
// Content cover of the human shot lines: does the output have a shot line about the same picture
// within 20 s before to 15 s after the writer's TC? A text model judges each human line.
import fs from "fs";
import path from "path";
import { callJson, usageReport } from "../../src/llm";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows, placeTc } from "../assemble";
import type { GenFile } from "../gen";
import { loadGt, tcText, type PreviewLine } from "../gt";

const [id, dir] = process.argv.slice(2);
const gen = JSON.parse(fs.readFileSync(path.join(dir, "windows.json"), "utf-8")) as GenFile;
let merged = mergeWindows(gen.windows, gen.cuts);
const shotsFile = path.join(dir, "shots.json");
if (fs.existsSync(shotsFile)) merged = joinShots(merged, mergeWindows((JSON.parse(fs.readFileSync(shotsFile, "utf-8")) as GenFile).windows, gen.cuts), gen.cuts);
const all = applyStyle(merged, HOUSE_STYLE);
const variants: Record<string, PreviewLine[]> = { "all lines": all, "clock rule": placeTc(all) };
const dur = Math.max(...gen.windows.map((w) => w.end));
const human = loadGt(`exp/previewgen/gt/${id}.hwpx`).filter((l) => l.kind === "shot" && l.tc !== undefined && l.tc <= dur && l.text !== "영상종료");

const SCHEMA = {
  type: "OBJECT",
  properties: {
    items: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          n: { type: "INTEGER" },
          label: { type: "STRING", enum: ["same", "part", "none"] },
          line: { type: "STRING", description: "The letter of the machine line that fits best, or empty" },
        },
        required: ["n", "label", "line"],
        propertyOrdering: ["n", "label", "line"],
      },
    },
  },
  required: ["items"],
};

async function judge(name: string, lines: PreviewLine[]) {
  const shots = lines.filter((l) => l.kind === "shot");
  const items = human.map((h, i) => {
    const cand = shots.filter((s) => s.tc! >= h.tc! - 20 && s.tc! <= h.tc! + 15);
    return { n: i + 1, h, cand };
  });
  const labels = new Map<number, string>();
  for (const it of items) if (!it.cand.length) labels.set(it.n, "none");
  const todo = items.filter((it) => it.cand.length);
  const batches: (typeof todo)[] = [];
  for (let i = 0; i < todo.length; i += 30) batches.push(todo.slice(i, i + 30));
  await Promise.all(
    batches.map(async (b) => {
      const body = b
        .map((it) => `${it.n}. Human line at ${tcText(it.h.tc!)}: "${it.h.text}"\n${it.cand.map((c, k) => `   ${String.fromCharCode(97 + k)}) ${tcText(c.tc!)} "${c.text}"`).join("\n")}`)
        .join("\n");
      const prompt = `Two logs describe the picture of the same raw footage of a Korean TV travel documentary: a human 프리뷰어 wrote one, a machine wrote the other. Each line is a short Korean phrase about what the picture shows from that time (MMSS or HMMSS). 큐 is the host; labels such as 두여, 검남, 할 are locals; sk, cs, bs, fs, 2s, pan, tu, td, tr are codes for the kind of shot.

For each human line below, the machine lines of the same half minute are listed. Decide if the machine log has that picture:
- "same": one machine line is about the same picture: the same subject (person, thing or place) and the same action or state. Other words for the same thing count (가게 and 식당 for the place the host goes into; 반죽 닫는 and 반죽 접는). The shot code can differ.
- "part": a machine line is about the same subject or the same place, but another action, another moment or another part of it.
- "none": no machine line is about that subject.
Be strict: when in doubt between two labels, take the lower one. Give the letter of the machine line that fits best.

${body}`;
      const r = await callJson<{ items: { n: number; label: string; line: string }[] }>({ model: "gemini-4-argon", parts: [{ text: prompt }], schema: SCHEMA, thinkingLevel: "LOW", timeoutMs: 120_000, hedgeAfterMs: [40_000], label: `judge ${name}` });
      for (const x of r.value?.items ?? []) labels.set(x.n, x.label);
    }),
  );
  const count = (l: string) => items.filter((it) => labels.get(it.n) === l).length;
  const unknown = items.filter((it) => !labels.has(it.n)).length;
  const n = items.length - unknown;
  const pc = (x: number) => `${x} (${Math.round((100 * x) / n)}%)`;
  console.log(`${id} ${name}: ${shots.length} machine shot lines for ${items.length} human shot lines | same picture ${pc(count("same"))} | same subject, other moment ${pc(count("part"))} | not in the log ${pc(count("none"))}${unknown ? ` | no answer ${unknown}` : ""}`);
  return { labels, items };
}

for (const [name, lines] of Object.entries(variants)) {
  const { labels, items } = await judge(name, lines);
  if (name === "all lines") {
    const miss = items.filter((it) => labels.get(it.n) === "none").slice(0, 25);
    console.log(`   human lines that are not in the log: ${miss.map((it) => `${tcText(it.h.tc!)} ${it.h.text}`).join(" / ")}`);
  }
}
console.log(JSON.stringify(usageReport()));
