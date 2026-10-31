import fs from "fs";
import path from "path";
import type { Translation } from "./translate";
import { translationText } from "./replace";

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

// Normalise translation text. replace.ts XML-escapes on insert, so text must
// be plain: mappers have pre-escaped titles (&lt;서유기&gt;), which would
// render as literal "&lt;" in the document. Mappers have also joined separate
// utterances with " / ", which editors do not want in the script.
function cleanText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+\/\s+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim();
}

let cleaned = 0;
for (const t of all) {
  if (typeof t.translation === "string") {
    const c = cleanText(t.translation);
    if (c !== t.translation) cleaned++;
    t.translation = c;
  }
  for (const seg of (t.segments ?? []) as any[]) {
    if (typeof seg.text !== "string") continue;
    const c = cleanText(seg.text);
    if (c !== seg.text) cleaned++;
    seg.text = c;
  }
}
if (cleaned > 0) {
  console.warn(
    `Warning: cleaned ${cleaned} text(s) — mapper output had XML entities or " / " joins`,
  );
}

// One line per marker, under the script's own TC. Editors found inserted TC
// lines drifted from the video, so translations are no longer split. If a
// mapper still wrote several segments, join them into one translation.
let joinedCount = 0;
let structuralErrors = 0;

for (const t of all) {
  if (Array.isArray(t.segments) && t.segments.length > 0) {
    if (t.segments.length > 1) joinedCount++;
    t.translation = translationText(t);
    delete t.segments;
  }
  if (!t.translation || t.translation.trim().length === 0) {
    console.error(`Marker ${t.markerIndex}: no translation text`);
    structuralErrors++;
  }
}
if (joinedCount > 0) {
  console.warn(
    `Warning: joined ${joinedCount} multi-segment translation(s) into one line — the script TC is kept, no TC lines are added`,
  );
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
  `Merged ${all.length} translations from ${chunks.length} chunks → ${outPath}`,
);
