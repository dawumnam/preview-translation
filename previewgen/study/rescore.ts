// Usage: bun previewgen/study/rescore.ts <work-dir> <reference.hwpx> [--list]
// Scores the preview.json of a finished run again (no model call).
import fs from "fs";
import path from "path";
import { loadGt } from "../gt";
import { formatScore, score, scoreScenes } from "../score";

const [workDir, ref] = process.argv.slice(2);
const p = JSON.parse(fs.readFileSync(path.join(workDir, "preview.json"), "utf-8"));
const cuts = JSON.parse(fs.readFileSync(path.join(workDir, "windows.json"), "utf-8")).cuts as number[];
const gt = loadGt(ref);
const s = score(p.lines.filter((l: any) => l.kind !== "scene"), gt, [[0, p.duration + 1]], process.argv.includes("--list"), cuts);
console.log(formatScore(s));
const sc = scoreScenes(p.lines, gt);
console.log(`Scenes        reference ${sc.ref}, generated ${sc.gen}, start within 30 s of a reference scene ${sc.matched}`);
