import type { GoogleGenAI } from "@google/genai";
import type { SceneChunk } from "./parser";
import { formatTimestamp } from "./parser";

export interface TranslationSegment {
  timestamp: number; // seconds from start of audio, from the STT block where this part begins
  text: string;
}

export interface Translation {
  markerIndex: number;
  language: string;
  charName: string;
  timestamp: number;
  scene: string;
  translation?: string; // legacy single-block format
  segments?: TranslationSegment[]; // split format: long speech broken at sentence/topic boundaries
  confidence: "high" | "medium" | "low";
}

const MODEL = "gemini-3.5-flash";

function buildPrompt(scene: SceneChunk): string {
  const markerList = scene.markers
    .map((m, i) => {
      const ts = formatTimestamp(m.timestamp);
      const endTs = m.endTimestamp
        ? ` to ${formatTimestamp(m.endTimestamp)}`
        : "";
      const lang = m.language;
      const hint = m.hint ? ` (hint: "${m.hint}")` : "";
      return `  ${i}. [${ts}${endTs}] Character "${m.charName}" speaking ${lang}${hint}`;
    })
    .join("\n");

  const contextLines = scene.context
    .slice(0, 50)
    .map((l) => `  ${l}`)
    .join("\n");

  return `You are a professional translator helping translate a Korean travel/variety show production script.

## Task
Listen to the audio/video at the specified timestamps and translate what the characters say into Korean.

## Scene: "${scene.name}"
Time range: ${formatTimestamp(scene.startTime)} - ${formatTimestamp(scene.endTime)}

## Markers to translate
${markerList}

## Surrounding Korean dialogue for context
${contextLines}

## Instructions
- For each marker, listen to the audio at the given timestamp
- The character is speaking in the specified foreign language (English, German, or Austrian German)
- Translate what they say into natural Korean (\uD55C\uAD6D\uC5B4)
- If the hint text is provided, it may give a rough idea of what's being said - use it as guidance
- If you cannot clearly hear the speech at a timestamp, provide your best guess and mark confidence as "low"
- Keep translations natural and conversational, matching the tone of a variety show

## Response format
Respond with a JSON array. Each element:
{
  "index": <marker index from the list above>,
  "translation": "<Korean translation>",
  "confidence": "high" | "medium" | "low"
}

Respond ONLY with the JSON array, no other text.`;
}

async function callGemini(
  ai: GoogleGenAI,
  fileUri: string,
  mimeType: string,
  scene: SceneChunk,
): Promise<Translation[]> {
  const prompt = buildPrompt(scene);
  const startSec = Math.max(0, scene.startTime - 15);
  const endSec = scene.endTime + 15;

  const response = await ai.models.generateContent({
    model: MODEL,
    contents: [
      {
        role: "user",
        parts: [
          {
            fileData: { fileUri, mimeType },
            videoMetadata: {
              startOffset: { seconds: startSec },
              endOffset: { seconds: endSec },
            },
          } as any,
          { text: prompt },
        ],
      },
    ],
    config: {
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: "HIGH" },
    },
  });

  const text = response.text?.trim() || "";

  // Strip markdown fences if present
  const jsonStr = text
    .replace(/^```json?\s*\n?/, "")
    .replace(/\n?```\s*$/, "");

  let results: Array<{
    index: number;
    translation: string;
    confidence: string;
  }>;
  try {
    results = JSON.parse(jsonStr);
  } catch {
    console.error(`  Failed to parse response for scene "${scene.name}":`);
    console.error(`  ${text.slice(0, 300)}`);
    return [];
  }

  return results
    .map((r): Translation | null => {
      const marker = scene.markers[r.index];
      if (!marker) {
        console.warn(
          `  Warning: unknown marker index ${r.index} in scene "${scene.name}"`,
        );
        return null;
      }
      return {
        markerIndex: marker.index,
        language: marker.language,
        charName: marker.charName,
        timestamp: marker.timestamp,
        scene: scene.name,
        translation: r.translation,
        confidence: (r.confidence as "high" | "medium" | "low") || "medium",
      };
    })
    .filter((t): t is Translation => t !== null);
}

export async function translateScenes(
  ai: GoogleGenAI,
  scenes: SceneChunk[],
  fileUri: string,
  mimeType: string,
): Promise<Translation[]> {
  const allTranslations: Translation[] = [];

  for (let i = 0; i < scenes.length; i++) {
    const scene = scenes[i];
    console.log(
      `  [${i + 1}/${scenes.length}] Scene "${scene.name}" (${scene.markers.length} markers)...`,
    );

    let translations: Translation[] = [];
    let retries = 0;
    const maxRetries = 1;

    while (retries <= maxRetries) {
      try {
        translations = await callGemini(ai, fileUri, mimeType, scene);
        break;
      } catch (err: any) {
        if (err?.status === 429 || err?.message?.includes("429")) {
          const backoff = Math.pow(2, retries + 1) * 2000;
          console.log(`  Rate limited. Waiting ${backoff / 1000}s...`);
          await new Promise((r) => setTimeout(r, backoff));
          retries++;
        } else if (retries < maxRetries) {
          console.error(`  Error: ${err.message}. Retrying...`);
          retries++;
          await new Promise((r) => setTimeout(r, 2000));
        } else {
          console.error(
            `  Failed after ${maxRetries + 1} attempts: ${err.message}`,
          );
          break;
        }
      }
    }

    console.log(
      `    Got ${translations.length}/${scene.markers.length} translations`,
    );
    allTranslations.push(...translations);

    // Rate limiting between calls
    if (i < scenes.length - 1) {
      await new Promise((r) => setTimeout(r, 2000));
    }
  }

  return allTranslations;
}
