// CLI: video → preview document.
//
//   bun previewgen/run.ts <video> --template <earlier preview .hwp|.hwpx> [--id 1023] [--out <dir>]
//       [--about "<place and subject of the shoot>"] [--reference <human preview .hwpx>] [--fresh]
//
// Writes <out>/<id>_preview.hwpx and <out>/<id>_preview.txt. All other files
// go to <out>/<id>_preview_work/. Without --template only the text file is
// written. With --reference the result is scored against a human preview.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { mediaDuration } from "../src/audio";
import { usageReport } from "../src/llm";
import { applyStyle, HOUSE_STYLE, mergeWindows } from "./assemble";
import { applyCast, buildCastPrompt, castFromAnswer, castNotes, unifyCast, type CastAnswer } from "./cast";
import { DEFAULT_SETTINGS, watch, type GenFile, type GenSettings, type WindowOut } from "./gen";
import { loadGt } from "./gt";
import { addScenes, applyScenes, buildScenePrompt, type SceneAnswer } from "./scenes";
import { formatScore, score, scoreScenes } from "./score";
import { documentRows, writeHwpx, writeTxt } from "./write";

/** List prices in USD for 1M tokens, November 2026 (input, output). Argon doubles on 2026-12-01, Flash on 2027-01-01. */
const PRICE: Record<string, [number, number]> = {
  "gemini-4-argon": [2.0, 10.0],
  "gemini-3.8-flash": [0.75, 3.75],
};

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

function cost(): { usd: number; text: string } {
  let usd = 0;
  const parts: string[] = [];
  for (const [model, u] of Object.entries(usageReport())) {
    const p = PRICE[model];
    const c = p ? (u.input * p[0] + (u.output + u.thoughts) * p[1]) / 1e6 : NaN;
    if (p) usd += c;
    parts.push(`${model}: ${u.calls} calls, ${u.input} in, ${u.output + u.thoughts} out${p ? `, ${c.toFixed(2)} USD` : ""}`);
  }
  return { usd, text: parts.join("; ") };
}

