import fs from "fs";
import path from "path";
import { ThinkingLevel, Type } from "@google/genai";
import { getGeminiClient } from "./gemini";
import { formatTimestamp } from "./parser";
import type { Marker } from "./parser";
import type { Translation, TranslationSegment } from "./translate";

// Step 4 (MAP) without Claude Code: one Gemini call per chunk does what a
// `mapper` subagent does — read the chunk's markers + the merged STT
// transcript, decide which utterances each marker points at, and write Korean
// translations split into ≤20s TC segments with the audio span they were
// written from. Same output contract as .claude/agents/mapper.md, so
// merge_translations.ts / apply.ts / speech_duration.ts are unchanged.
//
// Usage: bun src/map_chunks.ts <hwpx-dir>/chunks_plan.json [--only id,id] [--concurrency 4] [--force]
//
// Reads stt_results_merged/<id>.json (falls back to stt_results/<id>.json).
// Chunks that already have translations/<id>.json are skipped unless --force.

const MODEL = "gemini-3.8-flash";
const MAX_OUTPUT_TOKENS = 65536;
const MAX_SEGMENT_SEC = 20;

const args = process.argv.slice(2);
const planPath = args.find((a) => !a.startsWith("--"));
const flag = (name: string, dflt: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : dflt;
};
const FORCE = args.includes("--force");
const ONLY = flag("only", "").split(",").map((s) => s.trim()).filter(Boolean);
const CONCURRENCY = Math.max(1, parseInt(flag("concurrency", "4"), 10) || 4);

if (!planPath) {
  console.error("Usage: bun src/map_chunks.ts <chunks_plan.json> [--only id,id] [--concurrency 4] [--force]");
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const baseDir = path.dirname(path.resolve(planPath));
const outDir = path.join(baseDir, "translations");
fs.mkdirSync(outDir, { recursive: true });

const LANG_NAME: Record<string, string> = {
  영: "영어",
  독: "독일어",
  오: "오스트리아 독일어",
  베: "베트남어",
  중: "중국어",
  일: "일본어",
  프: "프랑스어",
  스: "스페인어",
  태: "태국어",
};
const langName = (code: string) => LANG_NAME[code] ?? code;

const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      markerIndex: {
        type: Type.INTEGER,
        description: "The marker's global index exactly as listed (not a 0-based position in this chunk)",
      },
      speech_start: {
        type: Type.NUMBER,
        description: "abs_start of the first utterance this translation was written from (seconds from start of the original audio)",
      },
      speech_end: {
        type: Type.NUMBER,
        description: "abs_end of the last utterance this translation was written from",
      },
      segments: {
        type: Type.ARRAY,
        description: "Korean translation split into TC segments; one segment when the speech span is ≤20s",
        items: {
          type: Type.OBJECT,
          properties: {
            timestamp: {
              type: Type.NUMBER,
              description: "abs_start of the utterance where this segment's text begins",
            },
            text: { type: Type.STRING, description: "Natural Korean subtitle text for this segment" },
          },
          required: ["timestamp", "text"],
          propertyOrdering: ["timestamp", "text"],
        },
      },
      confidence: { type: Type.STRING, enum: ["high", "medium", "low"] },
      note: {
        type: Type.STRING,
        description: "One short sentence on how the speech was matched, or why confidence is not high. Empty string when nothing to say.",
      },
    },
    required: ["markerIndex", "speech_start", "speech_end", "segments", "confidence", "note"],
    propertyOrdering: ["markerIndex", "speech_start", "speech_end", "segments", "confidence", "note"],
  },
};

interface Utt {
  abs_start: number;
  abs_end: number;
  speaker: string;
  language: string;
  text: string;
  translation: string;
  heard_by?: number;
  of_passes?: number;
  speakers_heard?: string[];
}

function fmtSec(s: number): string {
  return `${formatTimestamp(Math.floor(s))}.${Math.round((s % 1) * 10) % 10}`;
}

