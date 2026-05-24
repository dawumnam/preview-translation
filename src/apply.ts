import fs from "fs";
import { extractHwpx, repackHwpx } from "./hwpx";
import { replaceMarkers } from "./replace";
import type { Translation } from "./translate";

const hwpxPath = process.argv[2];
const jsonPath = process.argv[3];

if (!hwpxPath || !jsonPath) {
  console.error("Usage: bun src/apply.ts <hwpx-file> <translations.json>");
  process.exit(1);
}

const translations: Translation[] = JSON.parse(
  fs.readFileSync(jsonPath, "utf-8"),
);

const hwpx = extractHwpx(hwpxPath);
const newXml = replaceMarkers(hwpx.xml, translations, hwpx.boldIds);
const outPath = repackHwpx(hwpx, newXml);

console.log(outPath);
