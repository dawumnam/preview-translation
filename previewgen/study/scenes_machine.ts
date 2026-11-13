// Usage: bun --env-file=<.env> previewgen/study/scenes_machine.ts <id>:<preview.json> ... [--levels 2]
// The scene step on the finished lines of a run (the scene lines of the run are taken out first),
// against the "#" lines of the human preview.
import fs from "fs";
import { usageReport } from "../../src/llm";
import { clock } from "../../src/script";
import { loadGt, type PreviewLine } from "../gt";
import { addScenes } from "../scenes";
import { scoreScenes } from "../score";

const args = process.argv.slice(2);
const li = args.indexOf("--levels");
const levels = li >= 0 && args.splice(li, 2)[1] === "2" ? 2 : 1;
let ref = 0;
let gen = 0;
let hit = 0;
await Promise.all(
  args.map(async (a) => {
    const [id, file] = [a.slice(0, a.indexOf(":")), a.slice(a.indexOf(":") + 1)];
    const lines = (JSON.parse(fs.readFileSync(file, "utf-8")).lines as PreviewLine[]).filter((l) => l.kind !== "scene");
    const out = await addScenes(lines, "gemini-4-argon", levels);
    const gt = loadGt(`exp/previewgen/gt/${id}.hwpx`);
    const s = scoreScenes(out, gt);
    const wide = scoreScenes(out, gt, 90);
    ref += s.ref; gen += s.gen; hit += s.matched;
    console.log(`${id}: writer ${s.ref} scenes, output ${s.gen}, starts within 30 s ${s.matched}, within 90 s ${wide.matched}`);
    console.log(out.filter((l) => l.kind === "scene").map((l) => `   ${clock(l.tc ?? 0).padStart(7)} ${l.level === 2 ? "  - " : ""}${l.text}`).join("\n"));
    fs.writeFileSync(file.replace(/\.json$/, `_scenes${levels}.json`), JSON.stringify(out.filter((l) => l.kind === "scene"), null, 1));
  }),
);
console.log(`all: writer ${ref}, output ${gen}, starts within 30 s ${hit}`);
console.log(JSON.stringify(usageReport()));
