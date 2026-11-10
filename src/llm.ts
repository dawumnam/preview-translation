// Gemini calls over REST with the behaviour the pipeline needs: JSON output
// with a schema, a time limit, retries that depend on the kind of failure, a
// duplicate request when a call is slow, one shared limit on calls in flight,
// and a token count for the cost report.
//
// Earlier runs lost most of their time here: one blocked or hung request held
// up a whole step (1103: 16 minutes; 1029: an hour on a dead socket).

const BASE = "https://generativelanguage.googleapis.com/v1beta";

export interface CallOptions {
  model: string;
  /** Request parts: text and inline audio. */
  parts: any[];
  /** Response schema (Gemini schema object). The reply is parsed as JSON. */
  schema: any;
  thinkingLevel?: "LOW" | "MEDIUM" | "HIGH";
  temperature?: number;
  /** Time limit for one HTTP request. */
  timeoutMs?: number;
  /** Tries for errors that a retry can fix (429, 5xx, timeout, bad JSON). */
  attempts?: number;
  /** Start an identical copy of the request when no answer has come after this long. Several times start several copies. */
  hedgeAfterMs?: number | number[];
  /** Shown in error messages. */
  label?: string;
}

export interface CallResult<T> {
  value?: T;
  /** Set when Gemini refused the prompt (promptFeedback.blockReason). A retry of the same request seldom helps. */
  blocked?: string;
  error?: string;
  latencyMs: number;
  attempts: number;
}

interface Usage {
  calls: number;
  input: number;
  output: number;
  thoughts: number;
}
const usageByModel = new Map<string, Usage>();
function addUsage(model: string, u: any) {
  const cur = usageByModel.get(model) ?? { calls: 0, input: 0, output: 0, thoughts: 0 };
  cur.calls++;
  cur.input += u?.promptTokenCount ?? 0;
  cur.output += u?.candidatesTokenCount ?? 0;
  cur.thoughts += u?.thoughtsTokenCount ?? 0;
  usageByModel.set(model, cur);
}
export function usageReport(): Record<string, Usage> {
  return Object.fromEntries(usageByModel);
}

// Calls in flight are limited in two lanes. Audio calls (the listening
// windows) are many and slow. Text calls (brief, compare) are few and fast, and
// a decision waits for them, so they must not queue behind hundreds of windows.
// Gemini has answered 135 audio calls at once with no 429 on this key;
// LLM_CONCURRENCY changes the audio limit.
class Lane {
  private active = 0;
  private waiting: (() => void)[] = [];
  constructor(public limit: number) {}
  async acquire() {
    if (this.active < this.limit) {
      this.active++;
      return;
    }
    await new Promise<void>((r) => this.waiting.push(r)); // a finished call hands its slot over
  }
  release() {
    // Copies of slow calls can take the count above the limit; then a slot is
    // dropped and not handed over.
    if (this.waiting.length && this.active <= this.limit) this.waiting.shift()!();
    else this.active--;
  }
  /** A copy of a slow call takes a slot without waiting for one, so new calls wait while copies run. */
  occupy() {
    this.active++;
  }
}
const audioLane = new Lane(parseInt(process.env.LLM_CONCURRENCY || "", 10) || 128);
const textLane = new Lane(32);
const laneOf = (o: CallOptions) => (o.parts.some((p) => p?.inlineData) ? audioLane : textLane);
export function setConcurrency(n: number) {
  audioLane.limit = Math.max(1, n);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Set when the API refuses the project or the key as a whole (spending cap, bad key). */
let refused: string | null = null;
/** Tests only. */
export function resetRefusal() {
  refused = null;
}

type Once<T> = { value: T } | { blocked: string } | { retry: string; rateLimited?: boolean } | { fatal: string };

async function once<T>(o: CallOptions, signal: AbortSignal): Promise<Once<T>> {
  const key = process.env.GEMINI_API_KEY;
  if (!key) return { fatal: "GEMINI_API_KEY is not set (bun loads it from .env in the project root)" };
  const body = {
    contents: [{ role: "user", parts: o.parts }],
    generationConfig: {
      // Gemini 4 Argon refuses more than 32768 on a non-streaming call.
      maxOutputTokens: 32768,
      responseMimeType: "application/json",
      responseSchema: o.schema,
      ...(o.temperature !== undefined ? { temperature: o.temperature } : {}),
      ...(o.thinkingLevel ? { thinkingConfig: { thinkingLevel: o.thinkingLevel } } : {}),
    },
  };
  let res: Response;
  try {
    res = await fetch(`${BASE}/models/${o.model}:generateContent`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-goog-api-key": key },
      body: JSON.stringify(body),
      signal: AbortSignal.any([signal, AbortSignal.timeout(o.timeoutMs ?? 180_000)]),
    });
  } catch (e: any) {
    if (signal.aborted) return { retry: "cancelled" };
    return { retry: `network: ${e?.name === "TimeoutError" ? "timed out" : (e?.message ?? e)}` };
  }
  if (!res.ok) {
    const text = (await res.text().catch(() => "")).slice(0, 300);
    // The project's spending cap is not a rate limit: no retry will get through.
    if (res.status === 429 && /spending cap|spend cap/i.test(text)) {
      refused = "the Gemini project has reached its spending cap (raise it at https://ai.studio/spend, or wait for the next month)";
      return { fatal: refused };
    }
    // A key that is missing, wrong or without access fails every call in the same way.
    if (res.status === 401 || res.status === 403 || (res.status === 400 && /API key/i.test(text))) {
      refused = `the Gemini API refused the key (${res.status} ${text.replace(/\s+/g, " ").slice(0, 160)})`;
      return { fatal: refused };
    }
    if (res.status === 429) return { retry: `429 ${text}`, rateLimited: true };
    if (res.status >= 500) return { retry: `${res.status} ${text}` };
    return { fatal: `${res.status} ${text}` };
  }
  let j: any;
  try {
    j = await res.json();
  } catch (e: any) {
    return { retry: `unreadable response: ${e?.message ?? e}` };
  }
  addUsage(o.model, j.usageMetadata);
  if (j.promptFeedback?.blockReason) return { blocked: j.promptFeedback.blockReason };
  const cand = j.candidates?.[0];
  const text = (cand?.content?.parts ?? [])
    .filter((p: any) => !p.thought)
    .map((p: any) => p.text ?? "")
    .join("");
  if (cand?.finishReason && cand.finishReason !== "STOP") return { retry: `finishReason=${cand.finishReason}` };
  if (!text.trim()) return { retry: "empty response" };
  try {
    return { value: JSON.parse(text) as T };
  } catch {
    return { retry: "response was not valid JSON" };
  }
}

