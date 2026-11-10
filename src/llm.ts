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
  /** Start a second identical request when the first has not answered after this long. */
  hedgeAfterMs?: number;
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

// One limit for the whole process. Gemini has answered 60 calls at once with
// no 429 on this key; LLM_CONCURRENCY changes the limit.
let limit = parseInt(process.env.LLM_CONCURRENCY || "", 10) || 64;
let active = 0;
const waiting: (() => void)[] = [];
async function acquire() {
  if (active >= limit) await new Promise<void>((r) => waiting.push(r));
  active++;
}
function release() {
  active--;
  waiting.shift()?.();
}
export function setConcurrency(n: number) {
  limit = Math.max(1, n);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

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

/** One request, with a duplicate started if the first is slow. The first answer wins. */
async function hedged<T>(o: CallOptions): Promise<Once<T>> {
  const ctl = new AbortController();
  const first = once<T>(o, ctl.signal);
  if (!o.hedgeAfterMs) return first;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const second = new Promise<Once<T>>((resolve) => {
    timer = setTimeout(() => once<T>(o, ctl.signal).then(resolve), o.hedgeAfterMs);
  });
  const usable = (r: Once<T>) => "value" in r || "blocked" in r || "fatal" in r;
  try {
    const a = await Promise.race([first, second]);
    if (usable(a)) return a;
    // The faster one failed in a way a retry can fix: give the other one its chance.
    const b = await Promise.race([first.then((r) => (r === a ? second : r)), second.then((r) => (r === a ? first : r))]);
    return usable(b) ? b : a;
  } finally {
    clearTimeout(timer);
    ctl.abort();
  }
}

/** Calls the model and returns parsed JSON, or says why it could not. Never throws. */
export async function callJson<T>(o: CallOptions): Promise<CallResult<T>> {
  const t0 = performance.now();
  const max = o.attempts ?? 4;
  let last = "";
  for (let attempt = 1; attempt <= max; attempt++) {
    await acquire();
    let r: Once<T>;
    try {
      r = await hedged<T>(o);
    } finally {
      release();
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
