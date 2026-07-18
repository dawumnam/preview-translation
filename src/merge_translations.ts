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

// Validate segments
const MAX_SEGMENT_CHARS = 220;
let multiSegmentCount = 0;
let structuralErrors = 0;

for (const t of all) {
  const hasText =
    (t.translation && t.translation.trim().length > 0) ||
    (Array.isArray(t.segments) && t.segments.length > 0);
  if (!hasText) {
    console.error(`Marker ${t.markerIndex}: no translation or segments`);
    structuralErrors++;
    continue;
  }

  if (Array.isArray(t.segments) && t.segments.length > 0) {
    if (t.segments.length > 1) multiSegmentCount++;

    let prevTs = -1;
    for (const [i, seg] of t.segments.entries()) {
      if (typeof seg.timestamp !== "number" || !seg.text?.trim()) {
        console.error(
          `Marker ${t.markerIndex} segment ${i}: missing timestamp or text`,
        );
        structuralErrors++;
      } else if (seg.timestamp < prevTs) {
        console.error(
          `Marker ${t.markerIndex} segment ${i}: timestamp ${seg.timestamp} decreases (prev ${prevTs})`,
        );
        structuralErrors++;
      } else {
        prevTs = seg.timestamp;
      }
      if (seg.text && seg.text.length > MAX_SEGMENT_CHARS) {
        console.warn(
          `Warning: marker ${t.markerIndex} segment ${i} is ${seg.text.length} chars (>${MAX_SEGMENT_CHARS}) — consider splitting further`,
        );
      }
    }
  } else if (t.translation && t.translation.length > MAX_SEGMENT_CHARS) {
    console.warn(
      `Warning: marker ${t.markerIndex} single translation is ${t.translation.length} chars (>${MAX_SEGMENT_CHARS}) — should be split into segments`,
    );
  }
}

if (structuralErrors > 0) {
  console.error(`\n${structuralErrors} structural error(s). Merge aborted.`);
  process.exit(1);
}

const outPath = path.join(hwpxDir, "translations.json");
fs.writeFileSync(outPath, JSON.stringify(all, null, 2) + "\n");
console.log(
  `Merged ${all.length} translations from ${chunks.length} chunks (${multiSegmentCount} split into multiple TC segments) → ${outPath}`,
);
