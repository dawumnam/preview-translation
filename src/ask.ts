import { parseArgs } from "util";
import { getGeminiClient, uploadMedia } from "./gemini";

const { values } = parseArgs({
  args: process.argv.slice(2),
  options: {
    uri: { type: "string" },
    file: { type: "string" },
    model: { type: "string", default: "gemini-3.5-flash" },
  },
  strict: true,
});

if (!values.uri && !values.file) {
  console.error(
    "Usage: echo PROMPT | bun src/ask.ts --uri <URI> | --file <path> [--model <model>]",
  );
  process.exit(1);
}

const prompt = await Bun.stdin.text();
if (!prompt.trim()) {
  console.error("Error: no prompt provided on stdin");
  process.exit(1);
}

const ai = getGeminiClient();

let fileUri: string;
let mimeType: string;

if (values.file) {
  const result = await uploadMedia(ai, values.file);
  fileUri = result.uri;
  mimeType = result.mimeType;
  console.error(`Uploaded: ${fileUri}`);
} else {
  fileUri = values.uri!;
  const name = fileUri.replace(
    "https://generativelanguage.googleapis.com/v1beta/",
    "",
  );
  const file = await ai.files.get({ name });
  mimeType = file.mimeType || "audio/mpeg";
}

const response = await ai.models.generateContent({
  model: values.model!,
  contents: [
    {
      role: "user",
      parts: [
        { fileData: { fileUri, mimeType } },
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
console.log(text);
