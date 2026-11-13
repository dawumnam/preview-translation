// The watching step: each window of the video goes to the model, which
// returns the shots and the spoken turns of that window.
//
// CLI, for tests on a part of a video:
//   bun previewgen/gen.ts <video> --out <file.json> [--from s] [--to s] [--window 300]
//       [--model gemini-4-argon] [--thinking LOW|MEDIUM|HIGH] [--fps 1] [--res LOW|MEDIUM|HIGH]
//       [--about "<text>"] [--cast "<text>"] [--tag <name>]
//
// All windows go to the model at the same time. A window that is already in
// the output file with the same settings is not sent again.
import fs from "fs";
import path from "path";
import { decodeAudio, mediaDuration } from "../src/audio";
import { callJson, usageReport } from "../src/llm";
import { clipPart, makeClip } from "./clip";
import { detectCuts, loudness, planWindows, type PlannedWindow } from "./cuts";
import type { PreviewLine } from "./gt";
import { buildLogPrompt, LOG_SCHEMA, type RawWindow } from "./prompt";

export interface Person {
  label: string;
  look: string;
  role: string;
}

export interface WindowOut extends PlannedWindow {
  latencyMs: number;
  error?: string;
  people: Person[];
  lines: PreviewLine[];
}

export interface GenSettings {
  model: string;
  thinking: "LOW" | "MEDIUM" | "HIGH";
  /** Frames per second that the model looks at. */
  fps: number;
  /** Media resolution: LOW, MEDIUM or HIGH. */
  res: string;
  /** Target length of a window in seconds. */
  window: number;
  about: string;
  cast: string;
  /** Free text that makes two runs with the same settings different files. */
  tag: string;
  /** "shots": the model gets the picture with no sound and writes shot entries only. */
  only?: "shots";
}

export const DEFAULT_SETTINGS: GenSettings = { model: "gemini-4-argon", thinking: "LOW", fps: 1, res: "LOW", window: 300, about: "", cast: "", tag: "" };

export interface GenFile {
  media: string;
  settings: GenSettings;
  cuts: number[];
  windows: WindowOut[];
  usage?: unknown;
}

const LANG_CODE: Record<string, string> = { ka: "조", en: "영", ru: "러", de: "독", vi: "베" };

function clipSeconds(t: string): number | null {
  const p = t.trim().split(":").map((x) => parseFloat(x));
  if (p.length < 2 || p.length > 3 || p.some(Number.isNaN)) return null;
  return p.length === 3 ? p[0] * 3600 + p[1] * 60 + p[2] : p[0] * 60 + p[1];
}

/** Model lines of one window → preview lines with times from the start of the video. */
export function toPreviewLines(raw: RawWindow, start: number, end: number): PreviewLine[] {
  const out: PreviewLine[] = [];
  for (const l of raw.lines ?? []) {
    const rel = clipSeconds(l.t ?? "");
    if (rel === null) continue;
    const tc = Math.min(end, start + Math.max(0, rel));
    const text = (l.text ?? "").replace(/\s+/g, " ").trim();
    if (l.kind === "shot") {
      if (text) out.push({ tc, kind: "shot", text });
      continue;
    }
    const speaker = (l.speaker ?? "").trim() || "?";
    const lang = (l.lang ?? "").trim().toLowerCase();
    const use = l.use === "ask" || l.use === "direct" ? l.use : "take";
    if (lang && lang !== "ko") out.push({ tc, kind: "foreign", speaker, text: "", lang: LANG_CODE[lang] ?? "조", use });
    else if (text) out.push({ tc, kind: "speech", speaker, text, use });
  }
  // A stable sort: lines with the same second keep the order of the model.
  return out.map((l, i) => ({ l, i })).sort((a, b) => a.l.tc! - b.l.tc! || a.i - b.i).map((x) => x.l);
}

export interface Prepared {
  dur: number;
  cuts: number[];
  loud: Float32Array;
  step: number;
}
const prepared = new Map<string, Promise<Prepared>>();

/** Cut list and loudness of the video: made once, kept in `workDir`. */
export function prepare(media: string, workDir: string): Promise<Prepared> {
  const key = `${media}|${workDir}`;
  if (!prepared.has(key)) {
    prepared.set(
      key,
      (async () => {
        fs.mkdirSync(workDir, { recursive: true });
        const dur = await mediaDuration(media);
        const pcm = path.join(workDir, "audio.pcm");
        const [cuts] = await Promise.all([detectCuts(media, path.join(workDir, "cuts.json")), decodeAudio(media, pcm, dur)]);
        const step = 0.5;
        return { dur, cuts, loud: loudness(pcm, step), step };
      })(),
    );
  }
  return prepared.get(key)!;
}

/**
 * Plans the windows and sends each to the model. `workDir` holds the cut
 * list, the decoded sound and the clips. Windows that `have` already holds
 * are not sent again.
 */
