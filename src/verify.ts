// CLI: verify a translated HWPX against its source and translations.json.
//
//   bun src/verify.ts <hwpx> [translated.hwpx] [translations.json] [--select "<words>"]
//
// Defaults: <name>_translated.hwpx and translations.json next to <hwpx>.
// --select says which text style marks the requested @@ lines. Default: the
// rule that run.ts saved in episode.json next to <hwpx>, else "bold".
// Exits non-zero on any problem.
import fs from "fs";
import path from "path";
import AdmZip from "adm-zip";
import { extractHwpx } from "./hwpx";
import { parseMarkers } from "./parser";
import { translationText, type Translation } from "./replace";
import { ruleText, selectFor, takeSelectArg } from "./select";

const argv = process.argv.slice(2);
const selectArg = takeSelectArg(argv);
const srcPath = argv[0];
if (!srcPath) {
  console.error('Usage: bun src/verify.ts <hwpx> [translated.hwpx] [translations.json] [--select "<words>"]');
  process.exit(1);
}
const ext = path.extname(srcPath);
const outPath = argv[1] ?? `${srcPath.slice(0, -ext.length)}_translated${ext}`;
const jsonPath = argv[2] ?? path.join(path.dirname(srcPath), "translations.json");

const problems: string[] = [];
const MAX_LISTED = 20;
const problem = (msg: string) => problems.push(msg);

// --- 1. Zip integrity: adm-zip must read it back, and unzip must agree.
const src = extractHwpx(srcPath, selectFor(srcPath, selectArg));
let outXml: string;
try {
  outXml = extractHwpx(outPath).xml;
} catch (e) {
  problem(`output zip not readable by adm-zip: ${e}`);
  outXml = Bun.spawnSync(["unzip", "-p", outPath, "Contents/section0.xml"]).stdout.toString();
}
const unzipTest = Bun.spawnSync(["unzip", "-tq", outPath]);
if (unzipTest.exitCode !== 0) problem(`unzip -t failed: ${unzipTest.stdout}${unzipTest.stderr}`);

// --- 2. Every Contents/*.xml is well-formed (xmllint ships with macOS).
if (Bun.which("xmllint")) {
  const zip = new AdmZip(fs.readFileSync(outPath));
  for (const entry of zip.getEntries()) {
    if (!entry.entryName.endsWith(".xml")) continue;
    let data: Buffer;
    try {
      data = entry.getData();
    } catch {
      continue; // already reported in step 1
    }
    const lint = Bun.spawnSync(["xmllint", "--noout", "-"], { stdin: data });
    if (lint.exitCode !== 0) problem(`${entry.entryName}: not well-formed XML\n    ${lint.stderr.toString().split("\n")[0]}`);
  }
} else {
  console.warn("Warning: xmllint not found — XML well-formedness not checked");
}

// --- 3. Every requested marker has a matching translation entry.
const translations: Translation[] = JSON.parse(fs.readFileSync(jsonPath, "utf-8"));
const byIndex = new Map(translations.map((t) => [t.markerIndex, t]));
const srcMarkers = parseMarkers(src.xml, src.selectedIds).markers;
for (const m of srcMarkers) {
  const t = byIndex.get(m.index);
  if (!t) problem(`marker ${m.index} (${m.charName} ${m.rawText}) has no translation`);
  else if (t.language !== m.language || t.charName !== m.charName)
    problem(`marker ${m.index}: translation is ${t.language}/${t.charName}, script has ${m.language}/${m.charName}`);
}
if (translations.length !== srcMarkers.length)
  problem(`${translations.length} translations for ${srcMarkers.length} requested markers`);

// --- 4. The requested @@ lines of the output match the source markers one to one, in order:
// right text (with " ??" for low confidence), speaker, language, and the
// script's own TC unchanged. No TC line is added.
const decode = (s: string) =>
  s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
const outMarkers = parseMarkers(outXml, src.selectedIds).markers;
if (outMarkers.length !== srcMarkers.length)
  problem(`output has ${outMarkers.length} requested @@ lines, source has ${srcMarkers.length} — TC lines were added or lost`);
for (let i = 0; i < Math.min(outMarkers.length, srcMarkers.length); i++) {
  const o = outMarkers[i];
  const m = srcMarkers[i];
  const t = byIndex.get(m.index);
  const where = `marker ${m.index}`;
  const head = (raw: string) => raw.slice(0, raw.indexOf("@@"));
  if (o.timestamp !== m.timestamp) problem(`${where}: TC ${o.timestamp}s, script has ${m.timestamp}s`);
  if (head(o.rawText) !== head(m.rawText))
    problem(`${where}: line start before @@ changed\n    got: ${head(o.rawText)}\n    exp: ${head(m.rawText)}`);
  if (o.language !== m.language) problem(`${where}: language ${o.language}, expected ${m.language}`);
  if (o.charName !== m.charName) problem(`${where}: speaker ${o.charName}, expected ${m.charName}`);
  if (!t) continue;
  const exp = translationText(t) + (t.confidence === "low" ? " ??" : "");
  const got = decode(o.rawText.replace(/^.*?@@(\([^)]+\))?\s*/, ""));
  if (got !== exp) problem(`${where}: text differs\n    got: ${got.slice(0, 60)}\n    exp: ${exp.slice(0, 60)}`);
  if (/&(amp|lt|gt|quot);/.test(got)) problem(`${where}: double-escaped text "${got.slice(0, 40)}"`);
  if (/\s\/\s/.test(got)) problem(`${where}: " / " join in text`);
}

// --- 5. @@ runs that are not requested are untouched (line-layout cache aside, which
// replace.ts strips everywhere).
const stripLayout = (s: string) => s.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
const nonBold = (xml: string) =>
  [...xml.matchAll(/<hp:run\s+charPrIDRef="(\d+)">(.*?)<\/hp:run>/gs)]
    .filter(([, id, content]) => content.includes("@@") && !src.selectedIds.has(id))
    .map(([, , content]) => stripLayout(content));
const nbSrc = nonBold(src.xml);
const nbOut = nonBold(outXml);
if (nbSrc.length !== nbOut.length) problem(`@@ runs that are not requested: ${nbSrc.length} in source, ${nbOut.length} in output`);
else nbSrc.forEach((r, i) => r !== nbOut[i] && problem(`@@ run ${i} that is not requested changed`));

// --- 6. All other text is unchanged.
const plainText = (xml: string) =>
  [...xml.matchAll(/<hp:t>(.*?)<\/hp:t>/gs)].map((m) => m[1]).filter((t) => !t.includes("@@")).join("\n");
if (plainText(src.xml) !== plainText(outXml)) problem("non-marker text differs between source and output");

// --- Report
const conf = { high: 0, medium: 0, low: 0 } as Record<string, number>;
for (const t of translations) conf[t.confidence] = (conf[t.confidence] ?? 0) + 1;
console.log(`${path.basename(outPath)}`);
console.log(`  requested markers ${srcMarkers.length} (selection "${ruleText(src.rule)}"), translated ${translations.length}, output lines ${outMarkers.length} (must equal requested markers)`);
console.log(`  other @@ lines untouched: ${nbSrc.length}`);
console.log(`  confidence high/medium/low: ${conf.high}/${conf.medium}/${conf.low} (low ones marked ??)`);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems.slice(0, MAX_LISTED)) console.error(`  ${p}`);
  if (problems.length > MAX_LISTED) console.error(`  ... and ${problems.length - MAX_LISTED} more`);
  process.exit(1);
}
console.log("  OK");
