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

// Validate segments. Editors want each TC block to cover at most 20s of
// audio; a segment runs from its timestamp to the next segment's (or to the
// marker's speech_end for the last one). Overruns are warnings, not errors:
// a single 22s sentence cannot be cut without splitting it mid-sentence.
const MAX_SEGMENT_SEC = 20;
let multiSegmentCount = 0;
let structuralErrors = 0;
let overlong = 0;

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

    // Segment 1's timestamp is the measured start of the marker's speech.
    // Mappers keep writing the script TC here despite instructions, so set
    // it from speech_start rather than rely on them. Not rendered in the
    // document (only segments 2..N get a TC), but it keeps the data honest.
    if (typeof t.speech_start === "number" && typeof t.segments[0].timestamp === "number") {
      t.segments[0].timestamp = t.speech_start;
    }

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
    }

    if (typeof t.speech_end === "number") {
      for (const [i, seg] of t.segments.entries()) {
        const next = t.segments[i + 1];
        const end = next ? next.timestamp : t.speech_end;
        const dur = end - seg.timestamp;
        if (dur > MAX_SEGMENT_SEC) {
          overlong++;
          console.warn(
            `Warning: marker ${t.markerIndex} segment ${i} covers ${dur.toFixed(1)}s of audio (>${MAX_SEGMENT_SEC}s) — should be split at a sentence boundary`,
          );
        }
      }
    }
  } else if (
    typeof t.speech_start === "number" &&
    typeof t.speech_end === "number" &&
    t.speech_end - t.speech_start > MAX_SEGMENT_SEC
  ) {
    overlong++;
    console.warn(
      `Warning: marker ${t.markerIndex} single translation covers ${(t.speech_end - t.speech_start).toFixed(1)}s of audio (>${MAX_SEGMENT_SEC}s) — should be split into segments`,
    );
  }
}
if (overlong > 0) {
  console.warn(`Warning: ${overlong} segment(s) exceed ${MAX_SEGMENT_SEC}s`);
}

// Validate speech spans — the audio each translation was written from, which
// is what gets billed. Missing spans are tolerated (legacy runs) but reported,
// because speech_duration.ts cannot count those markers.
let noSpan = 0;
for (const t of all) {
  const hasSpan =
    typeof t.speech_start === "number" && typeof t.speech_end === "number";
  if (!hasSpan) {
    noSpan++;
  } else if (t.speech_end! < t.speech_start!) {
    console.error(
      `Marker ${t.markerIndex}: speech_end ${t.speech_end} before speech_start ${t.speech_start}`,
    );
    structuralErrors++;
  }
}
if (noSpan > 0) {
  console.warn(
    `Warning: ${noSpan} of ${all.length} entries have no speech_start/speech_end — speech_duration.ts will report them as unmeasured`,
  );
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
