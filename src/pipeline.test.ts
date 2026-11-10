// Tests for the parts that have no model in them: the script timeline, the
// window plan, the audio slices, the agreement measure and the call wrapper.
//   bun test
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { sliceWav, SAMPLE_RATE } from "./audio";
import { tidyGlossary } from "./brief";
import { callJson, resetRefusal } from "./llm";
import { listenOne, type Candidate } from "./listen";
import { parseMarkers } from "./parser";
import { buildFillPrompt } from "./prompt";
import { decide, textSim } from "./reconcile";
import { parseScript } from "./script";
import { DEFAULT_WINDOW, planWindows } from "./windows";

const TAB = '<hp:tab width="1" leader="0" type="1"/>';
const BOLD = new Set(["12"]);
/** One script paragraph. `bold` puts the whole line in the bold (requested) style. */
const p = (cells: string[], bold = false) =>
  `<hp:p id="0"><hp:run charPrIDRef="${bold ? 12 : 3}"><hp:t>${cells.join(TAB)}</hp:t></hp:run></hp:p>`;
const doc = (paras: string[]) => `<hs:sec>${paras.join("")}</hs:sec>`;

const SCRIPT = doc([
  p(["1104"], true), // title: the date, not a TC
  p(["# 식당"]),
  p(["0100", "식당 fs"]),
  p(["0110", "피", "언제부터 하셨어요?"]),
  p(["", "코", "@@(조)"], true), // marker 0
  p(["", "모남", "@@(조)"], true), // marker 1
  p(["0125", "코", "30년 됐대요"]),
  p(["", "큐", "@@(조)"]), // not requested
  p(["140623", "모남", "@@(조)"], true), // marker 2, TC typo
  p(["0140", "식당 내부"]),
  p(["1000", "모남", "@@(조)"], true), // marker 3, far away
  p(["1012", "큐", "와"]),
]);

describe("script timeline", () => {
  const { lines, markers } = parseScript(SCRIPT, BOLD);
  const m = (i: number) => lines.find((l) => l.marker?.index === i)!;

  test("markers match parseMarkers one to one", () => {
    const ref = parseMarkers(SCRIPT, BOLD).markers;
    expect(markers.length).toBe(4);
    expect(lines.filter((l) => l.kind === "marker").map((l) => l.marker!.index)).toEqual([0, 1, 2, 3]);
    for (const r of ref) {
      expect(m(r.index).marker!.charName).toBe(r.charName);
      expect(m(r.index).speaker).toBe(r.charName);
    }
  });

  test("a marker is bounded by the TC lines around it", () => {
    expect(m(0).tcPrev).toBe(70); // 01:10
    expect(m(0).tcNext).toBe(85); // 01:25
    expect(m(1).tcPrev).toBe(70);
    expect(m(1).tcNext).toBe(85);
  });

  test("a TC out of sequence is not a bound", () => {
    expect(m(2).tc).toBeUndefined();
    expect(m(2).tcSuspect).toBe(14 * 3600 + 6 * 60 + 23);
    expect(m(2).tcPrev).toBe(85);
    expect(m(2).tcNext).toBe(100); // 01:40
  });

  test("the date in the title line is not a TC", () => {
    expect(lines.find((l) => l.kind === "shot" && l.text === "식당 fs")!.tcPrev).toBe(60);
    expect(lines.every((l) => l.tc !== 11 * 60 + 4)).toBe(true);
  });

  test("non-bold @@ lines are kept as unrequested turns", () => {
    const u = lines.filter((l) => l.kind === "unrequested");
    expect(u.length).toBe(1);
    expect(u[0].speaker).toBe("큐");
  });
});

