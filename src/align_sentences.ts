import fs from "fs";
import { ThinkingLevel } from "@google/genai";
import { getGeminiClient, uploadMedia } from "./gemini";

// Aligns an already-confirmed Korean translation to the audio, sentence by
// sentence, so each sentence gets its own timecode (editor "문장별 TC" request).
//
// Usage: bun src/align_sentences.ts <spec.json>
//
// spec.json:
//   {
//     "clip_path":  "/abs/path/clip.mp3",
//     "clip_start": 3820,            // clip offset within the original media, in seconds
//     "language":   "러시아어",       // language actually spoken
//     "scene":      "...",           // free-text context for the model
//     "sentences":  ["...", "..."]   // confirmed Korean translation, split into sentences
//   }
//
// Output (stdout): [{ "timestamp": <abs sec>, "text": "..." }, ...]

const MODEL = "gemini-3.6-flash";
const MAX_OUTPUT_TOKENS = 8192;

const specPath = process.argv[2];
if (!specPath) {
  console.error("Usage: bun src/align_sentences.ts <spec.json>");
  process.exit(1);
}

const spec = JSON.parse(fs.readFileSync(specPath, "utf-8"));
const sentences: string[] = spec.sentences;

const ai = getGeminiClient();
const { uri, mimeType } = await uploadMedia(ai, spec.clip_path);

const numbered = sentences.map((s, i) => `${i}. ${s}`).join("\n");

const prompt = `이 오디오 클립에는 ${spec.language} 발화가 담겨 있습니다.

## 상황
${spec.scene}

## 확정된 한국어 번역 (문장 단위)
아래 문장들은 이 클립 속 발화의 이미 확정된 한국어 번역입니다. 번역문은 절대 수정하지 마세요.

${numbered}

## 작업
각 번역 문장에 대응하는 ${spec.language} 원어 발화가 클립 안에서 **시작되는 시각**을 찾아 주세요.

규칙:
- 시각은 클립 시작(00:00.0) 기준 초 단위 소수점 한 자리까지.
- 반드시 오름차순이어야 하며, 같은 시각이 중복되면 안 됩니다.
- 번호는 위 목록과 1:1로 모두 대응되어야 합니다 (총 ${sentences.length}개).
- 대응하는 원어 발화를 그대로 옮겨 적어 근거를 남기세요.

## 출력 형식
JSON 배열만 출력하세요. 다른 설명은 금지합니다.
[{"index": 0, "start": 12.4, "source": "원어 발화 그대로", "text": "번역 문장 그대로"}, ...]`;

let text = "";
for (let attempt = 0; attempt <= 2; attempt++) {
  try {
    const response = await ai.models.generateContent({
      model: MODEL,
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: uri, mimeType } },
            { text: prompt },
          ],
        },
      ],
      config: {
        temperature: 0.1,
        maxOutputTokens: MAX_OUTPUT_TOKENS,
        thinkingConfig: { thinkingLevel: ThinkingLevel.HIGH },
      },
    });
    text = response.text?.trim() || "";
    if (text) break;
  } catch (err: any) {
    console.error(`  Error: ${err.message}. Retry ${attempt + 1}/2...`);
    await new Promise((r) => setTimeout(r, 3000));
  }
}

const jsonMatch = text.match(/\[[\s\S]*\]/);
if (!jsonMatch) {
  console.error("No JSON array in response:\n" + text);
  process.exit(1);
}

const raw: { index: number; start: number; source?: string; text: string }[] =
  JSON.parse(jsonMatch[0]);

const segments = raw
  .sort((a, b) => a.index - b.index)
  .map((r) => ({
    timestamp: Math.round(spec.clip_start + r.start),
    text: sentences[r.index] ?? r.text,
    source: r.source,
  }));

// Guard against a flat/non-monotonic alignment silently producing duplicate TCs
for (let i = 1; i < segments.length; i++) {
  if (segments[i].timestamp <= segments[i - 1].timestamp) {
    console.error(
      `WARNING: segment ${i} timestamp ${segments[i].timestamp} <= previous ${segments[i - 1].timestamp}`,
    );
  }
}
if (segments.length !== sentences.length) {
  console.error(
    `WARNING: got ${segments.length} segments for ${sentences.length} sentences`,
  );
}

console.log(JSON.stringify(segments, null, 2));
