// A stretch of the video as a small mp4 for the model.
//
// The model looks at about one frame per second and listens at 16 kHz mono,
// so the clip is encoded for that: few frames, low bit rate. A 5-minute clip
// is 2 to 4 MB and goes inline in the request, with no upload step.
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface ClipOptions {
  /** Frames per second in the file. The model samples at `sampleFps` (see gen.ts). */
  fps: number;
  /** "av" = picture and sound, "video" = picture only, "audio" = sound only (a WAV file). */
  mode: "av" | "video" | "audio";
  /** Height of the picture in pixels after the black bars are cut off. */
  height: number;
}

export const DEFAULT_CLIP: ClipOptions = { fps: 4, mode: "av", height: 270 };

/** Writes the clip to `dir` (skipped when it is already there) and returns its path. */
export async function makeClip(media: string, start: number, end: number, dir: string, o: ClipOptions = DEFAULT_CLIP): Promise<string> {
  fs.mkdirSync(dir, { recursive: true });
  const ext = o.mode === "audio" ? "wav" : "mp4";
  const out = path.join(dir, `${Math.round(start * 10)}_${Math.round(end * 10)}_${o.mode}_${o.fps}_${o.height}.${ext}`);
  if (fs.existsSync(out) && fs.statSync(out).size > 1000) return out;
  const tmp = `${out}.part.${ext}`;
  const args = ["-v", "error", "-y", "-ss", String(start), "-t", String(end - start), "-i", media];
  if (o.mode === "audio") {
    args.push("-vn", "-ac", "1", "-ar", "16000", "-c:a", "pcm_s16le");
  } else {
    // The proxies are 480x320 with black bars above and below a 16:9 picture.
    args.push(
      "-vf", `crop=iw:iw*9/16,scale=-2:${o.height},fps=${o.fps}`,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "28", "-g", String(o.fps * 2), "-pix_fmt", "yuv420p",
    );
    if (o.mode === "av") args.push("-ac", "1", "-ar", "16000", "-c:a", "aac", "-b:a", "64k");
    else args.push("-an");
    args.push("-movflags", "+faststart");
  }
  args.push(tmp);
  await execFileAsync("ffmpeg", args, { maxBuffer: 1 << 20 });
  fs.renameSync(tmp, out);
  return out;
}

/** A Gemini inline part for the clip. `sampleFps` sets how many frames per second the model looks at. */
export function clipPart(file: string, sampleFps?: number) {
  const mimeType = file.endsWith(".wav") ? "audio/wav" : "video/mp4";
  const part: any = { inlineData: { mimeType, data: fs.readFileSync(file).toString("base64") } };
  if (mimeType === "video/mp4" && sampleFps) part.videoMetadata = { fps: sampleFps };
  return part;
}