describe("episode brief", () => {
  test("one spelling for each thing, picked by its count in the script", () => {
    const script = "끌라비 만드는 검여\n끌라비 맛있다\n클라피 보는 큐\n미쭈리 내부";
    const g = tidyGlossary(
      [
        { ko: "클라피", variants: ["끌라비", "틀라비"], original: "ტყლაპი", meaning: "fruit leather" },
        { ko: "미쭈리", variants: [], original: "მიწური", meaning: "earth house" },
        { ko: "하차푸리", variants: [], original: "ხაჭაპური", meaning: "cheese bread" }, // not in this script
        { ko: "끌라비", variants: [], original: "tklapi", meaning: "listed twice" },
      ],
      script,
    );
    expect(g.map((x) => x.ko)).toEqual(["끌라비", "미쭈리"]);
    expect(g[0].original).toBe("ტყლაპი");
  });
});

describe("window plan", () => {
  const { lines } = parseScript(SCRIPT, BOLD);
  const o = { ...DEFAULT_WINDOW, mediaDur: 3600 };
  const windows = planWindows(lines, o);

  test("near markers share a window, far ones do not", () => {
    expect(windows.map((w) => w.markers.map((l) => l.marker!.index))).toEqual([[0, 1, 2], [3]]);
  });

  test("each window holds the whole range of its markers", () => {
    for (const w of windows)
      for (const l of w.markers) {
        expect(w.start).toBeLessThanOrEqual(Math.max(0, l.tcPrev - o.pre));
        expect(w.end).toBeGreaterThanOrEqual(Math.min(o.mediaDur, l.tcNext + o.post));
      }
  });

  test("the prompt marks only the window's own markers, with clip times", () => {
    const text = buildFillPrompt(windows[0]);
    expect(text).toContain("▶0 코: (조지아어)");
    expect(text).toContain("▶2 모남: (조지아어)");
    expect(text).not.toContain("▶3");
    expect(text).toContain("큐: (외국어 — a foreign-language turn that is not requested)");
    // 01:10 in the script is 8 s into a window that starts at 01:02.
    expect(text).toContain("[00:08] 피: 언제부터 하셨어요?");
  });

  test("a masked line shows no text", () => {
    const key = lines.find((l) => l.text === "30년 됐대요")!;
    const text = buildFillPrompt(windows[0], { mask: new Set([key.no]) });
    expect(text).not.toContain("30년 됐대요");
    expect(text).toContain("코: (한국어 — text withheld)");
  });
});

describe("audio slices", () => {
  test("a slice is a valid WAV of the asked length", () => {
    const pcm = path.join(os.tmpdir(), `pt-test-${process.pid}.pcm`);
    const samples = new Int16Array(SAMPLE_RATE * 3).map((_, i) => i % 1000);
    fs.writeFileSync(pcm, Buffer.from(samples.buffer));
    try {
      const wav = sliceWav(pcm, 1, 2.5);
      expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
      expect(wav.readUInt32LE(24)).toBe(SAMPLE_RATE);
      expect(wav.readUInt32LE(40)).toBe(1.5 * SAMPLE_RATE * 2);
      expect(wav.length).toBe(44 + 1.5 * SAMPLE_RATE * 2);
      expect(wav.readInt16LE(44)).toBe(SAMPLE_RATE % 1000); // first sample is the one at 1.0 s
      expect(sliceWav(pcm, 2, 10).readUInt32LE(40)).toBe(SAMPLE_RATE * 2); // cut at the end of the file
    } finally {
      fs.rmSync(pcm, { force: true });
    }
  });
});

const cand = (marker: number, pass: string, ko: string, source = ko, start = 10, end = 12): Candidate => ({
  marker, pass, heard: true, source, ko, start, end, selfConfidence: "high", window: "w",
});
const map = (...cs: Candidate[]) => new Map(cs.map((c) => [c.marker, c]));

