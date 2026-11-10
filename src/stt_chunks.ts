import fs from "fs";
import path from "path";
import { ThinkingLevel, Type } from "@google/genai";
import { getGeminiClient } from "./gemini";
import { formatTimestamp, LANG_NAME } from "./parser";

const MODEL = "gemini-3.8-flash";
// Caps runaway output (see pre-flight checklist), but must also cover thinking
// tokens, which count against this budget. HIGH thinking has been measured at
// 14k-30k on a single 5-minute chunk, and a dense chunk needs ~10k more for the
// transcript itself, so anything under ~48k risks truncating mid-JSON.
// HIGH is worth the tokens: on the densest chunk it found ~10% more foreign
// speech than MEDIUM/LOW, and speech it misses becomes a marker with no match.
const MAX_OUTPUT_TOKENS = 65536;

// Usage:
//   bun src/stt_chunks.ts <chunks_uploaded.json> --passes 3   (stt_results, _2, _3)
//   bun src/stt_chunks.ts <chunks_uploaded.json> [out-dir-name=stt_results]
// Several passes exist because one pass misses quiet lines that another hears
// (merge_stt.ts takes the union) and so speech_duration.ts can average them.
// Every (pass, chunk) job runs at the same time; set STT_CONCURRENCY to cap it.
const args = process.argv.slice(2);
const uploadedPath = args[0];
if (!uploadedPath || uploadedPath.startsWith("--")) {
  console.error(
    "Usage: bun src/stt_chunks.ts <chunks_uploaded.json> [--passes N | out-dir-name=stt_results]",
  );
  process.exit(1);
}
const passesFlag = args.indexOf("--passes");
const passNames: string[] =
  passesFlag >= 0
    ? Array.from({ length: Math.max(1, parseInt(args[passesFlag + 1], 10) || 1) }, (_, k) =>
        k === 0 ? "stt_results" : `stt_results_${k + 1}`,
      )
    : [args[1] || "stt_results"];

const CONCURRENCY = parseInt(process.env.STT_CONCURRENCY || "", 10) || Infinity;
// Gemini blocks some requests at random (promptFeedback.blockReason=OTHER, an
// empty response); the same request often goes through on a later try. On 1028
// one chunk needed 4+ tries in a pass. A chunk that is blocked on every try has
// to be split into shorter pieces (see CLAUDE.md, "Blocked chunks").
const MAX_ATTEMPTS = parseInt(process.env.STT_ATTEMPTS || "", 10) || 6;

const plan = JSON.parse(fs.readFileSync(uploadedPath, "utf-8"));
const baseDir = path.dirname(path.resolve(plan.hwpx_path));

for (const name of passNames) {
  const dir = path.join(baseDir, name);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
}

const ai = getGeminiClient();

// Structured output: without this the model picks a different markdown layout
// per chunk, and only emits an end time when it feels like it.
const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      // Tenths matter: with whole seconds the model floors starts and ceils
      // ends, inflating a dialogue block by ~1s. Measured on one clean chunk:
      // 98s whole-second vs 90.9s / 91.0s tenths (two passes) vs 95.2s from
      // acoustic snapping. Tenths are also far more repeatable run to run.
      start: {
        type: Type.STRING,
        description:
          "Start of the utterance within this clip as MM:SS.d with tenths of a second, e.g. 01:03.4",
      },
      end: {
        type: Type.STRING,
        description:
          "End of the utterance within this clip as MM:SS.d with tenths of a second. When the speech stops, not when the next speaker starts.",
      },
      speaker: {
        type: Type.STRING,
        description: "Speaker abbreviation, or 스태프 / 제작진 for crew",
      },
      language: {
        type: Type.STRING,
        description:
          "Language actually spoken: 한국어, 조지아어, 베트남어, 영어, 독일어, etc. Use a slash for code-switching, e.g. 베트남어/한국어",
      },
      text: { type: Type.STRING, description: "Verbatim transcription" },
      translation: {
        type: Type.STRING,
        description:
          "Korean translation. Empty string when the utterance is already Korean.",
      },
    },
    required: ["start", "end", "speaker", "language", "text", "translation"],
    propertyOrdering: [
      "start",
      "end",
      "speaker",
      "language",
      "text",
      "translation",
    ],
  },
};

