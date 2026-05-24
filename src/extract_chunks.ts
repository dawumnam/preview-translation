import { execSync } from "child_process";
import fs from "fs";
import path from "path";
import { getGeminiClient, uploadMedia } from "./gemini";

const planPath = process.argv[2];
if (!planPath) {
  console.error("Usage: bun src/extract_chunks.ts <chunks_plan.json>");
  process.exit(1);
}

const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const baseDir = path.dirname(path.resolve(plan.hwpx_path));
const mp3Path = path.resolve(plan.mp3_path);

if (!fs.existsSync(mp3Path)) {
  console.error(`Audio file not found: ${mp3Path}`);
  process.exit(1);
}

// Create chunks directory
const chunksDir = path.join(baseDir, "chunks");
if (!fs.existsSync(chunksDir)) {
  fs.mkdirSync(chunksDir);
}

const ai = getGeminiClient();

// Extract and upload each chunk
for (let i = 0; i < plan.chunks.length; i++) {
  const chunk = plan.chunks[i];
  const chunkFile = path.join(chunksDir, `${chunk.chunk_id}.mp3`);

  // Skip if chunk already extracted and uploaded
  if (fs.existsSync(chunkFile) && fs.statSync(chunkFile).size > 1000 && chunk.uri) {
    console.error(
      `[${i + 1}/${plan.chunks.length}] ${chunk.chunk_id} — already done, skipping`,
    );
    continue;
  }

  // Extract audio segment (skip if file already exists)
  if (!fs.existsSync(chunkFile) || fs.statSync(chunkFile).size <= 1000) {
    console.error(
      `[${i + 1}/${plan.chunks.length}] Extracting ${chunk.chunk_id} (${chunk.scene})...`,
    );

    const copyFlag = mp3Path.endsWith(".mp4") ? "-vn -acodec libmp3lame" : "-c copy";
    execSync(
      `ffmpeg -y -i "${mp3Path}" -ss ${chunk.audio_start} -to ${chunk.audio_end} ${copyFlag} "${chunkFile}" 2>/dev/null`,
    );
  } else {
    console.error(
      `[${i + 1}/${plan.chunks.length}] ${chunk.chunk_id} — file exists, uploading...`,
    );
  }

  // Upload to Gemini
  console.error(`  Uploading...`);
  const result = await uploadMedia(ai, chunkFile);
  chunk.uri = result.uri;
  chunk.mimeType = result.mimeType;
  console.error(`  → ${result.uri}`);

  // Rate limit between uploads
  if (i < plan.chunks.length - 1) {
    await new Promise((r) => setTimeout(r, 1000));
  }
}

const outPath = path.join(baseDir, "chunks_uploaded.json");
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf-8");
console.error(`\nWrote ${outPath}`);
