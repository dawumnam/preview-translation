// Fine-grained STT pass: transcribes one stretch of speech sentence by
// sentence so each sentence gets its own measured start time. The main STT
// pass (stt_chunks.ts) groups a whole monologue into a single block, which is
// too coarse when editors ask for a timecode per sentence.
import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { ThinkingLevel } from "@google/genai";
import { getGeminiClient, uploadMedia } from "./gemini";

const MODEL = "gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 16384;

const [media, startArg, endArg, outPath] = process.argv.slice(2);
if (!media || !startArg || !endArg || !outPath) {
  console.error(
    "Usage: bun src/sentence_stt.ts <media> <start_sec> <end_sec> <out.json>",
  );
  process.exit(1);
}

const startSec = Number(startArg);
const endSec = Number(endArg);
if (!(endSec > startSec)) {
  console.error("end_sec must be greater than start_sec");
  process.exit(1);
}

const clipPath = path.join(
  path.dirname(path.resolve(outPath)),
  `${path.basename(outPath, ".json")}_clip.mp3`,
);

if (!fs.existsSync(clipPath) || fs.statSync(clipPath).size <= 1000) {
  console.error(`Extracting ${startSec}s-${endSec}s -> ${clipPath}`);
  // -ss before -i seeks by index instead of decoding from the start, which
  // matters when the source is a multi-GB camera file
  execSync(
    `ffmpeg -y -ss ${startSec} -i "${media}" -t ${endSec - startSec} ` +
      `-vn -acodec libmp3lame -ar 44100 -ac 1 "${clipPath}" -loglevel error`,
  );
}

const ai = getGeminiClient();
const uploaded = await uploadMedia(ai, clipPath);

const prompt = `Transcribe this audio clip sentence by sentence.

This is a stretch of speech from a Korean variety show shot in Kazakhstan. The
main speaker talks in Kazakh (with some Russian loanwords); a coordinator and
the Korean crew also speak.

## Instructions
- Emit ONE entry per sentence. Do not merge sentences into blocks.
- A sentence ends at a natural full stop in the speech, not at a breath pause.
- "start" is when that sentence begins, in seconds from the start of THIS clip,
  with one decimal place. Base it on what you actually hear.
- Transcribe verbatim in the original language, and translate into natural Korean.
- Include every sentence spoken by every speaker, in order.

## Response format
Respond ONLY with a JSON array, no prose and no markdown fences:
[
  { "start": 12.4, "speaker": "<who>", "language": "<language>", "original": "<verbatim>", "korean": "<Korean translation>" }
]`;

const response = await ai.models.generateContent({
  model: MODEL,
  contents: [
    {
      role: "user",
      parts: [
        { fileData: { fileUri: uploaded.uri, mimeType: uploaded.mimeType } },
        { text: prompt },
      ],
    },
  ],
  config: {
    temperature: 0.2,
    maxOutputTokens: MAX_OUTPUT_TOKENS,
    thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
  },
});

const text = (response.text ?? "")
  .trim()
  .replace(/^```json?\s*\n?/, "")
  .replace(/\n?```\s*$/, "");

let sentences: Array<{
  start: number;
  speaker?: string;
  language?: string;
  original?: string;
  korean?: string;
}>;
try {
  sentences = JSON.parse(text);
} catch {
  console.error("Failed to parse model response:");
  console.error(text.slice(0, 500));
  process.exit(1);
}

// Re-base clip-relative times onto the original recording
const output = sentences.map((s) => ({
  ...s,
  timestamp: Math.round(startSec + s.start),
}));

fs.writeFileSync(outPath, JSON.stringify(output, null, 2) + "\n");
console.error(`Wrote ${outPath} (${output.length} sentences)`);
