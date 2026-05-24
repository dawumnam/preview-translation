import { parseArgs } from "util";
import fs from "fs";
import path from "path";
import { extractHwpx, repackHwpx } from "./hwpx";
import { parseMarkers, formatTimestamp } from "./parser";
import { getGeminiClient, uploadMedia } from "./gemini";
import { translateScenes } from "./translate";
import { replaceMarkers } from "./replace";

async function main() {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      media: { type: "string" },
      uri: { type: "string" },
    },
    strict: true,
    allowPositionals: true,
  });

  const hwpxPath = positionals[0];
  if (!hwpxPath) {
    console.error(
      "Usage: bun run src/index.ts <hwpx-file> --media <file> | --uri <uri>",
    );
    process.exit(1);
  }

  if (!values.media && !values.uri) {
    console.error("Must provide --media <file> or --uri <gemini-uri>");
    process.exit(1);
  }

  // Step 1: Extract HWPX
  console.log("Extracting HWPX...");
  const hwpx = extractHwpx(hwpxPath);

  // Step 2: Parse markers
  console.log("Parsing markers...");
  const { markers, scenes } = parseMarkers(hwpx.xml, hwpx.boldIds);
  console.log(
    `Found ${markers.length} bold+blue markers in ${scenes.length} scenes`,
  );

  for (const scene of scenes) {
    console.log(
      `  ${scene.name}: ${scene.markers.length} markers (${formatTimestamp(scene.startTime)}-${formatTimestamp(scene.endTime)})`,
    );
  }

  // Step 3: Get media URI
  const ai = getGeminiClient();
  let fileUri: string;
  let mimeType: string;

  if (values.uri) {
    fileUri = values.uri;
    mimeType = "video/mp4";
    console.log(`Using provided URI: ${fileUri}`);
  } else {
    console.log(`Uploading media: ${values.media}...`);
    const result = await uploadMedia(ai, values.media!);
    fileUri = result.uri;
    mimeType = result.mimeType;
    console.log(`Upload complete. URI: ${fileUri}`);
    console.log(`(Reuse with: --uri "${fileUri}")`);
  }

  // Step 4: Translate
  console.log("Translating...");
  const translations = await translateScenes(ai, scenes, fileUri, mimeType);

  // Step 5: Save translations JSON
  const baseName = path.basename(hwpxPath, path.extname(hwpxPath));
  const dir = path.dirname(hwpxPath);
  const jsonPath = path.join(dir, `${baseName}_translations.json`);
  fs.writeFileSync(jsonPath, JSON.stringify(translations, null, 2), "utf-8");
  console.log(`Translations saved to: ${jsonPath}`);

  // Step 6: Replace markers in XML
  console.log("Replacing markers...");
  const newXml = replaceMarkers(hwpx.xml, translations, hwpx.boldIds);

  // Step 7: Repack HWPX
  const outPath = repackHwpx(hwpx, newXml);
  console.log(`Translated HWPX saved to: ${outPath}`);

  // Summary
  const lowConfidence = translations.filter(
    (t) => t.confidence === "low",
  ).length;
  console.log(`\nDone! ${translations.length} markers translated.`);
  if (lowConfidence > 0) {
    console.log(
      `Warning: ${lowConfidence} low-confidence translations marked with ?? (search for ?? in document)`,
    );
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