describe("decisions", () => {
  // No network in these tests: the judge model is "not there", so compare()
  // falls back on text overlap alone.
  const realFetch = globalThis.fetch;
  beforeEach(() => {
    globalThis.fetch = (async () => new Response("{}", { status: 404 })) as any;
  });
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  test("text overlap", () => {
    expect(textSim(cand(0, "A", "이 화덕은 300년 됐어요"), cand(0, "B", "이 화덕은 300년 됐어요."))).toBe(1);
    expect(textSim(cand(0, "A", "이 화덕은 300년 됐어요"), cand(0, "B", "내일 눈이 온대요"))).toBeLessThan(0.2);
  });

  test("three passes that agree make a line high; no model call is needed for close text", async () => {
    const say = "이 화덕은 300년 됐어요";
    const d = await decide([0], [map(cand(0, "A", say)), map(cand(0, "B", say + ".")), map(cand(0, "C", say))], "no-model");
    expect(d.get(0)!.confidence).toBe("high");
    expect(d.get(0)!.agree).toBe(3);
  });

  test("two of three make a line medium; no two make it low; nobody heard it makes it low with no text", async () => {
    const say = "여기서 30년 일했어요";
    const passes = [
      map(cand(0, "A", say), cand(1, "A", "가나다라마바사")),
      map(cand(0, "B", "전혀 다른 내용입니다"), cand(1, "B", "아자차카타파하")),
      map(cand(0, "C", say), cand(1, "C", "거너더러머버서")),
    ];
    const d = await decide([0, 1, 2], passes, "no-model");
    expect(d.get(0)!.confidence).toBe("medium");
    expect(d.get(0)!.agree).toBe(2);
    expect(d.get(0)!.pick!.ko).toBe(say);
    expect(d.get(1)!.confidence).toBe("low");
    expect(d.get(2)!.pick).toBeUndefined();
    expect(d.get(2)!.confidence).toBe("low");
  });

  test("neighbours that are the wrong way round in time are both flagged", async () => {
    const mk = (p: string) => map(cand(0, p, "첫 번째 말이에요", "x", 30, 34), cand(1, p, "두 번째 말이에요", "y", 10, 14));
    const d = await decide([0, 1], [mk("A"), mk("B"), mk("C")], "no-model");
    expect(d.get(0)!.confidence).toBe("low");
    expect(d.get(1)!.confidence).toBe("low");
    expect(d.get(0)!.reason).toContain("wrong order");
  });

  test("of the readings that agree, the one of middle length is taken", async () => {
    const d = await decide(
      [0],
      [
        map(cand(0, "A", "네, 맞아요. 여기서 30년 일했어요.", "კი, ასეა. აქ ოცდაათი წელი ვიმუშავე")),
        map(cand(0, "B", "네, 맞아요. 여기서 30년 일했어요. 그리고", "კი, ასეა. აქ ოცდაათი წელი ვიმუშავე და")),
        map(cand(0, "C", "맞아요. 여기서 30년 일했어요.", "ასეა. აქ ოცდაათი წელი ვიმუშავე")),
      ],
      "no-model",
    );
    expect(d.get(0)!.confidence).toBe("high");
    expect(d.get(0)!.pick!.pass).toBe("A");
  });
});