async function main() {
  const media = process.argv[2];
  if (!media || media.startsWith("--")) {
    console.error('Usage: bun previewgen/run.ts <video> --template <earlier preview .hwp|.hwpx> [--id 1023] [--out <dir>] [--about "<text>"] [--reference <human preview .hwpx>] [--fresh]');
    process.exit(1);
  }
  const id = arg("id") ?? path.basename(media).match(/\d{4}/)?.[0] ?? path.basename(media).replace(/\.[^.]+$/, "");
  const outDir = arg("out") ?? path.dirname(media);
  const workDir = path.join(outDir, `${id}_preview_work`);
  fs.mkdirSync(workDir, { recursive: true });
  const settings: GenSettings = { ...DEFAULT_SETTINGS, about: arg("about", "")!, model: arg("model", DEFAULT_SETTINGS.model)!, tag: arg("tag", "")! };
  const textModel = arg("text-model", settings.model)!;
  const t0 = performance.now();
  const dur = await mediaDuration(media);

  // 1. Watch: every window to the model at the same time.
  const winPath = path.join(workDir, "windows.json");
  let have: WindowOut[] = [];
  if (!process.argv.includes("--fresh") && fs.existsSync(winPath)) {
    const old = JSON.parse(fs.readFileSync(winPath, "utf-8")) as GenFile;
    if (JSON.stringify(old.settings) === JSON.stringify(settings) && old.media === media) have = old.windows;
  }
  const { cuts, windows } = await watch(media, workDir, settings, 0, Infinity, have);
  fs.writeFileSync(winPath, JSON.stringify({ media, settings, cuts, windows, usage: usageReport() } satisfies GenFile, null, 1));
  const failed = windows.filter((w) => w.error);
  const tWatch = performance.now();
  if (failed.length > windows.length / 4) {
    console.error(`${failed.length} of ${windows.length} windows got no answer (${failed[0].error}). No document is written. Run the command again: finished windows are kept.`);
    process.exit(1);
  }

  // 2. One label for one person; 3. house style; 4. scenes.
  // --manual-text: the two text steps do not call the model. Each writes its
  // prompt to the work directory and reads the answer (JSON in the shape of
  // the schema) from a file there. Use it to try another text model.
  const manual = process.argv.includes("--manual-text");
  const answer = <T>(name: string, prompt: string): T | undefined => {
    const file = path.join(workDir, `${name}.answer.json`);
    if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
    fs.writeFileSync(path.join(workDir, `${name}.prompt.txt`), prompt);
    console.error(`--manual-text: wrote ${name}.prompt.txt to ${workDir}. Put the answer in ${name}.answer.json and run again.`);
    process.exit(2);
  };
  const notes = castNotes(windows);
  const cast = !manual ? await unifyCast(windows, textModel) : notes.length ? castFromAnswer(notes, answer<CastAnswer>("cast", buildCastPrompt(notes))) : { rename: new Map(), persons: [] };
  const named = applyCast(windows, cast);
  const styled = applyStyle(mergeWindows(named, cuts), HOUSE_STYLE);
  const lines = manual ? applyScenes(styled, answer<SceneAnswer>("scenes", buildScenePrompt(styled))) : await addScenes(styled, textModel);
  const tText = performance.now();

  // 5. Write.
  const rows = documentRows(id, lines, dur, HOUSE_STYLE);
  const base = path.join(outDir, `${id}_preview`);
  writeTxt(rows, `${base}.txt`);
  fs.writeFileSync(path.join(workDir, "preview.json"), JSON.stringify({ media, duration: dur, persons: cast.persons, lines }, null, 1));
  let template = arg("template");
  if (template) {
    if (template.endsWith(".hwp")) {
      const converted = path.join(workDir, "template.hwpx");
      execFileSync(path.join(import.meta.dir, "../tools/hwp2hwpx/convert.sh"), [template, converted], { stdio: ["ignore", "ignore", "inherit"] });
      template = converted;
    }
    writeHwpx(rows, template, `${base}.hwpx`);
    execFileSync("unzip", ["-tq", `${base}.hwpx`], { stdio: ["ignore", "ignore", "inherit"] });
  }

  const count = (k: string) => lines.filter((l) => l.kind === k).length;
  const c = cost();
  console.log(`\n${id}: ${(dur / 60).toFixed(0)} min of video → ${count("scene")} scenes, ${count("shot")} shot lines, ${count("speech")} Korean lines, ${count("foreign")} foreign-language turns`);
  console.log(`time: ${((performance.now() - t0) / 1000).toFixed(0)} s (watch ${((tWatch - t0) / 1000).toFixed(0)} s, names and scenes ${((tText - tWatch) / 1000).toFixed(0)} s)`);
  console.log(`cost: ${c.usd.toFixed(2)} USD at the November 2026 list price (${c.text})`);
  if (cast.persons.length) console.log(`locals: ${cast.persons.map((p) => `${p.label} (${p.look}, ${p.turns} turns)`).join("; ")}`);
  if (failed.length) console.log(`NOTE: ${failed.length} windows got no answer and are empty in the document: ${failed.map((w) => `${Math.round(w.start)}-${Math.round(w.end)} s`).join(", ")}. Run the command again.`);
  console.log(`written: ${base}.txt${template ? `, ${base}.hwpx` : ""}`);

  const reference = arg("reference");
  if (reference) {
    const gt = loadGt(reference);
    const s = score(lines.filter((l) => l.kind !== "scene"), gt, [[0, dur + 1]], false, cuts);
    const sc = scoreScenes(lines, gt);
    console.log(`\nagainst ${reference}:\n${formatScore(s)}`);
    console.log(`Scenes        reference ${sc.ref}, generated ${sc.gen}, start within 30 s of a reference scene ${sc.matched}`);
    fs.writeFileSync(path.join(workDir, "score.json"), JSON.stringify(s, null, 1));
  }
}

await main();
