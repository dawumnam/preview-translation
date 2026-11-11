// One episode, end to end: script + video → translated HWPX.
//
//   parse the script into a timeline      (script.ts)
//   decode the soundtrack once            (audio.ts)        ┐ at the same time
//   write the episode brief               (brief.ts)        ┘
//   listen: three passes, all windows at once        (listen.ts)
//   decide each line by the agreement of the passes  (reconcile.ts)
//   write translations.json, apply, verify
//
// Nothing here waits for a person or for an agent. The slowest single model
// call sets the run time.
import { execFile } from "child_process";
import { createHash } from "crypto";
import fs from "fs";
import path from "path";
import { promisify } from "util";
import { decodeAudio, mediaDuration } from "./audio";
import { briefText, makeBrief, type Brief } from "./brief";
import { extractHwpx, repackHwpx } from "./hwpx";
import { collect, listenOne, type Candidate, type ListenResult, type PassConfig, type WindowResult } from "./listen";
import { decide, type Decision } from "./reconcile";
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
  // The brief is text work on the script, and listening waits for it.
  // gemini-3.8-flash writes it in about 8 s; Argon needs 15 to 40 s.
  // (gemini-3.5-flash is deprecated and is routed to gemini-3.6-flash; it has
  // the same price and was not faster in repeat runs.)
  brief: process.env.BRIEF_MODEL || "gemini-3.8-flash",
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
  /** Windows in each pass. */
  windows: number[];
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
      // The saved brief is for one version of the script.
      const key = createHash("sha1").update(hwpx.xml).digest("hex");
      const old = saved<Brief & { key?: string }>("brief.json");
      brief = (old?.key === key ? old : null) ?? (await makeBrief(lines, MODELS.brief)) ?? (await makeBrief(lines, MODELS.listen));
      if (brief) save("brief.json", { ...brief, key });
      else problems.push("no episode brief: names may be spelled differently from the script");
    }),
  ]);
  const late = lines.filter((l) => l.kind === "marker" && l.tcPrev > mediaDur);
  for (const l of late) problems.push(`marker ${l.marker!.index}: TC ${clock(l.tcPrev)} is past the end of the media (${clock(mediaDur)})`);

  const po = { brief: briefText(brief), mask: o.mask?.(lines) };
  const base = { ...DEFAULT_WINDOW, mediaDur };
  // Three passes cut the audio in three ways, so a line near a window edge in
  // one pass is in the middle of a window in the others.
  const plans = [
    { name: "A", windows: planWindows(lines, base, undefined, undefined, "a") },
    { name: "B", windows: planWindows(lines, { ...base, pre: 12, post: 10, maxLen: 60 }, undefined, undefined, "b") },
    { name: "C", windows: planWindows(lines, { ...base, pre: 10, post: 12, maxLen: 80 }, undefined, undefined, "c") },
  ];
  // More thinking did not make the model hear better (Argon low/medium/high:
  // 0.90/0.89/0.91 on the benchmark), and HIGH takes twice the time.
  const passConfig: PassConfig = { name: "", model: MODELS.listen, thinkingLevel: "MEDIUM", fallbackModel: MODELS.fallback };

  let done = 0;
  const totalWindows = plans.reduce((n, p) => n + p.windows.length, 0);
  const tick = () => {
    done++;
    if (done % 25 === 0 || done === totalWindows) log(`listening: ${done}/${totalWindows} windows`);
  };
  // A saved pass is used again only for the same script, media and plan: a
  // new version of the script can move every marker index.
  const planKey = (windows: ListenWindow[]) =>
    createHash("sha1")
      .update(
        JSON.stringify([
          mediaPath, Math.round(mediaDur), MODELS.listen, po.brief, [...(po.mask ?? [])],
          markers.map((m) => [m.index, m.charName, m.timestamp, m.language]),
          windows.map((w) => [w.start, w.end, w.markers.map((l) => l.marker!.index)]),
        ]),
      )
      .digest("hex");
  type SavedPass = ListenResult & { key?: string };
  /** Starts every window of a pass now (or takes it from a saved pass). One promise for each window. */
  const startPass = (cfg: PassConfig, windows: ListenWindow[]) => {
    const file = `pass_${cfg.name.toLowerCase()}.json`;
    const key = planKey(windows);
    const old = saved<SavedPass>(file);
    const reuse = old && old.key === key && old.failed.length === 0 ? old : null;
    const jobs = new Map<string, Promise<WindowResult>>(
      windows.map((w) => [
        w.id,
        (reuse
          ? Promise.resolve({ window: w.id, candidates: reuse.candidates.filter((c) => c.window === w.id), seconds: 0 })
          : listenOne(cfg, w, pcm, po, mediaDur)
        ).finally(tick),
      ]),
    );
    const all = Promise.all(jobs.values()).then((rs) => {
      const r = collect(rs);
      if (!reuse) save(file, { ...r, key });
      for (const f of r.failed) problems.push(`window ${f.window}: ${f.reason}`);
      return r;
    });
    return { windows, jobs, all };
  };
  const tListen = performance.now();
  const since = () => Math.round((performance.now() - tListen) / 100) / 10;
  const passes = plans.map((p) => startPass({ ...passConfig, name: p.name }, p.windows));
  const listened = Promise.all(passes.map((p) => p.all)).then(() => {
    seconds.listen = since();
  });

  // --- Decide, group by group. Markers that share a window in any pass form
  // a group. A group is decided as soon as its own windows have answered, so
  // the compare calls run while other windows are still out.
  const order = markers.map((m) => m.index);
  const parent = new Map<number, number>(order.map((m) => [m, m]));
  const find = (m: number): number => (parent.get(m) === m ? m : find(parent.get(m)!));
  for (const p of plans)
    for (const w of p.windows) {
      const ids = w.markers.map((l) => l.marker!.index);
      for (const m of ids) parent.set(find(m), find(ids[0]));
    }
  const groups = new Map<number, number[]>();
  for (const m of order) groups.set(find(m), [...(groups.get(find(m)) ?? []), m]);

  const heard: Map<number, Candidate>[] = passes.map(() => new Map());
  const decisions = new Map<number, Decision>();
  let unjudged = 0;
  const decideGroup = async (ms: number[]) => {
    const mine = new Set(ms);
    const mineOf = await Promise.all(
      passes.map(async (p, k) => {
        const rs = await Promise.all(p.windows.filter((w) => w.markers.some((l) => mine.has(l.marker!.index))).map((w) => p.jobs.get(w.id)!));
        const map = new Map(rs.flatMap((r) => r.candidates).filter((c) => mine.has(c.marker)).map((c) => [c.marker, c]));
        for (const [m, c] of map) heard[k].set(m, c);
        return map;
      }),
    );
    for (const [m, d] of await decide(ms, mineOf, MODELS.judge, (n) => (unjudged += n))) decisions.set(m, d);
  };
  await Promise.all([...[...groups.values()].map(decideGroup), listened]);
  seconds.decided = since();

  if (unjudged)
    problems.push(
      `the compare model (${MODELS.judge}) gave no answer for ${unjudged} pairs of readings; text overlap decided them, so more lines than usual are medium or " ??". Run again for a better result.`,
    );

  // When the model refuses the calls (no key, spending cap, service down),
  // every line comes back "not heard" and the document would still pass
  // verify. Stop here: nothing is written.
  const failed = (await Promise.all(passes.map((p) => p.all))).flatMap((r) => r.failed);
  if (failed.length > totalWindows / 4) {
    throw new Error(
      `${failed.length} of ${totalWindows} listening windows got no answer (${failed[0].reason}). No output was written. Run the same command again when the cause is fixed.`,
    );
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
      listens: heard.map((l) => l.get(m.index)).filter(Boolean),
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
    windows: plans.map((p) => p.windows.length),
    confidence: conf,
    flagged: translations
      .filter((t) => t.confidence === "low")
      .map((t) => ({
        marker: t.markerIndex, speaker: t.charName, tc: clock(t.timestamp),
        reason: decisions.get(t.markerIndex)!.reason, text: t.translation ?? "",
      })),
    // Billed, as before: the audio each translation was written from, for every
    // line where speech was heard. A line that no pass heard has no span. The
    // share that comes from " ??" lines alone is reported apart.
    billableSec: unionSeconds(spans(() => true)),
    billableLowSec: Math.round((unionSeconds(spans(() => true)) - unionSeconds(spans((t) => t.confidence !== "low"))) * 10) / 10,
    seconds, verify, verifyOutput, problems,
  };
  save("report.json", report);
  save("speech_duration.json", {
    hwpx_path: hwpxPath,
    definition:
      "union over markers of [speech_start, speech_end] from translations.json: the audio each translation was written from, counted once where spans overlap",
    billable_sec: report.billableSec,
    billable_min: Math.round((report.billableSec / 60) * 10) / 10,
    of_which_only_low_confidence_lines_sec: report.billableLowSec,
    markers: markers.length,
    markers_low_confidence: conf.low,
    markers_not_heard: translations.filter((t) => t.speech_end! <= t.speech_start!).length,
  });
  return report;
}
