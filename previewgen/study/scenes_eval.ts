// Usage: bun --env-file=<.env> previewgen/study/scenes_eval.ts <variant> [ids...]
// The scene step alone: the body lines of a human preview go in (no "#" lines), scenes come out,
// and the starts are compared with the "#" lines of the human writer.
import fs from "fs";
import { callJson, usageReport } from "../../src/llm";
import { clock } from "../../src/script";
import { loadGt, type GtLine } from "../gt";
import { buildScenePromptV, SCENE_SCHEMA_V, type Variant } from "./scene_prompts";

const ROOT = "exp/previewgen";
const ALL = ["1022", "1023", "1024", "1025", "1028", "1029", "1103", "1104", "1105"];
const variant = (process.argv[2] ?? "base") as Variant;
const ids = process.argv.slice(3).length ? process.argv.slice(3) : ALL;
const model = process.env.SCENE_MODEL ?? "gemini-4-argon";

export interface Body {
  lines: GtLine[];
  /** Index in `lines` of the first line of each human scene, and its title. */
  scenes: { at: number; title: string }[];
}

function body(id: string): Body {
  const gt = loadGt(`${ROOT}/gt/${id}.hwpx`);
  const lines: GtLine[] = [];
  const scenes: { at: number; title: string }[] = [];
  for (const l of gt) {
    if (l.kind === "scene") scenes.push({ at: lines.length, title: l.text });
    else if (l.kind !== "note") lines.push(l);
  }
  return { lines, scenes: scenes.filter((s) => s.at < lines.length) };
}

const bodies = new Map(ALL.map((id) => [id, body(id)]));
const outDir = `${ROOT}/scenes/${variant}`;
fs.mkdirSync(outDir, { recursive: true });

let tot = { ref: 0, gen: 0, hit: 0, hitLoose: 0 };
await Promise.all(
  ids.map(async (id) => {
    const b = bodies.get(id)!;
    const file = `${outDir}/${id}.json`;
    let ans: { scenes: { first_line: number; title: string; level?: number }[] } | undefined;
    if (fs.existsSync(file)) ans = JSON.parse(fs.readFileSync(file, "utf-8"));
    else {
      // Examples: two other episodes, never the one under test.
      const others = ALL.filter((x) => x !== id);
      const prompt = buildScenePromptV(variant, b.lines, others.map((x) => bodies.get(x)!), id);
      const r = await callJson<typeof ans>({ model, parts: [{ text: prompt }], schema: SCENE_SCHEMA_V, thinkingLevel: "MEDIUM", timeoutMs: 240_000, hedgeAfterMs: [90_000], label: `scenes ${id}` });
      if (!r.value) {
        console.log(`${id}: no answer (${r.error ?? r.blocked})`);
        return;
      }
      ans = r.value;
      fs.writeFileSync(file, JSON.stringify(ans, null, 1));
    }
    const timeOf = (k: number) => b.lines[Math.min(b.lines.length - 1, Math.max(0, k))].tc ?? b.lines[Math.min(b.lines.length - 1, Math.max(0, k))].tcPrev;
    // LEVEL=1 in the environment: only the parts of level 1 count as scenes.
    const maxLevel = parseInt(process.env.LEVEL ?? "9", 10);
    const gen = ans!.scenes
      .filter((s) => (s.level ?? 1) <= maxLevel)
      .map((s) => ({ at: Math.round(s.first_line) - 1, title: `${s.level === 2 ? "  · " : ""}${s.title}` }))
      .filter((s) => s.at >= 0 && s.at < b.lines.length);
    // A human scene start is found when a generated scene starts within 2 lines or 30 s of it.
    const used = new Set<number>();
    const rows: string[] = [];
    let hit = 0;
    let loose = 0;
    for (const h of b.scenes) {
      const ht = timeOf(h.at);
      let best = -1;
      gen.forEach((g, j) => {
        if (used.has(j)) return;
        const near = Math.abs(g.at - h.at) <= 2 || Math.abs(timeOf(g.at) - ht) <= 30;
        if (near && (best < 0 || Math.abs(g.at - h.at) < Math.abs(gen[best].at - h.at))) best = j;
      });
      if (best >= 0) {
        used.add(best);
        hit++;
      } else if (gen.some((g) => Math.abs(timeOf(g.at) - ht) <= 90)) loose++;
      rows.push(`  ${clock(ht).padStart(7)} ${h.title.padEnd(28)} | ${best >= 0 ? `${clock(timeOf(gen[best].at))} ${gen[best].title}` : "-"}`);
    }
    gen.forEach((g, j) => !used.has(j) && rows.push(`  ${" ".repeat(36)} | ${clock(timeOf(g.at))} ${g.title}   (extra)`));
    console.log(`${id}: human ${b.scenes.length}, generated ${gen.length}, starts found ${hit} (+${loose} within 90 s)\n${rows.join("\n")}`);
    tot.ref += b.scenes.length;
    tot.gen += gen.length;
    tot.hit += hit;
    tot.hitLoose += loose;
  }),
);
console.log(`\n${variant} / ${model}: human scenes ${tot.ref}, generated ${tot.gen}, starts found ${tot.hit} (${((100 * tot.hit) / tot.ref).toFixed(0)}% of human, ${((100 * tot.hit) / Math.max(1, tot.gen)).toFixed(0)}% of generated); +${tot.hitLoose} within 90 s`);
console.log(JSON.stringify(usageReport()));
