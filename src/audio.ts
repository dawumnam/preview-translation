// Audio access for the listening steps.
//
// The whole soundtrack is decoded once to 16 kHz mono PCM (Gemini listens at
// 16 kHz mono in any case). ffmpeg does this in about 3 s for a 2-hour mp4.
// After that a window is a byte range of the PCM file with a WAV header in
// front of it: no ffmpeg job for each clip, no upload step, no file to expire.
import { execFile } from "child_process";
import fs from "fs";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export const SAMPLE_RATE = 16000;
const BYTES_PER_SEC = SAMPLE_RATE * 2; // 16-bit mono

/** Length of the media in seconds. */
export async function mediaDuration(media: string): Promise<number> {
  const { stdout } = await execFileAsync("ffprobe", [
    "-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", media,
  ]);
  const sec = parseFloat(stdout);
  if (!Number.isFinite(sec)) throw new Error(`ffprobe gave no duration for ${media}`);
  return sec;
}

/** Decodes the soundtrack to raw PCM at `pcmPath`. Skips the work when the file is already complete. */
export async function decodeAudio(media: string, pcmPath: string, durationSec: number): Promise<void> {
  const want = Math.floor(durationSec) * BYTES_PER_SEC;
  if (fs.existsSync(pcmPath) && fs.statSync(pcmPath).size >= want * 0.99) return;
  const tmp = `${pcmPath}.part`;
  await execFileAsync(
    "ffmpeg",
    ["-v", "error", "-y", "-i", media, "-vn", "-ac", "1", "-ar", String(SAMPLE_RATE), "-f", "s16le", "-c:a", "pcm_s16le", tmp],
    { maxBuffer: 1 << 20 },
  );
  fs.renameSync(tmp, pcmPath);
}

function wavHeader(dataBytes: number): Buffer {
  const h = Buffer.alloc(44);
  h.write("RIFF", 0);
  h.writeUInt32LE(36 + dataBytes, 4);
  h.write("WAVE", 8);
  h.write("fmt ", 12);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20); // PCM
  h.writeUInt16LE(1, 22); // mono
  h.writeUInt32LE(SAMPLE_RATE, 24);
  h.writeUInt32LE(BYTES_PER_SEC, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write("data", 36);
  h.writeUInt32LE(dataBytes, 40);
  return h;
}

/** The audio from `start` to `end` (seconds) as a WAV file in memory. */
export function sliceWav(pcmPath: string, start: number, end: number): Buffer {
  const from = Math.max(0, Math.floor(start * SAMPLE_RATE)) * 2;
  const size = fs.statSync(pcmPath).size;
  const to = Math.min(size, Math.ceil(end * SAMPLE_RATE) * 2);
  const len = Math.max(0, to - from);
  const data = Buffer.alloc(len);
  const fd = fs.openSync(pcmPath, "r");
  try {
    fs.readSync(fd, data, 0, len, from);
  } finally {
    fs.closeSync(fd);
  }
  return Buffer.concat([wavHeader(len), data]);
}

/** A Gemini inline audio part for the range. */
export function audioPart(pcmPath: string, start: number, end: number) {
  return { inlineData: { mimeType: "audio/wav", data: sliceWav(pcmPath, start, end).toString("base64") } };
}
