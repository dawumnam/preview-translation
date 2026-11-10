import { execFile } from "child_process";
import fs from "fs";
import os from "os";
import path from "path";
import { promisify } from "util";
import { getGeminiClient, uploadMedia } from "./gemini";

const execFileAsync = promisify(execFile);

const planPath = process.argv[2];
if (!planPath) {
  console.error("Usage: bun src/extract_chunks.ts <chunks_plan.json | chunks_uploaded.json>");
  process.exit(1);
}

// All chunks are extracted and uploaded at the same time, up to this many at
// once. ffmpeg is CPU-bound, so the default is one job per core.
const CONCURRENCY =
  parseInt(process.env.EXTRACT_CONCURRENCY || "", 10) || os.cpus().length;
const UPLOAD_ATTEMPTS = 3;

const plan = JSON.parse(fs.readFileSync(planPath, "utf-8"));
const baseDir = path.dirname(path.resolve(plan.hwpx_path));
const mp3Path = path.resolve(plan.mp3_path);

if (!fs.existsSync(mp3Path)) {
  console.error(`Audio file not found: ${mp3Path}`);
  process.exit(1);
}

const chunksDir = path.join(baseDir, "chunks");
if (!fs.existsSync(chunksDir)) fs.mkdirSync(chunksDir);

const ai = getGeminiClient();
const total = plan.chunks.length;

async function pool<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) await fn(items[next++]);
  });
  await Promise.all(workers);
}

async function extractAndUpload(chunk: any): Promise<void> {
  const tag = `[${chunk.chunk_id}]`;
  const chunkFile = path.join(chunksDir, `${chunk.chunk_id}.mp3`);
  const haveFile = fs.existsSync(chunkFile) && fs.statSync(chunkFile).size > 1000;

  if (haveFile && chunk.uri) {
    console.error(`${tag} already extracted and uploaded, skipping`);
    return;
  }

  if (!haveFile) {
    console.error(`${tag} extracting ${chunk.audio_start}-${chunk.audio_end}s (${chunk.scene})`);
    // -ss before -i seeks in the container instead of decoding everything up to
    // the start point, which on a 4-hour mp4 is the difference between seconds
    // and minutes per chunk. Seeking stays sample-accurate because the audio is
    // re-encoded. Write to a temp name so an interrupted run never leaves a
    // short file that a later run would take as complete.
    const tmp = `${chunkFile}.part.mp3`;
    const codec = mp3Path.endsWith(".mp4") ? ["-vn", "-acodec", "libmp3lame"] : ["-c", "copy"];
    await execFileAsync("ffmpeg", [
      "-v", "error", "-y",
      "-ss", String(chunk.audio_start),
      "-i", mp3Path,
      "-t", String(chunk.audio_end - chunk.audio_start),
      ...codec,
      tmp,
    ]);
    fs.renameSync(tmp, chunkFile);
  }

  for (let attempt = 1; ; attempt++) {
    try {
      const result = await uploadMedia(ai, chunkFile);
      chunk.uri = result.uri;
      chunk.mimeType = result.mimeType;
      console.error(`${tag} uploaded → ${result.uri}`);
      return;
    } catch (err: any) {
      if (attempt >= UPLOAD_ATTEMPTS) throw err;
      console.error(`${tag} upload failed (${err.message}), retry ${attempt}/${UPLOAD_ATTEMPTS - 1}`);
      await new Promise((r) => setTimeout(r, 3000 * attempt));
    }
  }
}

console.error(`Extracting/uploading ${total} chunks, ${Math.min(CONCURRENCY, total)} at a time`);
const failed: string[] = [];
await pool(plan.chunks, CONCURRENCY, async (chunk: any) => {
  try {
    await extractAndUpload(chunk);
  } catch (err: any) {
    failed.push(chunk.chunk_id);
    console.error(`[${chunk.chunk_id}] FAILED: ${err.message}`);
  }
});

// Written even when some chunks failed, so a re-run only redoes those.
const outPath = path.join(baseDir, "chunks_uploaded.json");
fs.writeFileSync(outPath, JSON.stringify(plan, null, 2), "utf-8");
console.error(`\nWrote ${outPath}`);
if (failed.length) {
  console.error(`${failed.length} chunk(s) failed: ${failed.join(", ")} — run the command again to retry them`);
  process.exit(1);
}
