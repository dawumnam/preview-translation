import fs from "fs";
import path from "path";
import type { Translation } from "./translate";

const planPath = process.argv[2];
if (!planPath) {
  console.error("Usage: bun src/merge_translations.ts <chunks_plan.json>");
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const hwpxDir = path.dirname(planPath);
const translationsDir = path.join(hwpxDir, "translations");
const totalMarkers: number = plan.total_markers;
const chunks: Array<{ chunk_id: string }> = plan.chunks;

const all: Translation[] = [];
const missing: string[] = [];

for (const chunk of chunks) {
  const chunkFile = path.join(translationsDir, `${chunk.chunk_id}.json`);
  if (!fs.existsSync(chunkFile)) {
    missing.push(chunk.chunk_id);
    console.error(`Missing: translations/${chunk.chunk_id}.json`);
    continue;
  }
  const chunkTranslations: Translation[] = JSON.parse(
    fs.readFileSync(chunkFile, "utf-8"),
  );
  all.push(...chunkTranslations);
}

if (missing.length > 0) {
  console.error(
    `\n${missing.length} chunk file(s) missing. Merge incomplete.`,
  );
  process.exit(1);
}

all.sort((a, b) => a.markerIndex - b.markerIndex);

// Validate coverage
const covered = new Set(all.map((t) => t.markerIndex));
const gaps: number[] = [];
for (let i = 0; i < totalMarkers; i++) {
  if (!covered.has(i)) gaps.push(i);
}

if (gaps.length > 0) {
  console.error(`Missing marker indices: ${gaps.join(", ")}`);
  process.exit(1);
}

const outPath = path.join(hwpxDir, "translations.json");
fs.writeFileSync(outPath, JSON.stringify(all, null, 2) + "\n");
console.log(
  `Merged ${all.length} translations from ${chunks.length} chunks → ${outPath}`,
);