/**
 * One request, with identical copies started when it is slow. The first
 * answer wins and the others are cancelled.
 *
 * How long a call takes does not follow its size: in a busy hour a window
 * with one short line took 52 s while the median was 20 s. A copy is a new
 * draw from that distribution, so it cuts the long waits.
 */
function hedged<T>(o: CallOptions, lane: Lane): Promise<Once<T>> {
  const delays = o.hedgeAfterMs === undefined ? [] : [o.hedgeAfterMs].flat();
  const ctl = new AbortController();
  const usable = (r: Once<T>) => "value" in r || "blocked" in r || "fatal" in r;
  return new Promise<Once<T>>((resolve) => {
    const timers: ReturnType<typeof setTimeout>[] = [];
    let inFlight = 0;
    let done = false;
    const finish = (r: Once<T>) => {
      if (done) return;
      done = true;
      for (const t of timers) clearTimeout(t);
      ctl.abort();
      resolve(r);
    };
    const launch = (copy: boolean) => {
      if (done) return;
      inFlight++;
      if (copy) lane.occupy();
      once<T>(o, ctl.signal).then((r) => {
        inFlight--;
        if (copy) lane.release();
        // A failure counts only when no copy is still on its way. Then the
        // caller's retry (with backoff) takes over.
        if (usable(r) || inFlight === 0) finish(r);
      });
    };
    launch(false);
    for (const d of delays) timers.push(setTimeout(() => launch(true), d));
  });
}

/** Calls the model and returns parsed JSON, or says why it could not. Never throws. */
export async function callJson<T>(o: CallOptions): Promise<CallResult<T>> {
  // After such a refusal no call can get through, so the rest fail at once
  // and do not send their audio.
  if (refused) return { error: refused, latencyMs: 0, attempts: 0 };
  const t0 = performance.now();
  const max = o.attempts ?? 4;
  let last = "";
  for (let attempt = 1; attempt <= max; attempt++) {
    const lane = laneOf(o);
    await lane.acquire();
    let r: Once<T>;
    try {
      r = await hedged<T>(o, lane);
    } finally {
      lane.release();
    }
    const latencyMs = performance.now() - t0;
    if ("value" in r) return { value: r.value, latencyMs, attempts: attempt };
    if ("blocked" in r) return { blocked: r.blocked, latencyMs, attempts: attempt };
    if ("fatal" in r) return { error: r.fatal, latencyMs, attempts: attempt };
    last = r.retry;
    if (attempt < max) {
      // Many calls run at once: back off harder on 429 and add jitter so they
      // do not all come back in the same second.
      const base = r.rateLimited ? Math.min(30_000, 2 ** attempt * 2000) : 1000 * attempt;
      await sleep(base + Math.random() * 1000);
    }
  }
  return { error: `${o.label ?? o.model}: ${last} (after ${max} tries)`, latencyMs: performance.now() - t0, attempts: max };
}
