// CLI: change one line after review, then apply, verify and deliver again.
//
//   bun src/fix.ts <work-dir> <marker> "<new Korean text>" [--confidence high|medium|low]
//
// The line's confidence becomes "high" (no " ??") unless --confidence says otherwise.
import { execFileSync } from "child_process";
import fs from "fs";
import path from "path";
import { extractHwpx, repackHwpx } from "./hwpx";
import { replaceMarkers, type Translation } from "./replace";

const args = process.argv.slice(2);
const confAt = args.indexOf("--confidence");
const confidence = (confAt >= 0 ? args[confAt + 1] : "high") as Translation["confidence"];
const [workDir, markerArg, text] = args.filter((a, i) => !a.startsWith("--") && (confAt < 0 || i !== confAt + 1));
const marker = Number(markerArg);
if (!workDir || !Number.isInteger(marker) || !text?.trim() || !["high", "medium", "low"].includes(confidence)) {
  console.error('Usage: bun src/fix.ts <work-dir> <marker> "<new Korean text>" [--confidence high|medium|low]');
  process.exit(1);
}
const ep: { hwpx: string; output: string } = JSON.parse(fs.readFileSync(path.join(workDir, "episode.json"), "utf-8"));
const jsonPath = path.join(workDir, "translations.json");
const translations: Translation[] = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
const t = translations.find((x) => x.markerIndex === marker);
if (!t) {
  console.error(`No marker ${marker} in ${jsonPath} (markers are 0 to ${translations.length - 1}).`);
  process.exit(1);
}
console.log(`#${marker} ${t.charName}\n  was (${t.confidence}): ${t.translation}\n  now (${confidence}): ${text.trim()}`);
t.translation = text.trim();
t.confidence = confidence;
fs.writeFileSync(jsonPath, JSON.stringify(translations, null, 1));

const hwpx = extractHwpx(ep.hwpx);
const outPath = repackHwpx(hwpx, replaceMarkers(hwpx.xml, translations, hwpx.boldIds));
try {
  const out = execFileSync("bun", [path.join(import.meta.dir, "verify.ts"), ep.hwpx], { cwd: path.resolve(import.meta.dir, "..") });
  console.log(out.toString().trim());
} catch (e: any) {
  console.error(`${e.stdout ?? ""}${e.stderr ?? ""}`);
  console.error("verify.ts found problems. The delivered file was not replaced.");
  process.exit(1);
}
fs.copyFileSync(outPath, ep.output);
console.log(`Wrote ${ep.output}`);
