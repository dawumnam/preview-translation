// One episode, end to end: script + video → translated HWPX.
//
//   parse the script into a timeline      (script.ts)
//   decode the soundtrack once            (audio.ts)        ┐ at the same time
//   write the episode brief               (brief.ts)        ┘
//   listen: two full passes, all windows at once (listen.ts)
//   compare the passes                    (reconcile.ts)
//   three focused listens of the lines where the passes differ
//   write translations.json, apply, verify
//
// Nothing here waits for a person or for an agent. The slowest single model
// call sets the run time.
import { execFile } from "child_process";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { decodeAudio, mediaDuration } from "./audio";
import { briefText, makeBrief, type Brief } from "./brief";
import { extractHwpx, repackHwpx } from "./hwpx";
import { listenPass, type Candidate, type ListenResult, type PassConfig } from "./listen";
import { consensus, firstRound, type Decision } from "./reconcile";
import { replaceMarkers, type Translation } from "./replace";
import { clock, parseScript, type ScriptLine } from "./script";
import { DEFAULT_WINDOW, planWindows, type ListenWindow } from "./windows";

const execFileAsync = promisify(execFile);
const ROOT = path.resolve(import.meta.dir, "..");

export const MODELS = {
  // Gemini 4 Argon hears Georgian as well as Gemini 3.8 Flash at HIGH thinking
  // (0.90 against 0.89 on the blind benchmark) and answers in 8 s instead of
  // 34 s, with no thinking tokens to pay for.
  listen: process.env.LISTEN_MODEL || "gemini-4-argon",
  fallback: process.env.FALLBACK_MODEL || "gemini-3.8-flash",
  judge: process.env.JUDGE_MODEL || "gemini-3.8-flash",
};

export interface EpisodeOptions {
  /** The script as delivered: .hwp or .hwpx. */
  script: string;
  /** The video or audio file. */
  media: string;
  /** Where intermediate files go. Default: <script dir>/<id>_work. */
  workDir?: string;
  /** Ignore saved passes and listen again. */
  fresh?: boolean;
  /** Keep the decoded audio after the run. */
  keepAudio?: boolean;
  /** Tests only: script lines whose Korean text is hidden from the model. */
  mask?: (lines: ScriptLine[]) => Set<number>;
  log?: (msg: string) => void;
}

export interface EpisodeReport {
  id: string;
  output: string;
  workDir: string;
  markers: number;
  unrequested: number;
  windows: { a: number; b: number; c: number };
  confidence: { high: number; medium: number; low: number };
  flagged: { marker: number; speaker: string; tc: string; reason: string; text: string }[];
  billableSec: number;
  billableLowSec: number;
  seconds: Record<string, number>;
  verify: "OK" | "FAILED";
  verifyOutput: string;
  problems: string[];
}