describe("model calls", () => {
  const realFetch = globalThis.fetch;
  const realKey = process.env.GEMINI_API_KEY;
  afterEach(() => {
    globalThis.fetch = realFetch;
    process.env.GEMINI_API_KEY = realKey;
    resetRefusal();
  });
  const reply = (obj: unknown, status = 200) => new Response(JSON.stringify(obj), { status });
  const ok = (value: unknown) => reply({ candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }] });
  const base = { model: "m", parts: [{ text: "x" }], schema: { type: "ARRAY" } };

  test("a server error is tried again", async () => {
    process.env.GEMINI_API_KEY = "test";
    let n = 0;
    globalThis.fetch = (async () => (++n === 1 ? reply({ error: "busy" }, 503) : ok([1]))) as any;
    const r = await callJson<number[]>({ ...base, attempts: 2 });
    expect(r.value).toEqual([1]);
    expect(n).toBe(2);
  });

  test("a blocked prompt is reported and not sent again", async () => {
    process.env.GEMINI_API_KEY = "test";
    let n = 0;
    globalThis.fetch = (async () => (n++, reply({ promptFeedback: { blockReason: "OTHER" } }))) as any;
    const r = await callJson({ ...base, attempts: 4 });
    expect(r.blocked).toBe("OTHER");
    expect(n).toBe(1);
  });

  test("a slow call is overtaken by its duplicate", async () => {
    process.env.GEMINI_API_KEY = "test";
    let n = 0;
    globalThis.fetch = ((_: any, init: any) =>
      ++n === 1
        ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve(ok({ fast: true }))) as any;
    const r = await callJson<{ fast: boolean }>({ ...base, hedgeAfterMs: 20, attempts: 1 });
    expect(r.value).toEqual({ fast: true });
    expect(n).toBe(2);
  });

  test("two slow calls are overtaken by the third copy", async () => {
    process.env.GEMINI_API_KEY = "test";
    let n = 0;
    globalThis.fetch = ((_: any, init: any) =>
      ++n <= 2
        ? new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))
        : Promise.resolve(ok({ third: true }))) as any;
    const r = await callJson<{ third: boolean }>({ ...base, hedgeAfterMs: [10, 20], attempts: 1 });
    expect(r.value).toEqual({ third: true });
    expect(n).toBe(3);
  });

  test("a failed call with no copy on its way goes to the retry at once", async () => {
    process.env.GEMINI_API_KEY = "test";
    let n = 0;
    globalThis.fetch = (async () => (++n === 1 ? reply({ error: "busy" }, 503) : ok([2]))) as any;
    const t0 = performance.now();
    const r = await callJson<number[]>({ ...base, hedgeAfterMs: [60_000], attempts: 2 });
    expect(r.value).toEqual([2]);
    expect(performance.now() - t0).toBeLessThan(5_000); // does not wait for the 60 s copy
  });

  test("the spending cap stops all later calls at once", async () => {
    process.env.GEMINI_API_KEY = "test";
    let n = 0;
    globalThis.fetch = (async () => (n++, reply({ error: { message: "Your project has exceeded its monthly spending cap." } }, 429))) as any;
    const first = await callJson({ ...base, attempts: 4 });
    expect(first.error).toContain("spending cap");
    expect(n).toBe(1); // not retried
    const second = await callJson({ ...base, attempts: 4 });
    expect(second.error).toContain("spending cap");
    expect(n).toBe(1); // not sent
  });

  test("a window with no answer is given up after its time limit", async () => {
    process.env.GEMINI_API_KEY = "test";
    globalThis.fetch = ((_: any, init: any) =>
      new Promise((_, reject) => init.signal.addEventListener("abort", () => reject(new Error("aborted"))))) as any;
    const pcm = path.join(os.tmpdir(), `pt-test-limit-${process.pid}.pcm`);
    fs.writeFileSync(pcm, Buffer.alloc(SAMPLE_RATE * 2 * 5));
    try {
      const { lines } = parseScript(SCRIPT, BOLD);
      const w = planWindows(lines, { ...DEFAULT_WINDOW, mediaDur: 5 })[0];
      const t0 = performance.now();
      const r = await listenOne({ name: "A", model: "m", thinkingLevel: "MEDIUM", fallbackModel: "f", windowLimitMs: 100 }, w, pcm, {}, 5);
      expect(performance.now() - t0).toBeLessThan(2000);
      expect(r.failed).toContain("no answer");
      expect(r.candidates.length).toBe(w.markers.length);
      expect(r.candidates.every((c) => !c.heard)).toBe(true);
    } finally {
      fs.rmSync(pcm, { force: true });
    }
  });

  test("a truncated answer is not accepted", async () => {
    process.env.GEMINI_API_KEY = "test";
    globalThis.fetch = (async () => reply({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: "[1," }] } }] })) as any;
    const r = await callJson({ ...base, attempts: 1 });
    expect(r.value).toBeUndefined();
    expect(r.error).toContain("MAX_TOKENS");
  });
});