/** "MM:SS.d" (or MM:SS / HH:MM:SS.d) → seconds. Returns null on anything unparseable. */
function clipTimeToSeconds(ts: string): number | null {
  const parts = ts.trim().split(":");
  if (parts.length < 2 || parts.length > 3) return null;
  const secs = parseFloat(parts[parts.length - 1]);
  const mins = parseInt(parts[parts.length - 2], 10);
  const hrs = parts.length === 3 ? parseInt(parts[0], 10) : 0;
  if ([secs, mins, hrs].some(Number.isNaN)) return null;
  return Math.round((hrs * 3600 + mins * 60 + secs) * 10) / 10;
}

function buildSTTPrompt(chunk: any): string {
  // Build character list
  const chars = [...new Set(chunk.markers.map((m: any) => m.charName))];
  const langs = [...new Set(chunk.markers.map((m: any) => m.language))];

  // Build context snippet (first 30 lines)
  const contextSnippet = (chunk.context || []).slice(0, 30).join("\n  ");

  return `Transcribe ALL speech in this audio clip. This is from a Korean variety show.

## Scene: "${chunk.scene}"
Time range in original: ${formatTimestamp(chunk.start_sec)} - ${formatTimestamp(chunk.end_sec)}
Foreign languages spoken: ${langs.map((c) => LANG_NAME[c as string] ?? c).join("/")}
Characters speaking foreign language: ${chars.join(", ")}

## Surrounding Korean dialogue for context
  ${contextSnippet}

## Instructions
Return one entry per utterance, in chronological order, covering EVERYTHING —
crew chatter, narration and retakes included. Do not skip any speech.

- \`start\` / \`end\` are clip-relative MM:SS.d with tenths of a second. Be precise:
  \`end\` is where that speech actually stops — do NOT stretch it to the next
  speaker's start.
- Split at natural speech boundaries. A single entry should be one continuous
  utterance, not a whole conversation merged together.
- \`language\` is what was actually spoken, not what the script expects.
- \`translation\` is Korean; leave it as an empty string for Korean utterances.`;
}

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

function hasResult(outFile: string): boolean {
  if (!fs.existsSync(outFile)) return false;
  try {
    const existing = JSON.parse(fs.readFileSync(outFile, "utf-8"));
    return Array.isArray(existing.utterances) && existing.utterances.length > 0;
  } catch {
    return false;
  }
}

/** One STT call with retries. Returns the parsed utterances, or [] after MAX_ATTEMPTS. */
async function transcribe(chunk: any, tag: string): Promise<any[]> {
  const prompt = buildSTTPrompt(chunk);
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: MODEL,
        contents: [
          {
            role: "user",
            parts: [
              {
                fileData: {
                  fileUri: chunk.uri,
                  mimeType: chunk.mimeType || "audio/mpeg",
                },
              },
              { text: prompt },
            ],
          },
        ],
        config: {
          temperature: 0.2,
          maxOutputTokens: MAX_OUTPUT_TOKENS,
          thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
          responseMimeType: "application/json",
          responseSchema: RESPONSE_SCHEMA,
        },
      });
      // Surface truncation explicitly — otherwise this shows up as an opaque
      // "JSON Parse error" and retries burn calls on an identical failure.
      const finishReason = response.candidates?.[0]?.finishReason;
      if (finishReason && finishReason !== "STOP") {
        const u = response.usageMetadata ?? ({} as any);
        throw new Error(
          `finishReason=${finishReason} (thoughts=${u.thoughtsTokenCount ?? "?"}, output=${u.candidatesTokenCount ?? "?"}, cap=${MAX_OUTPUT_TOKENS}) — raise MAX_OUTPUT_TOKENS or lower thinkingLevel`,
        );
      }
      const raw = response.text?.trim() || "";
      if (!raw) {
        const u = response.usageMetadata ?? ({} as any);
        throw new Error(
          `empty response (finishReason=${finishReason ?? "none"}, promptFeedback=${JSON.stringify(response.promptFeedback ?? null)}, thoughts=${u.thoughtsTokenCount ?? "?"}, output=${u.candidatesTokenCount ?? "?"})`,
        );
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("response was not an array");
      return parsed;
    } catch (err: any) {
      const isRateLimit = err?.status === 429 || err?.message?.includes("429");
      // Many jobs run at once, so back off harder on 429 and add jitter so
      // they do not all come back in the same second.
      const backoff =
        (isRateLimit ? Math.min(60000, Math.pow(2, attempt) * 5000) : 3000 * attempt) +
        Math.random() * 2000;
      if (attempt < MAX_ATTEMPTS) {
        console.error(
          `${tag} error: ${err.message}. Retry ${attempt}/${MAX_ATTEMPTS - 1} in ${Math.round(backoff / 1000)}s`,
        );
        await new Promise((r) => setTimeout(r, backoff));
      } else {
        console.error(`${tag} error: ${err.message}. Giving up after ${MAX_ATTEMPTS} attempts`);
      }
    }
  }
  return [];
}