/** A short ASCII name for the work directory: the date digits in the file name when it has them. */
function episodeId(script: string): string {
  const stem = path.basename(script, path.extname(script));
  const digits = stem.match(/\d{4}/);
  if (digits) return digits[0];
  const ascii = stem.replace(/[^A-Za-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return ascii || "episode";
}

/**
 * <script dir>/<id>_work, or <id>_2_work and so on when that directory belongs
 * to another script (two scripts of the same day in one folder).
 */
function freeWorkDir(scriptPath: string, id: string): string {
  for (let n = 1; ; n++) {
    const dir = path.join(path.dirname(scriptPath), `${id}${n > 1 ? `_${n}` : ""}_work`);
    const meta = path.join(dir, "episode.json");
    if (!fs.existsSync(meta)) return dir;
    try {
      if (JSON.parse(fs.readFileSync(meta, "utf-8")).script === scriptPath) return dir;
    } catch {
      return dir;
    }
  }
}

// The model's text goes into the document verbatim, so it must be plain text:
// replace.ts escapes on insert, and editors do not want " / " joins.
function cleanText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+\/\s+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function unionSeconds(spans: [number, number][]): number {
  const s = spans.filter(([a, b]) => b > a).sort((x, y) => x[0] - y[0]);
  let total = 0;
  let cur: [number, number] | null = null;
  for (const [a, b] of s) {
    if (!cur) cur = [a, b];
    else if (a <= cur[1]) cur[1] = Math.max(cur[1], b);
    else {
      total += cur[1] - cur[0];
      cur = [a, b];
    }
  }
  return Math.round((cur ? total + cur[1] - cur[0] : total) * 10) / 10;
}

const byMarker = (cs: Candidate[]) => new Map(cs.map((c) => [c.marker, c]));

export async function runEpisode(o: EpisodeOptions): Promise<EpisodeReport> {
  const id = episodeId(o.script);
  const log = o.log ?? ((m: string) => console.error(`[${id}] ${m}`));
  const scriptPath = path.resolve(o.script);
  const mediaPath = path.resolve(o.media);
  const workDir = path.resolve(o.workDir ?? freeWorkDir(scriptPath, id));
  fs.mkdirSync(workDir, { recursive: true });
  const seconds: Record<string, number> = {};
  const problems: string[] = [];
  const t0 = performance.now();
  const timed = async <T>(name: string, fn: () => Promise<T>): Promise<T> => {
    const t = performance.now();
    try {
      return await fn();
    } finally {
      seconds[name] = Math.round((performance.now() - t) / 100) / 10;
    }
  };
  const saved = <T>(file: string): T | null => {
    const p = path.join(workDir, file);
    if (o.fresh || !fs.existsSync(p)) return null;
    try {
      return JSON.parse(fs.readFileSync(p, "utf-8")) as T;
    } catch {
      return null;
    }
  };
  const save = (file: string, data: unknown) => {
    const p = path.join(workDir, file);
    fs.writeFileSync(`${p}.tmp`, JSON.stringify(data, null, 1));
    fs.renameSync(`${p}.tmp`, p);
  };

  // --- Script: a working copy as <id>.hwpx (converted when it came as .hwp).
  const hwpxPath = path.join(workDir, `${id}.hwpx`);
  await timed("convert", async () => {
    const srcTime = fs.statSync(scriptPath).mtimeMs;
    if (fs.existsSync(hwpxPath) && fs.statSync(hwpxPath).mtimeMs >= srcTime) return;
    if (path.extname(scriptPath).toLowerCase() === ".hwp") {
      await execFileAsync(path.join(ROOT, "tools/hwp2hwpx/convert.sh"), [scriptPath, hwpxPath]);
    } else {
      fs.copyFileSync(scriptPath, hwpxPath);
    }
  });
  const stem = path.basename(scriptPath, path.extname(scriptPath));
  const output = path.join(path.dirname(scriptPath), `${stem}_translated.hwpx`);
  // What fix.ts and relisten.ts need to find their way back.
  save("episode.json", { id, script: scriptPath, media: mediaPath, hwpx: hwpxPath, output });
  const hwpx = extractHwpx(hwpxPath);
  const { lines, markers } = parseScript(hwpx.xml, hwpx.boldIds);
  const unrequested = lines.filter((l) => l.kind === "unrequested").length;
  if (markers.length === 0) throw new Error(`${path.basename(scriptPath)}: no bold @@ marker found`);
  const suspect = lines.filter((l) => l.tcSuspect !== undefined && l.kind === "marker");
  for (const l of suspect) {
    log(`marker ${l.marker!.index} has a TC out of sequence (${clock(l.tcSuspect!)}); it is placed between ${clock(l.tcPrev)} and ${Number.isFinite(l.tcNext) ? clock(l.tcNext) : "the end"}`);
  }
  log(`${markers.length} bold markers, ${unrequested} non-bold @@ lines left as they are`);

  // --- Audio and brief, at the same time.
  const pcm = path.join(workDir, "audio.pcm");
  let mediaDur = 0;
  let brief: Brief | null = null;
  await Promise.all([
    timed("decode", async () => {
      mediaDur = await mediaDuration(mediaPath);
      await decodeAudio(mediaPath, pcm, mediaDur);
    }),
    timed("brief", async () => {
      brief = saved<Brief>("brief.json") ?? (await makeBrief(lines, MODELS.listen)) ?? (await makeBrief(lines, MODELS.fallback));
      if (brief) save("brief.json", brief);
      else problems.push("no episode brief: names may be spelled differently from the script");
    }),
  ]);
  const late = lines.filter((l) => l.kind === "marker" && l.tcPrev > mediaDur);
  for (const l of late) problems.push(`marker ${l.marker!.index}: TC ${clock(l.tcPrev)} is past the end of the media (${clock(mediaDur)})`);

  const po = { brief: briefText(brief), mask: o.mask?.(lines) };
  const base = { ...DEFAULT_WINDOW, mediaDur };
  // The two passes cut the audio differently, so a line near a window edge in
  // one pass is in the middle of a window in the other.
  const windowsA = planWindows(lines, base, undefined, undefined, "a");
  const windowsB = planWindows(lines, { ...base, pre: 12, post: 10, maxLen: 60 }, undefined, undefined, "b");
  const passA: PassConfig = { name: "A", model: MODELS.listen, thinkingLevel: "MEDIUM", fallbackModel: MODELS.fallback };
  const passB: PassConfig = { ...passA, name: "B" };

  let done = 0;
  const totalWindows = windowsA.length + windowsB.length;
  const tick = () => {
    done++;
    if (done % 20 === 0 || done === totalWindows) log(`listening: ${done}/${totalWindows} windows`);
  };
  const runPass = async (cfg: PassConfig, windows: ListenWindow[], file: string): Promise<ListenResult> => {
    const old = saved<ListenResult>(file);
    if (old && markers.every((m) => old.candidates.some((c) => c.marker === m.index)) && old.failed.length === 0) {
      for (const _ of windows) tick();
      return old;
    }
    const r = await listenPass(cfg, windows, pcm, po, mediaDur, tick);
    save(file, r);
    return r;
  };
  const [ra, rb] = await timed("listen", () =>
    Promise.all([runPass(passA, windowsA, "pass_a.json"), runPass(passB, windowsB, "pass_b.json")]),
  );
  for (const r of [ra, rb]) for (const f of r.failed) problems.push(`window ${f.window}: ${f.reason}`);
  const a = byMarker(ra.candidates);
  const b = byMarker(rb.candidates);

  // --- Decide. Where the passes differ, listen a third time with a close look.
  const order = markers.map((m) => m.index);
  const first = await timed("compare", () => firstRound(a, b, order, MODELS.judge));
  const open = order.filter((m) => !first.get(m));
  let windowsC: ListenWindow[] = [];
  let focusedListens: Map<number, Candidate>[] = [];
  const decisions = new Map<number, Decision>();
  for (const m of order) if (first.get(m)) decisions.set(m, first.get(m)!);
  if (open.length) {
    const known = new Map(
      [...decisions.values()].filter((d) => d.pick).map((d) => [d.marker, { ko: d.pick!.ko, start: d.pick!.start, end: d.pick!.end }]),
    );
    // Cover what each pass pointed at, so the focused listens can hear both readings.
    windowsC = planWindows(
      lines,
      { ...base, pre: 6, post: 10, maxLen: 60 },
      new Set(open),
      (m, [lo, hi]) => {
        const spans = [a.get(m), b.get(m)].filter((c) => c?.heard) as Candidate[];
        return [Math.min(lo, ...spans.map((c) => c.start - 5)), Math.max(hi, ...spans.map((c) => c.end + 5))];
      },
      "c",
    );
    // More thinking did not make the model hear better (Argon low/medium/high:
    // 0.90/0.89/0.91 on the benchmark), so the focused listens keep the
    // level of the passes. What they add is a closer window, the settled
    // neighbours as fixed points, and three more independent hearings.
    const rcs = await timed("focused", () =>
      Promise.all(
        ["C1", "C2", "C3"].map(async (name) => {
          const file = `pass_${name.toLowerCase()}.json`;
          const old = saved<ListenResult>(file);
          if (old && open.every((m) => old.candidates.some((c) => c.marker === m)) && old.failed.length === 0) return old;
          const r = await listenPass({ ...passA, name }, windowsC, pcm, { ...po, known }, mediaDur);
          save(file, r);
          return r;
        }),
      ),
    );
    for (const f of rcs[0].failed) problems.push(`window ${f.window}: ${f.reason}`);
    focusedListens = rcs.map((r) => byMarker(r.candidates));
    const second = await consensus(open, [a, b], focusedListens, MODELS.judge);
    for (const [m, d] of second) decisions.set(m, d);
    log(`${open.length} of ${order.length} lines needed focused listens`);
  }

  // --- translations.json (same shape as before), evidence, document.
  const translations: Translation[] = markers.map((m) => {
    const d = decisions.get(m.index)!;
    const pick = d.pick;
    return {
      markerIndex: m.index,
      language: m.language,
      charName: m.charName,
      timestamp: m.timestamp,
      scene: m.scene,
      speech_start: pick ? pick.start : m.timestamp,
      speech_end: pick ? pick.end : m.timestamp,
      translation: pick ? cleanText(pick.ko) : "(들리지 않음)",
      confidence: d.confidence,
    };
  });
  save("translations.json", translations);
  save(
    "evidence.json",
    markers.map((m) => ({
      marker: m.index, speaker: m.charName, tc: m.timestamp,
      decision: { ...decisions.get(m.index)!, pick: decisions.get(m.index)!.pick?.pass },
      listens: [a, b, ...focusedListens].map((l) => l.get(m.index)).filter(Boolean),
    })),
  );

  let verify = "FAILED" as "OK" | "FAILED";
  let verifyOutput = "";
  await timed("apply+verify", async () => {
    const outPath = repackHwpx(hwpx, replaceMarkers(hwpx.xml, translations, hwpx.boldIds));
    try {
      const r = await execFileAsync("bun", [path.join(ROOT, "src/verify.ts"), hwpxPath], { cwd: ROOT });
      verify = "OK";
      verifyOutput = r.stdout.trim();
    } catch (e: any) {
      verifyOutput = `${e.stdout ?? ""}${e.stderr ?? ""}`.trim();
      problems.push("verify.ts found problems in the output document");
    }
    if (verify === "OK") fs.copyFileSync(outPath, output);
  });
  if (!o.keepAudio && verify === "OK") fs.rmSync(pcm, { force: true });

  const spans = (keep: (t: Translation) => boolean): [number, number][] =>
    translations.filter(keep).map((t) => [t.speech_start!, t.speech_end!]);
  const conf = { high: 0, medium: 0, low: 0 };
  for (const t of translations) conf[t.confidence]++;
  seconds.total = Math.round((performance.now() - t0) / 100) / 10;
  const report: EpisodeReport = {
    id, output, workDir,
    markers: markers.length, unrequested,
    windows: { a: windowsA.length, b: windowsB.length, c: windowsC.length },
    confidence: conf,
    flagged: translations
      .filter((t) => t.confidence === "low")
      .map((t) => ({
        marker: t.markerIndex, speaker: t.charName, tc: clock(t.timestamp),
        reason: decisions.get(t.markerIndex)!.reason, text: t.translation ?? "",
      })),
    // Billed: the audio that two listens agree on. A "??" line is not billed;
    // its seconds are reported apart so they can be added by hand.
    billableSec: unionSeconds(spans((t) => t.confidence !== "low")),
    billableLowSec: Math.round((unionSeconds(spans(() => true)) - unionSeconds(spans((t) => t.confidence !== "low"))) * 10) / 10,
    seconds, verify, verifyOutput, problems,
  };
  save("report.json", report);
  save("speech_duration.json", {
    hwpx_path: hwpxPath,
    definition:
      "union over markers of [speech_start, speech_end] from translations.json, for lines that two independent listens agree on (confidence high or medium)",
    billable_sec: report.billableSec,
    billable_min: Math.round((report.billableSec / 60) * 10) / 10,
    low_confidence_sec_not_billed: report.billableLowSec,
    markers: markers.length,
    markers_low_confidence: conf.low,
  });
  return report;
}