function buildPrompt(chunk: any, utts: Utt[], errorNote?: string): string {
  const markers: Marker[] = chunk.markers;
  const markerLines = markers
    .map((m) => {
      const range = m.endTimestamp ? ` ~ ${formatTimestamp(m.endTimestamp)}` : "";
      const hint = m.hint ? `  hint: "${m.hint}"` : "";
      return `- markerIndex ${m.index}: script TC ${formatTimestamp(m.timestamp)}${range} (${m.timestamp}s)  speaker ${m.charName}  language ${langName(m.language)}${hint}`;
    })
    .join("\n");

  const uttLines = utts
    .map((u) => {
      const heard =
        typeof u.heard_by === "number" && typeof u.of_passes === "number"
          ? ` heard_by ${u.heard_by}/${u.of_passes}`
          : "";
      const alt =
        u.speakers_heard && u.speakers_heard.length > 1
          ? ` speakers_heard ${u.speakers_heard.join("/")}`
          : "";
      const tr = u.translation && u.translation.trim() ? `  →  ${u.translation}` : "";
      return `[${u.abs_start}–${u.abs_end}] (${fmtSec(u.abs_start)}) ${u.speaker} (${u.language}${heard}${alt}): ${u.text}${tr}`;
    })
    .join("\n");

  const context = (chunk.context as string[]).join("\n");
  const chars = [...new Set(markers.map((m) => m.charName))].join(", ");
  const indices = markers.map((m) => m.index).join(", ");

  return `You are a translation mapper for a Korean variety-show production script. The script writer placed @@ markers where a character speaks a foreign language and the editors need a Korean translation. You get one audio chunk: its markers, the surrounding Korean script, and a speech-to-text transcript of the chunk's audio. Match each marker to the speech it points at and write the Korean translation.

## Scene: "${chunk.scene}"
Chunk audio covers ${formatTimestamp(chunk.audio_start)} – ${formatTimestamp(chunk.audio_end)} of the original recording (${chunk.audio_start}s – ${chunk.audio_end}s). Markers fall between ${formatTimestamp(chunk.start_sec)} and ${formatTimestamp(chunk.end_sec)}.
Characters with markers: ${chars}
Recurring cast: 큐 = QU (female Korean host), 피 = PD (producer), 코 = coordinator, 카/카감 = camera director. Other abbreviations are episode-specific locals.

## Markers (${markers.length}) — use these exact markerIndex values: ${indices}
${markerLines}

## Script (Korean lines around the markers, in order; leading digits are script TCs as MMSS or HMMSS)
${context}

## Transcript (union of several STT passes; times are seconds from the start of the ORIGINAL audio — use them as-is, no arithmetic)
Format: [abs_start–abs_end] (m:ss.d) speaker (language heard_by N/M): verbatim text  →  STT's Korean translation
${uttLines}

## How to match
- Markers are in script order and the script's speaker sequence (charName) is the ground truth. Walk the transcript in time order and assign each marker the exchange it points at, using the marker's script TC (hand-typed, often shared by consecutive markers in one beat, so it is approximate), the speaker, the language, the hint, and the Korean script lines around it.
- A line heard by only one pass is still real speech — a local's quiet reply under noise is routinely heard once in five, and it is usually exactly what a marker on that speaker points at. Where speakers_heard disagree, trust the script's charName sequence over the STT speaker label.
- A marker with an end TC (range "~") covers the whole exchange in that range: combine the relevant speech into one coherent translation.
- Two markers that share one exchange (큐 and a local at the same TC) each get their own translation of their own speaker's lines, each with its own span.

## Translation
- Natural Korean as TV subtitles, not word-for-word. Start from the STT translation and improve it using the surrounding Korean script so it fits the conversation. The host's own foreign-language lines are translated too.
- confidence: "high" when the speech is clearly identified, "medium" when ambiguous, "low" when uncertain or no utterance matches.

## Speech span (this is billed — be exact)
- speech_start = abs_start of the first utterance you drew on, speech_end = abs_end of the last. Include every utterance whose content went into the translation and nothing else. If the exchange runs over a Korean aside and continues, the span runs over the aside too.
- A span ends where the marker's exchange ends. Foreign speech in a LATER beat is not part of it — especially when the script describes that beat without a marker (the writer chose not to mark it). Never fold such speech into an earlier marker; leave it untranslated.
- "No other marker until X" is never a reason to extend a span to X. A marker with a hint like "괜찮다 괜찮다 오케이" is that one reaction (~8s), not every exclamation in the next minute. Most spans are a few seconds; a span over 30s must be one continuous exchange you can point to.
- If no utterance matches at all: speech_start = speech_end = the marker's script timestamp, one segment with that timestamp, confidence "low", and translate from the hint if there is one (otherwise write your best guess of what was said based on the script).

## TC segments
- If speech_end − speech_start ≤ ${MAX_SEGMENT_SEC}s: exactly one segment.
- Otherwise split so no segment covers more than ${MAX_SEGMENT_SEC}s of the timeline: a segment runs from its timestamp to the next segment's timestamp (or to speech_end for the last). Other speakers' turns inside the span count toward that time.
- Cut only at utterance boundaries (never mid-sentence), as few segments as the cap allows, roughly balanced (30s → two ~15s segments, not 20+10). Each segment's timestamp is the abs_start of the utterance where that text begins. If one utterance is itself longer than ${MAX_SEGMENT_SEC}s, cut it at a sentence boundary, estimate the timestamp proportionally, and set confidence to "medium".
- The first segment's timestamp is the measured abs_start (= speech_start), never the script TC.

## Output
A JSON array with exactly one entry per marker listed above (${markers.length} entries, markerIndex values ${indices}), no extras, no omissions.${errorNote ? `\n\n## Your previous attempt was rejected\n${errorNote}\nFix this and return the complete array again.` : ""}`;
}

