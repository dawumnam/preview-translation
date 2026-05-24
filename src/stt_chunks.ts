import fs from "fs";
import path from "path";
import { getGeminiClient } from "./gemini";
import { formatTimestamp } from "./parser";

const MODEL = "gemini-3.5-flash";
const MAX_OUTPUT_TOKENS = 16384;

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
For each utterance in this clip, provide:
- Approximate timestamp within this clip (MM:SS)
- Speaker (if identifiable)
- Language
- Verbatim transcription
- If not Korean, provide Korean translation

Transcribe EVERYTHING — do not skip any speech. Format as a structured list.`;
}

for (let i = 0; i < plan.chunks.length; i++) {
  const chunk = plan.chunks[i];
  const outFile = path.join(outDir, `${chunk.chunk_id}.txt`);

  // Skip if already done — check for actual transcript content after the header
  if (fs.existsSync(outFile)) {
    const existing = fs.readFileSync(outFile, "utf-8");
    const afterHeader = existing.split("---\n")[1]?.trim();
    if (afterHeader && afterHeader.length > 50) {
      console.error(
        `[${i + 1}/${plan.chunks.length}] ${chunk.chunk_id} — already done, skipping`,
      );
      continue;
    }
    console.error(
      `[${i + 1}/${plan.chunks.length}] ${chunk.chunk_id} — incomplete result, retrying...`,
    );
  }

  console.error(
    `[${i + 1}/${plan.chunks.length}] STT ${chunk.chunk_id} (${chunk.scene}, ${chunk.markers.length} markers)...`,
  );

  const prompt = buildSTTPrompt(chunk);
  let text = "";
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
          thinkingConfig: { thinkingLevel: "HIGH" },
        },
      });
      text = response.text?.trim() || "";
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

  if (text) {
    // Prepend metadata header
    const header = [
      `CHUNK: ${chunk.chunk_id}`,
      `SCENE: ${chunk.scene}`,
      `AUDIO_OFFSET: ${chunk.audio_start}s (${formatTimestamp(chunk.audio_start)}) from original`,
      `MARKER_RANGE: ${formatTimestamp(chunk.start_sec)} - ${formatTimestamp(chunk.end_sec)}`,
      `MARKERS: ${chunk.marker_indices.join(", ")}`,
      `---`,
    ].join("\n");

    fs.writeFileSync(outFile, header + "\n" + text, "utf-8");
    console.error(`  ✓ Saved ${outFile} (${text.length} chars)`);
  } else {
    console.error(`  ✗ No output for ${chunk.chunk_id}`);
  }

  // Rate limit between calls
  if (i < plan.chunks.length - 1) {
    await new Promise((r) => setTimeout(r, 2000));
  }
}

console.error(`\nDone. Results in ${outDir}/`);