async function runJob(job: { pass: string; chunk: any }): Promise<void> {
  const { pass, chunk } = job;
  const tag = `[${pass} ${chunk.chunk_id}]`;
  const outFile = path.join(baseDir, pass, `${chunk.chunk_id}.json`);
  if (hasResult(outFile)) {
    console.error(`${tag} already done, skipping`);
    return;
  }
  console.error(`${tag} STT (${chunk.scene}, ${chunk.markers.length} markers)`);

  const utterances = await transcribe(chunk, tag);
  if (!utterances.length) {
    console.error(`${tag} ✗ no output`);
    return;
  }

  // Resolve clip-relative MM:SS into absolute seconds here, so the mapper
  // never has to do timestamp arithmetic by hand.
  let dropped = 0;
  const enriched = utterances.flatMap((u: any) => {
    const startSec = clipTimeToSeconds(u.start);
    const endSec = clipTimeToSeconds(u.end);
    if (startSec === null) {
      dropped++;
      return [];
    }
    const safeEnd = endSec !== null && endSec >= startSec ? endSec : startSec;
    return [
      {
        ...u,
        start_sec: startSec,
        end_sec: safeEnd,
        abs_start: chunk.audio_start + startSec,
        abs_end: chunk.audio_start + safeEnd,
        duration: Math.round((safeEnd - startSec) * 10) / 10,
      },
    ];
  });

  // Sums of tenths accumulate float noise; keep the stored totals to 0.1s.
  const tenth = (x: number) => Math.round(x * 10) / 10;
  const speechSec = tenth(enriched.reduce((acc: number, u: any) => acc + u.duration, 0));
  const foreignSec = tenth(
    enriched
      .filter((u: any) => u.language && u.language.trim() !== "한국어")
      .reduce((acc: number, u: any) => acc + u.duration, 0),
  );

  const out = {
    chunk_id: chunk.chunk_id,
    scene: chunk.scene,
    audio_start: chunk.audio_start,
    marker_range: [chunk.start_sec, chunk.end_sec],
    markers: chunk.marker_indices,
    speech_sec: speechSec,
    foreign_speech_sec: foreignSec,
    utterances: enriched,
  };

  // Write to a temp name and rename, so a run that is killed mid-write never
  // leaves a half file that a later run would accept.
  fs.writeFileSync(`${outFile}.tmp`, JSON.stringify(out, null, 2), "utf-8");
  fs.renameSync(`${outFile}.tmp`, outFile);
  console.error(
    `${tag} ✓ ${enriched.length} utterances, ${formatTimestamp(Math.round(foreignSec))} foreign speech${dropped ? `, ${dropped} dropped` : ""}`,
  );
}

const jobs = passNames.flatMap((pass) => plan.chunks.map((chunk: any) => ({ pass, chunk })));
console.error(
  `STT: ${plan.chunks.length} chunks × ${passNames.length} pass(es) = ${jobs.length} jobs, ` +
    `${Number.isFinite(CONCURRENCY) ? CONCURRENCY : "all"} at a time, up to ${MAX_ATTEMPTS} attempts each`,
);
await pool(jobs, CONCURRENCY, runJob);

const missing = jobs.filter(
  (j) => !hasResult(path.join(baseDir, j.pass, `${j.chunk.chunk_id}.json`)),
);
for (const pass of passNames) {
  const miss = missing.filter((j) => j.pass === pass).map((j) => j.chunk.chunk_id);
  console.error(
    `${pass}: ${plan.chunks.length - miss.length}/${plan.chunks.length}${miss.length ? ` — missing ${miss.join(", ")}` : ""}`,
  );
}
if (missing.length) {
  console.error("Run the same command again to retry the missing chunks.");
  process.exit(1);
}
console.error("Done.");