function validate(chunk: any, raw: any): { ok: true; entries: any[] } | { ok: false; error: string } {
  const expected: number[] = chunk.marker_indices;
  if (!Array.isArray(raw)) return { ok: false, error: "response was not an array" };
  let entries: any[] = raw;
  const got = entries.map((r) => Number(r.markerIndex));
  const gotSet = new Set(got);
  const expSet = new Set(expected);
  const positional =
    expected.length === entries.length &&
    expected[0] !== 0 &&
    got.every((g, i) => g === i);
  if (positional) {
    // Chunk-local numbering (0..n-1) instead of the global index: remap by position.
    console.error(`  ${chunk.chunk_id}: markerIndex was chunk-local 0..${entries.length - 1}; remapped to ${expected[0]}..${expected[expected.length - 1]}`);
    entries = entries.map((r, i) => ({ ...r, markerIndex: expected[i] }));
  } else {
    const missing = expected.filter((i) => !gotSet.has(i));
    const extra = got.filter((i) => !expSet.has(i));
    const dup = got.filter((g, i) => got.indexOf(g) !== i);
    if (missing.length || extra.length || dup.length) {
      return {
        ok: false,
        error: `markerIndex mismatch — missing: [${missing.join(", ")}] extra: [${extra.join(", ")}] duplicate: [${dup.join(", ")}]`,
      };
    }
  }
  for (const r of entries) {
    if (!Array.isArray(r.segments) || r.segments.length === 0)
      return { ok: false, error: `marker ${r.markerIndex}: no segments` };
    if (r.segments.some((s: any) => typeof s.text !== "string" || !s.text.trim()))
      return { ok: false, error: `marker ${r.markerIndex}: a segment has empty text` };
  }
  return { ok: true, entries };
}

function toTranslations(chunk: any, entries: any[]): Translation[] {
  const byIndex = new Map<number, Marker>((chunk.markers as Marker[]).map((m) => [m.index, m]));
  const tenth = (x: number) => Math.round(x * 10) / 10;
  return entries
    .map((r) => {
      const m = byIndex.get(Number(r.markerIndex))!;
      let start = Number(r.speech_start);
      let end = Number(r.speech_end);
      if (!Number.isFinite(start)) start = m.timestamp;
      if (!Number.isFinite(end) || end < start) end = start;
      const segments: TranslationSegment[] = (r.segments as any[])
        .map((s) => ({
          timestamp: Number.isFinite(Number(s.timestamp)) ? tenth(Number(s.timestamp)) : tenth(start),
          text: String(s.text).trim(),
        }))
        .sort((a, b) => a.timestamp - b.timestamp);
      segments[0].timestamp = tenth(start);
      const confidence = ["high", "medium", "low"].includes(r.confidence) ? r.confidence : "medium";
      const t: Translation & { note?: string } = {
        markerIndex: m.index,
        language: m.language,
        charName: m.charName,
        timestamp: m.timestamp,
        scene: chunk.scene,
        speech_start: tenth(start),
        speech_end: tenth(end),
        segments,
        confidence,
      };
      if (typeof r.note === "string" && r.note.trim()) t.note = r.note.trim();
      return t;
    })
    .sort((a, b) => a.markerIndex - b.markerIndex);
}

