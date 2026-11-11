// A listening pass: every window of the plan goes to the model at the same
// time, with the script lines for that stretch, and comes back as one
// candidate for each marker.
import { audioPart } from "./audio";
import { callJson } from "./llm";
import { buildFillPrompt, FILL_SCHEMA, type Fill, type PromptOptions } from "./prompt";
import type { ListenWindow } from "./windows";

export interface Candidate {
  marker: number;
  pass: string;
  heard: boolean;
  source: string;
  ko: string;
  /** Seconds from the start of the media. */
  start: number;
  end: number;
  selfConfidence: "high" | "medium" | "low";
  window: string;
}

export interface PassConfig {
  name: string;
  model: string;
  thinkingLevel: "LOW" | "MEDIUM" | "HIGH";
  /** Used when the model blocks the window or is not available. */
  fallbackModel: string;
  /**
   * Longest time to wait for one window, all tries together. After that the
   * window counts as failed in this pass; the other passes still hear its lines.
   */
  windowLimitMs?: number;
}

const WINDOW_LIMIT_MS = 150_000;

const clipSeconds = (s: string): number => {
  const p = String(s ?? "").trim().split(":");
  if (p.length < 2 || p.length > 3) return NaN;
  const sec = parseFloat(p[p.length - 1]);
  const min = parseInt(p[p.length - 2], 10);
  const hr = p.length === 3 ? parseInt(p[0], 10) : 0;
  return hr * 3600 + min * 60 + sec;
};

function toCandidates(w: ListenWindow, fills: Fill[], pass: string): Candidate[] {
  const len = w.end - w.start;
  return w.markers.map((m) => {
    const f = fills.find((x) => x.id === m.marker!.index);
    const empty: Candidate = {
      marker: m.marker!.index, pass, heard: false, source: "", ko: "",
      start: m.tcPrev, end: m.tcPrev, selfConfidence: "low", window: w.id,
    };
    if (!f) return empty;
    let s = clipSeconds(f.start);
    let e = clipSeconds(f.end);
    const ko = (f.ko ?? "").trim();
    if (!f.heard || !ko || !Number.isFinite(s)) return empty;
    if (!Number.isFinite(e) || e < s) e = s;
    // A time outside the clip is a model slip; keep it inside.
    s = Math.min(Math.max(0, s), len);
    e = Math.min(Math.max(s, e), len);
    return {
      marker: f.id, pass, heard: true, source: (f.source ?? "").trim(), ko,
      start: Math.round((w.start + s) * 10) / 10,
      end: Math.round((w.start + e) * 10) / 10,
      selfConfidence: f.confidence, window: w.id,
    };
  });
}

export interface ListenResult {
  candidates: Candidate[];
  /** Windows that gave no answer, with the reason. Their markers come back as not heard. */
  failed: { window: string; reason: string }[];
  /** Seconds each window took, for the report. */
  latencies: number[];
}

/**
 * One window. When the model blocks the audio (promptFeedback.blockReason,
 * which follows the audio and not chance), the same request is not sent again:
 * the window is moved by a few seconds, and then the other model gets it.
 */
async function listenWindow(
  w: ListenWindow,
  pcm: string,
  cfg: PassConfig,
  po: PromptOptions,
  mediaDur: number,
): Promise<{ fills: Fill[] | null; reason?: string; latencyMs: number }> {
  const tries: { model: string; win: ListenWindow }[] = [
    { model: cfg.model, win: w },
    { model: cfg.model, win: { ...w, start: Math.max(0, w.start - 4), end: Math.min(mediaDur, w.end + 3) } },
    { model: cfg.fallbackModel, win: w },
  ];
  let reason = "";
  let latencyMs = 0;
  for (const t of tries) {
    const r = await callJson<Fill[]>({
      model: t.model,
      parts: [audioPart(pcm, t.win.start, t.win.end), { text: buildFillPrompt(t.win, po) }],
      schema: FILL_SCHEMA,
      thinkingLevel: cfg.thinkingLevel,
      timeoutMs: 90_000,
      hedgeAfterMs: [20_000, 40_000],
      attempts: 2,
      label: `${cfg.name} ${w.id}`,
    });
    latencyMs += r.latencyMs;
    const got = r.value;
    if (Array.isArray(got)) {
      // Times are relative to the clip that was sent; shift them if the window moved.
      const shift = w.start - t.win.start;
      const fills = shift ? got.map((f) => ({ ...f, start: shiftClip(f.start, -shift), end: shiftClip(f.end, -shift) })) : got;
      return { fills, latencyMs };
    }
    reason = r.blocked ? `blocked (${r.blocked}) on ${t.model}` : (r.error ?? "no answer");
  }
  return { fills: null, reason, latencyMs };
}

function shiftClip(ts: string, by: number): string {
  const s = clipSeconds(ts);
  if (!Number.isFinite(s)) return ts;
  const v = Math.max(0, s + by);
  return `${String(Math.floor(v / 60)).padStart(2, "0")}:${(v % 60).toFixed(1).padStart(4, "0")}`;
}

export interface WindowResult {
  window: string;
  /** One candidate for each marker of the window; "not heard" when the window gave no answer. */
  candidates: Candidate[];
  /** Why the window gave no answer. */
  failed?: string;
  seconds: number;
}

/** One window of a pass. Never throws. */
export async function listenOne(
  cfg: PassConfig,
  w: ListenWindow,
  pcm: string,
  po: PromptOptions,
  mediaDur: number,
): Promise<WindowResult> {
  // One window must not hold up the run: a dead connection went through
  // three tries with three models and took minutes.
  const limit = cfg.windowLimitMs ?? WINDOW_LIMIT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const r = await Promise.race([
    listenWindow(w, pcm, cfg, po, mediaDur),
    new Promise<{ fills: null; reason: string; latencyMs: number }>((resolve) => {
      timer = setTimeout(() => resolve({ fills: null, reason: `no answer in ${Math.round(limit / 1000)} s`, latencyMs: limit }), limit);
    }),
  ]);
  clearTimeout(timer);
  return {
    window: w.id,
    candidates: toCandidates(w, r.fills ?? [], cfg.name),
    failed: r.fills ? undefined : (r.reason ?? "no answer"),
    seconds: r.latencyMs / 1000,
  };
}

export function collect(results: WindowResult[]): ListenResult {
  return {
    candidates: results.flatMap((r) => r.candidates).sort((a, b) => a.marker - b.marker),
    failed: results.filter((r) => r.failed).map((r) => ({ window: r.window, reason: r.failed! })),
    latencies: results.map((r) => r.seconds),
  };
}

/** All windows of a pass at the same time. */
export async function listenPass(
  cfg: PassConfig,
  windows: ListenWindow[],
  pcm: string,
  po: PromptOptions,
  mediaDur: number,
): Promise<ListenResult> {
  return collect(await Promise.all(windows.map((w) => listenOne(cfg, w, pcm, po, mediaDur))));
}
