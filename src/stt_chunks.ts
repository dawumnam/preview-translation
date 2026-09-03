import fs from "fs";
import path from "path";
import { ThinkingLevel, Type } from "@google/genai";
import { getGeminiClient } from "./gemini";
import { formatTimestamp } from "./parser";

const MODEL = "gemini-3.8-flash";
// Caps runaway output (see pre-flight checklist), but must also cover thinking
// tokens, which count against this budget — HIGH thinking alone can take ~7k.
const MAX_OUTPUT_TOKENS = 32768;

const uploadedPath = process.argv[2];
if (!uploadedPath) {
  console.error("Usage: bun src/stt_chunks.ts <chunks_uploaded.json>");
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(uploadedPath, "utf-8"));
const baseDir = path.dirname(path.resolve(plan.hwpx_path));

// Create output directory
const outDir = path.join(baseDir, "stt_results");
if (!fs.existsSync(outDir)) {
  fs.mkdirSync(outDir);
}

const ai = getGeminiClient();

// Structured output: without this the model picks a different markdown layout
// per chunk, and only emits an end time when it feels like it.
const RESPONSE_SCHEMA = {
  type: Type.ARRAY,
  items: {
    type: Type.OBJECT,
    properties: {
      start: {
        type: Type.STRING,
        description: "Start of the utterance within this clip, MM:SS",
      },
      end: {
        type: Type.STRING,
        description:
          "End of the utterance within this clip, MM:SS. When the speech stops, not when the next speaker starts.",
      },
      speaker: {
        type: Type.STRING,
        description: "Speaker abbreviation, or 스태프 / 제작진 for crew",
      },
      language: {
        type: Type.STRING,
        description:
          "Language actually spoken: 한국어, 베트남어, 영어, 독일어, etc. Use a slash for code-switching, e.g. 베트남어/한국어",
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

/** "MM:SS" or "HH:MM:SS" → seconds. Returns null on anything unparseable. */
function clipTimeToSeconds(ts: string): number | null {
  const parts = ts.trim().split(":").map((p) => parseInt(p, 10));
  if (parts.some((p) => Number.isNaN(p))) return null;
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  return null;
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
Foreign languages spoken: ${langs.join("/")}
Characters speaking foreign language: ${chars.join(", ")}

## Surrounding Korean dialogue for context
  ${contextSnippet}

## Instructions
Return one entry per utterance, in chronological order, covering EVERYTHING —
crew chatter, narration and retakes included. Do not skip any speech.

- \`start\` / \`end\` are clip-relative MM:SS. \`end\` is where that speech actually
  stops — do NOT stretch it to the next speaker's start.
- Split at natural speech boundaries. A single entry should be one continuous
  utterance, not a whole conversation merged together.
- \`language\` is what was actually spoken, not what the script expects.
- \`translation\` is Korean; leave it as an empty string for Korean utterances.`;
}

for (let i = 0; i < plan.chunks.length; i++) {
  const chunk = plan.chunks[i];
  const outFile = path.join(outDir, `${chunk.chunk_id}.json`);

  // Skip if already done — check for actual utterances, not just a valid file
  if (fs.existsSync(outFile)) {
    try {
      const existing = JSON.parse(fs.readFileSync(outFile, "utf-8"));
      if (Array.isArray(existing.utterances) && existing.utterances.length > 0) {
        console.error(
          `[${i + 1}/${plan.chunks.length}] ${chunk.chunk_id} — already done, skipping`,
        );
        continue;
      }
    } catch {
      // fall through and retry
    }
    console.error(
      `[${i + 1}/${plan.chunks.length}] ${chunk.chunk_id} — incomplete result, retrying...`,
    );
  }

  console.error(
    `[${i + 1}/${plan.chunks.length}] STT ${chunk.chunk_id} (${chunk.scene}, ${chunk.markers.length} markers)...`,
  );

  const prompt = buildSTTPrompt(chunk);
  let utterances: any[] = [];
  let retries = 0;

  while (retries <= 2) {
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
      if (!raw) throw new Error("empty response");
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("response was not an array");
      utterances = parsed;
      break;
    } catch (err: any) {
      retries++;
      const isRateLimit =
        err?.status === 429 || err?.message?.includes("429");
      const backoff = isRateLimit
        ? Math.pow(2, retries) * 3000
        : 2000;
      console.error(
        `  Error: ${err.message}. Retry ${retries}/2 in ${backoff / 1000}s...`,
      );
      await new Promise((r) => setTimeout(r, backoff));
    }
  }

  if (utterances.length) {
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
          duration: safeEnd - startSec,
        },
      ];
    });

    const speechSec = enriched.reduce(
      (acc: number, u: any) => acc + u.duration,
      0,
    );
    const foreignSec = enriched
      .filter((u: any) => u.language && u.language.trim() !== "한국어")
      .reduce((acc: number, u: any) => acc + u.duration, 0);

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

    fs.writeFileSync(outFile, JSON.stringify(out, null, 2), "utf-8");
    console.error(
      `  ✓ Saved ${outFile} (${enriched.length} utterances, ${formatTimestamp(foreignSec)} foreign speech${dropped ? `, ${dropped} dropped` : ""})`,
    );
  } else {
    console.error(`  ✗ No output for ${chunk.chunk_id}`);
  }

  // Rate limit between calls
  if (i < plan.chunks.length - 1) {
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.error(`\nDone. Results in ${outDir}/`);