const ai = getGeminiClient();

async function mapChunk(chunk: any, idx: number, total: number): Promise<void> {
  const outFile = path.join(outDir, `${chunk.chunk_id}.json`);
  const tag = `[${idx + 1}/${total}] ${chunk.chunk_id}`;
  if (!FORCE && fs.existsSync(outFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      if (Array.isArray(existing) && existing.length === chunk.marker_indices.length) {
        console.error(`${tag} — already done, skipping`);
        return;
      }
    } catch {
      /* rewrite */
    }
  }

  let sttFile = path.join(baseDir, "stt_results_merged", `${chunk.chunk_id}.json`);
  if (!fs.existsSync(sttFile)) sttFile = path.join(baseDir, "stt_results", `${chunk.chunk_id}.json`);
  if (!fs.existsSync(sttFile)) throw new Error(`${chunk.chunk_id}: no STT result (stt_results_merged/ or stt_results/)`);
  const stt = JSON.parse(fs.readFileSync(sttFile, "utf-8"));
  const utts: Utt[] = (stt.utterances ?? []).filter((u: any) => Number.isFinite(u.abs_start));
  console.error(`${tag} MAP (${chunk.scene}, ${chunk.markers.length} markers, ${utts.length} utterances)...`);

  let errorNote: string | undefined;
  let lastErr = "";
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [{ role: "user", parts: [{ text: buildPrompt(chunk, utts, errorNote) }] }],
        config: {
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== "STOP") {
        const u = response.usageMetadata ?? ({} as any);
        throw new Error(`finishReason=${finishReason} (thoughts=${u.thoughtsTokenCount ?? "?"}, output=${u.candidatesTokenCount ?? "?"}, cap=${MAX_OUTPUT_TOKENS})`);
      }
      const raw = response.text?.trim() || "";
      if (!raw) throw new Error("empty response");
      const v = validate(chunk, JSON.parse(raw));
      if (!v.ok) {
        errorNote = v.error;
        throw new Error(v.error);
      }
      const translations = toTranslations(chunk, v.entries);
      fs.writeFileSync(outFile, JSON.stringify(translations, null, 2) + "\n");
      const low = translations.filter((t) => t.confidence === "low").length;
      const split = translations.filter((t) => (t.segments?.length ?? 0) > 1).length;
      console.error(`  ✓ ${chunk.chunk_id}: ${translations.length} markers (${split} split into segments, ${low} low confidence) → translations/${chunk.chunk_id}.json`);
      return;
    } catch (err: any) {
      lastErr = err?.message ?? String(err);
      const isRateLimit = err?.status === 429 || /429/.test(lastErr);
      const backoff = isRateLimit ? Math.pow(2, attempt) * 3000 : 2000;
      console.error(`  ${chunk.chunk_id}: ${lastErr}. Retry ${attempt}/3 in ${backoff / 1000}s...`);
      await new Promise((r) => setTimeout(r, backoff));
    }
  }
  throw new Error(`${chunk.chunk_id}: failed after 3 attempts — ${lastErr}`);
}

const chunks: any[] = ONLY.length ? plan.chunks.filter((c: any) => ONLY.includes(c.chunk_id)) : plan.chunks;
if (chunks.length === 0) {
  console.error("No chunks to map");
  process.exit(1);
}

let cursor = 0;
const failures: string[] = [];
async function worker() {
  while (cursor < chunks.length) {
    const i = cursor++;
    try {
      await mapChunk(chunks[i], i, chunks.length);
    } catch (err: any) {
      failures.push(err?.message ?? String(err));
      console.error(`  ✗ ${err?.message ?? err}`);
    }
  }
}
await Promise.all(Array.from({ length: Math.min(CONCURRENCY, chunks.length) }, worker));

if (failures.length) {
  console.error(`\n${failures.length} chunk(s) failed:\n  ${failures.join("\n  ")}`);
  process.exit(1);
}
console.error(`\nDone. Translations in ${outDir}/`);
