import fs from "fs";
import { extractHwpx, repackHwpx } from "./hwpx";
import { replaceMarkers, type Translation } from "./replace";
import { selectFor, takeSelectArg } from "./select";

const argv = process.argv.slice(2);
const selectArg = takeSelectArg(argv);
const [hwpxPath, jsonPath] = argv;

if (!hwpxPath || !jsonPath) {
  console.error('Usage: bun src/apply.ts <hwpx-file> <translations.json> [--select "<words>"]');
  process.exit(1);
}

const translations: Translation[] = JSON.parse(
  fs.readFileSync(jsonPath, "utf-8"),
);

const hwpx = extractHwpx(hwpxPath, selectFor(hwpxPath, selectArg));
const newXml = replaceMarkers(hwpx.xml, translations, hwpx.selectedIds);
const outPath = repackHwpx(hwpx, newXml);

console.log(outPath);