export async function watch(media: string, workDir: string, s: GenSettings, from = 0, to = Infinity, have: WindowOut[] = []): Promise<{ cuts: number[]; windows: WindowOut[] }> {
  const { dur, cuts, loud, step } = await prepare(media, workDir);
  const plan = planWindows(dur, cuts, loud, step, s.window, from, Math.min(dur, to));
  const done = new Map(have.filter((w) => !w.error).map((w) => [`${w.start}-${w.end}`, w]));

  const windows = await Promise.all(
    plan.map(async (p): Promise<WindowOut> => {
      const old = done.get(`${p.start}-${p.end}`);
      if (old) return old;
      const clip = await makeClip(media, p.start, p.end, path.join(workDir, "clips"), { fps: Math.max(2, Math.ceil(s.fps) * 2), mode: s.only === "shots" ? "video" : "av", height: 270 });
      const prompt = buildLogPrompt({
        durationSec: p.end - p.start,
        cuts: p.cuts.map((c) => c - p.start),
        startsAtCut: p.startsAtCut,
        about: s.about || undefined,
        cast: s.cast || undefined,
        shotsOnly: s.only === "shots",
      });
      const r = await callJson<RawWindow>({
        model: s.model,
        parts: [clipPart(clip, s.fps), { text: prompt }],
        schema: LOG_SCHEMA,
        thinkingLevel: s.thinking,
        config: { mediaResolution: `MEDIA_RESOLUTION_${s.res}` },
        timeoutMs: 300_000,
        hedgeAfterMs: [90_000],
        attempts: 3,
        label: `window ${p.start}-${p.end}`,
      });
      const w: WindowOut = { ...p, latencyMs: Math.round(r.latencyMs), people: [], lines: [] };
      if (r.value) {
        w.people = (r.value.people ?? []).map((x) => ({ label: (x.label ?? "").trim(), look: x.look ?? "", role: x.role ?? "" }));
        w.lines = toPreviewLines(r.value, p.start, p.end);
      } else {
        w.error = r.blocked ? `blocked (${r.blocked})` : (r.error ?? "no answer");
      }
      console.error(`window ${p.start}-${p.end}: ${w.error ?? `${w.lines.length} lines`} in ${(w.latencyMs / 1000).toFixed(1)} s`);
      return w;
    }),
  );
  return { cuts, windows: windows.sort((a, b) => a.start - b.start) };
}

function arg(name: string, def?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : def;
}

async function main() {
  const media = process.argv[2];
  const outPath = arg("out");
  if (!media || media.startsWith("--") || !outPath) {
    console.error("Usage: bun previewgen/gen.ts <video> --out <file.json> [--from s] [--to s] [--window s] [--model m] [--thinking L] [--fps n] [--res L]");
    process.exit(1);
  }
  const settings: GenSettings = {
    model: arg("model", DEFAULT_SETTINGS.model)!,
    thinking: arg("thinking", DEFAULT_SETTINGS.thinking) as GenSettings["thinking"],
    fps: parseFloat(arg("fps", String(DEFAULT_SETTINGS.fps))!),
    res: arg("res", DEFAULT_SETTINGS.res)!,
    window: parseFloat(arg("window", String(DEFAULT_SETTINGS.window))!),
    about: arg("about", "")!,
    cast: arg("cast", "")!,
    tag: arg("tag", "")!,
    ...(arg("only") === "shots" ? { only: "shots" as const } : {}),
  };
  let have: WindowOut[] = [];
  if (fs.existsSync(outPath)) {
    const old = JSON.parse(fs.readFileSync(outPath, "utf-8")) as GenFile;
    if (JSON.stringify(old.settings) === JSON.stringify(settings) && old.media === media) have = old.windows;
  }
  const t0 = performance.now();
  // Clips, cuts and sound are the same for all runs on one video: one directory for each video.
  const workDir = path.join(path.dirname(outPath), `${path.basename(media).replace(/\.[^.]+$/, "")}_media`);
  // --ranges 820-1120,2850-3150 : several stretches in one run.
  const ranges: [number, number][] = arg("ranges")
    ? arg("ranges")!.split(",").map((r) => r.split("-").map(parseFloat) as [number, number])
    : [[parseFloat(arg("from", "0")!), parseFloat(arg("to", "Infinity")!)]];
  const parts = await Promise.all(ranges.map(([a, b]) => watch(media, workDir, settings, a, b, have)));
  const cuts = parts[0].cuts;
  const windows = parts.flatMap((p) => p.windows).sort((a, b) => a.start - b.start);
  const file: GenFile = { media, settings, cuts, windows, usage: usageReport() };
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(file, null, 1));
  console.error(`${windows.length} windows in ${((performance.now() - t0) / 1000).toFixed(1)} s → ${outPath}`);
  console.error(JSON.stringify(file.usage));
  if (windows.some((w) => w.error)) process.exit(1);
}

if (import.meta.main) await main();
