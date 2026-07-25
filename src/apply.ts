import fs from "fs";
import { extractHwpx, repackHwpx } from "./hwpx";
import { replaceMarkers } from "./replace";
import type { Translation } from "./translate";

const args = process.argv.slice(2);
const replaceExisting = args.includes("--replace-existing");
const [hwpxPath, jsonPath] = args.filter((a) => !a.startsWith("--"));

if (!hwpxPath || !jsonPath) {
  console.error(
    "Usage: bun src/apply.ts <hwpx-file> <translations.json> [--replace-existing]",
  );
  process.exit(1);
}

const translations: Translation[] = JSON.parse(
  fs.readFileSync(jsonPath, "utf-8"),
);

const hwpx = extractHwpx(hwpxPath);
const newXml = replaceMarkers(hwpx.xml, translations, hwpx.markerStyleIds, {
  replaceExisting,
});
const outPath = repackHwpx(hwpx, newXml);

console.log(outPath);
