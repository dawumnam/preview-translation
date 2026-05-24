import { GoogleGenAI } from "@google/genai";
import path from "path";

const MIME_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".m4a": "audio/mp4",
  ".webm": "video/webm",
};

export function getGeminiClient(): GoogleGenAI {
  const apiKey = process.env.GEMINI_API_KEY;
  if (!apiKey) throw new Error("GEMINI_API_KEY not set in .env");
  return new GoogleGenAI({ apiKey });
}

export async function uploadMedia(
  ai: GoogleGenAI,
  filePath: string,
): Promise<{ uri: string; mimeType: string }> {
  const ext = path.extname(filePath).toLowerCase();
  const mimeType = MIME_TYPES[ext] || "application/octet-stream";

  console.log(`  Uploading ${path.basename(filePath)} (${mimeType})...`);

  const uploadResult = await ai.files.upload({
    file: filePath,
    config: { mimeType },
  });

  const name = uploadResult.name!;
  console.log(`  File name: ${name}`);
  console.log(`  Waiting for processing...`);

  let file = await ai.files.get({ name });
  while (file.state === "PROCESSING") {
    await new Promise((r) => setTimeout(r, 5000));
    process.stdout.write(".");
    file = await ai.files.get({ name });
  }
  console.log();

  if (file.state !== "ACTIVE") {
    throw new Error(`File processing failed: state=${file.state}`);
  }

  return { uri: file.uri!, mimeType };
}
