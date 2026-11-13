// bun test previewgen — the parts of the preview writer that need no model.
import { expect, test } from "bun:test";
import AdmZip from "adm-zip";
import fs from "fs";
import os from "os";
import path from "path";
import { applyStyle, HOUSE_STYLE, joinShots, mergeWindows, tcShown } from "./assemble";
import { clipRows } from "./cliplayout";
import { applyCast, castFromAnswer, castNotes } from "./cast";
import { planWindows } from "./cuts";
import { toPreviewLines, type WindowOut } from "./gen";
import { loadGt, renderLine, tcText, type PreviewLine } from "./gt";
import { applyScenes } from "./scenes";
import { score, scoreScenes } from "./score";
import { documentRows, writeHwpx } from "./write";

const win = (start: number, end: number, lines: PreviewLine[], startsAtCut = true, people: WindowOut["people"] = []): WindowOut => ({
  start, end, startsAtCut, cuts: [], latencyMs: 0, people, lines,
});
const shot = (tc: number, text: string): PreviewLine => ({ tc, kind: "shot", text });
const say = (tc: number, speaker: string, text: string, use: PreviewLine["use"] = "take"): PreviewLine => ({ tc, kind: "speech", speaker, text, use });
const foreign = (tc: number, speaker: string, use: PreviewLine["use"] = "take"): PreviewLine => ({ tc, kind: "foreign", speaker, text: "", lang: "조", use });

test("TC text is MMSS below one hour and HMMSS above", () => {
  expect(tcText(86)).toBe("0126");
  expect(tcText(3611)).toBe("10011");
  expect(renderLine(foreign(3221, "할"))).toBe("5341\t할\t@@(조)");
  expect(renderLine(say(10, "큐", "와"), false)).toBe("\t큐\t와");
});

test("model lines become preview lines with times from the start of the video", () => {
  const lines = toPreviewLines(
    {
      people: [],
      lines: [
        { t: "00:05", kind: "speech", speaker: "코", lang: "ka", use: "take", text: "" },
        { t: "00:02", kind: "shot", speaker: "", lang: "", use: "none", text: " 걸어가는  큐 후면 " },
        { t: "00:09", kind: "speech", speaker: "큐", lang: "ko", use: "direct", text: "다시 할게요" },
        { t: "00:12", kind: "speech", speaker: "검남", lang: "en", use: "take", text: "" },
        { t: "bad", kind: "shot", speaker: "", lang: "", use: "none", text: "x" },
      ],
    },
    600,
    900,
  );
  expect(lines.map((l) => [l.tc, l.kind, l.speaker ?? "", l.lang ?? "", l.text])).toEqual([
    [602, "shot", "", "", "걸어가는 큐 후면"],
    [605, "foreign", "코", "조", ""],
    [609, "speech", "큐", "", "다시 할게요"],
    [612, "foreign", "검남", "영", ""],
  ]);
  expect(lines[2].use).toBe("direct");
});

test("a window ends at a cut near the target length, and at a quiet moment inside a long take", () => {
  const loud = new Float32Array(4000).fill(-30);
  // A pause at 600 s. The search is 20 s to each side of the target length (290 + 300).
  for (const k of [-1, 0, 1]) loud[Math.floor(600 / 0.5) + k] = -70;
  const w = planWindows(1000, [100, 290, 900], loud, 0.5, 300);
  expect(w[0]).toMatchObject({ start: 0, end: 290, startsAtCut: true });
  expect(w[1].start).toBe(290);
  expect(w[1].end).toBeCloseTo(600, 0);
  expect(w[1].startsAtCut).toBe(true);
  expect(w[2].startsAtCut).toBe(false);
  expect(w[w.length - 1].end).toBe(1000);
  // The windows cover the video with no gap.
  for (let i = 1; i < w.length; i++) expect(w[i].start).toBe(w[i - 1].end);
});

test("shot lines: none at the start of a window that began inside a take; a time next to a cut moves to the cut", () => {
  const merged = mergeWindows(
    [win(0, 300, [shot(0, "걸어가는 큐 후면"), shot(101.5, "풍경 sk")]), win(300, 600, [shot(301, "큐, 할 2s"), say(305, "큐", "와"), shot(400, "집 sk")], false)],
    [100.2, 400.9],
  );
  expect(merged.map((l) => [l.tc, l.text])).toEqual([
    [0, "걸어가는 큐 후면"],
    [100.2, "풍경 sk"],
    [305, "와"],
    [400.9, "집 sk"],
  ]);
});

test("house style: talk off the record becomes one 디렉 line between two turns that stay", () => {
  const lines = [
    say(10, "큐", "이 집을 기준으로 여기는 지하인데요"),
    say(20, "피", "좋아요 근데 조금만 천천히 걸어오면서 한 번만 더 갈게요 처음부터 다시", "direct"),
    say(24, "큐", "네 알겠습니다", "direct"),
    foreign(25, "코", "direct"),
    shot(30, "걸어오는 큐 정면"),
    say(31, "카감", "레디", "direct"),
    say(35, "큐", "이 집을 기준으로 여기는 지하가 되는 겁니다"),
    say(50, "큐", "네", "direct"),
    say(60, "피", "이 화덕이 얼마나 됐는지", "ask"),
    say(64, "피", "한 번만 물어봐주세요", "ask"),
    foreign(70, "코"),
    foreign(74, "코"),
    foreign(90, "할"),
  ];
  const out = applyStyle(lines);
  expect(out.map((l) => renderLine(l, false))).toEqual([
    "\t큐\t이 집을 기준으로 여기는 지하인데요",
    "\t피\t디렉",
    "\t걸어오는 큐 정면",
    "\t큐\t이 집을 기준으로 여기는 지하가 되는 겁니다",
    "\t피\t이 화덕이 얼마나 됐는지 한 번만 물어봐주세요",
    "\t코\t@@(조)",
    "\t할\t@@(조)",
  ]);
  expect(out[1].tc).toBe(20);
  // "full" keeps every turn.
  expect(applyStyle(lines, { ...HOUSE_STYLE, direct: "full" }).length).toBe(lines.length);
  // Foreign turns inside talk off the record can stay.
  expect(applyStyle(lines, { ...HOUSE_STYLE, directForeign: "keep" }).filter((l) => l.kind === "foreign").length).toBe(3);
});

test("a shot line always shows its TC; a speech line shows it after a gap", () => {
  const lines = [shot(100, "a"), say(101, "큐", "b"), say(105, "큐", "c"), say(109, "코", "d"), foreign(120, "할"), shot(121, "e")];
  expect(tcShown(lines)).toEqual([true, false, false, true, true, true]);
});

test("one label for one person: speaker fields and shot descriptions are renamed", () => {
  const windows = [
    win(0, 300, [foreign(10, "두여"), shot(20, "큐, 두여 2s")], true, [{ label: "두여", look: "두건 쓴 여성", role: "" }]),
    win(300, 600, [foreign(310, "모여"), shot(320, "설명하는 모여와 큐"), say(330, "큐", "모여라")], true, [{ label: "모여", look: "모자 쓴 여성", role: "" }]),
  ];
  const notes = castNotes(windows);
  expect(notes.map((n) => [n.label, n.turns])).toEqual([["두여", 1], ["모여", 1]]);
  const cast = castFromAnswer(notes, { persons: [{ label: "두여", look: "두건 쓴 여성", notes: [1, 2] }] });
  const out = applyCast(windows, cast);
  expect(out[1].lines.map((l) => renderLine(l, false))).toEqual(["\t두여\t@@(조)", "\t설명하는 두여와 큐", "\t큐\t모여라"]);
  expect(cast.persons).toEqual([{ label: "두여", look: "두건 쓴 여성", from: 0, to: 600, turns: 2 }]);
  // No answer: the labels stay.
  expect(applyCast(windows, castFromAnswer(notes, undefined))[1].lines[0].speaker).toBe("모여");
});

test("scene lines go before the first line of each scene; without an answer the document has one scene", () => {
  const lines = [shot(0, "a"), say(5, "큐", "b"), shot(200, "c"), say(205, "큐", "d")];
  const out = applyScenes(lines, { scenes: [{ first_line: 1, title: "걸어가는 큐" }, { first_line: 3, title: "# 집 sk" }, { first_line: 99, title: "x" }] });
  expect(out.map((l) => (l.kind === "scene" ? `# ${l.text}@${l.tc}` : l.text))).toEqual(["# 걸어가는 큐@0", "a", "b", "# 집 sk@200", "c", "d"]);
  expect(applyScenes(lines, undefined).filter((l) => l.kind === "scene").length).toBe(1);
  expect(applyScenes(lines, { scenes: [{ first_line: 3, title: "늦게 시작" }] })[0]).toMatchObject({ kind: "scene", text: "늦게 시작", tc: 0 });
});

/** A small HWPX in the layout of the previews, to stand in for a template. */
function templateHwpx(file: string) {
  const p = (para: string, char: string, text: string) => `<hp:p id="0" paraPrIDRef="${para}" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="${char}"><hp:t>${text}</hp:t></hp:run><hp:linesegarray><hp:lineseg textpos="0"/></hp:linesegarray></hp:p>`;
  const rule = "-".repeat(103);
  const tab = '<hp:tab width="4000" leader="0" type="1"/>';
  const xml =
    `<?xml version="1.0" encoding="UTF-8" standalone="yes" ?><hs:sec xmlns:hp="p" xmlns:hs="s">` +
    `<hp:p id="1" paraPrIDRef="20" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="0"><hp:secPr id=""><hp:pagePr width="59528"/></hp:secPr><hp:ctrl><hp:colPr id=""/></hp:ctrl><hp:t>${rule}</hp:t></hp:run></hp:p>` +
    p("0", "1", "0101") + p("21", "0", rule) + p("22", "2", "# 옛 장면") + p("21", "0", rule) + p("22", "2", "# 옛 장면") + p("23", "3", `0006${tab}옛 샷`) + p("23", "3", `${tab}큐${tab}옛 말`) +
    `</hs:sec>`;
  const zip = new AdmZip();
  zip.addFile("mimetype", Buffer.from("application/hwp+zip"));
  zip.addFile("Contents/section0.xml", Buffer.from(xml, "utf-8"));
  zip.addFile("Preview/PrvText.txt", Buffer.from("old"));
  zip.writeZip(file);
}

test("the HWPX is written with the styles of the template and reads back as the same lines", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previewgen-"));
  const template = path.join(dir, "template.hwpx");
  const out = path.join(dir, "out.hwpx");
  templateHwpx(template);
  const lines: PreviewLine[] = [
    { kind: "scene", text: "걸어가는 큐", tc: 0 },
    shot(6, "걸어가는 큐 후면"),
    say(7, "큐", "이 집 <진짜> 예쁘다 & 좋다"),
    { kind: "scene", text: "할 인터뷰", tc: 3600 },
    foreign(3611, "할"),
    say(3612, "코", "네 맞습니다"),
  ];
  writeHwpx(documentRows("1023", lines, 3700, HOUSE_STYLE), template, out);
  const xml = new AdmZip(out).getEntry("Contents/section0.xml")!.getData().toString("utf-8");
  // Section settings stay; old body text and the old preview text are gone; styles come from the template.
  expect(xml).toContain("<hp:secPr");
  expect(xml).not.toContain("옛 샷");
  expect(new AdmZip(out).getEntry("Preview/PrvText.txt")).toBeNull();
  expect(xml).toContain('paraPrIDRef="22" styleIDRef="0" pageBreak="0" columnBreak="0" merged="0"><hp:run charPrIDRef="2"><hp:t># 할 인터뷰</hp:t>');
  expect(xml).toContain("이 집 &lt;진짜&gt; 예쁘다 &amp; 좋다");
  const back = loadGt(out);
  expect(back.map((l) => renderLine(l))).toEqual([
    "# 걸어가는 큐",
    "0006\t걸어가는 큐 후면",
    "\t큐\t이 집 <진짜> 예쁘다 & 좋다",
    "# 할 인터뷰",
    "10011\t할\t@@(조)",
    "\t코\t네 맞습니다",
    "10140\t영상종료",
  ]);
  // The same lines score 100% against themselves.
  const s = score(lines.filter((l) => l.kind !== "scene"), back, [[0, 3700]]);
  expect(s.korean.recall).toBe(1);
  expect(s.korean.precision).toBe(1);
  expect(s.foreign).toMatchObject({ ref: 1, gen: 1, matched: 1, matchedSpeaker: 1 });
  expect(s.shot).toMatchObject({ ref: 1, gen: 1, matched: 1 });
  expect(scoreScenes(lines, back)).toMatchObject({ ref: 2, gen: 2, matched: 2 });
  fs.rmSync(dir, { recursive: true });
});

test("score: text that only the output has does not pull a true match apart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "previewgen-"));
  const template = path.join(dir, "template.hwpx");
  const ref = path.join(dir, "ref.hwpx");
  templateHwpx(template);
  const human: PreviewLine[] = [{ kind: "scene", text: "a", tc: 0 }, say(10, "큐", "여기 지붕만 있는 건물이 집인가요"), say(60, "코", "네 옛날 집이었어요 지금은 창고로 씁니다")];
  writeHwpx(documentRows("1", human, 100, { ...HOUSE_STYLE, tcGap: 0 }), template, ref);
  const gen: PreviewLine[] = [
    say(10, "큐", "여기 지붕만 있는 건물이 집인가요?"),
    say(20, "피", "하차푸리는 안 했었어요 아까는 카다만 다시 설명해 주세요"),
    say(61, "코", "네 옛날 집이었어요 지금은 창고로 씁니다"),
  ];
  const s = score(gen, loadGt(ref), [[0, 100]]);
  expect(s.korean.refFound).toBe(2);
  expect(s.korean.genSupported).toBe(2);
  expect(s.speaker.same).toBe(2);
  fs.rmSync(dir, { recursive: true });
});

test("shot lines of the picture-only pass are added where the usual pass has none", () => {
  const base = [shot(100, "걸어오는 큐 정면"), say(104, "큐", "와 예쁘다"), say(130, "큐", "질문 하나"), foreign(133, "코"), say(137, "코", "네 맞습니다"), shot(200, "집 sk")];
  const extra = [shot(101, "걸어오는 큐"), shot(118, "문 여는 큐"), shot(120, "집 안"), shot(134, "큐, 할 2s"), shot(160, "악수하는 큐와 할"), shot(203, "집")];
  // 134 is at a cut, and the talk of the usual pass runs across it: the same conversation goes on.
  const out = joinShots(base, extra, [100, 134, 200]);
  expect(out.filter((l) => l.kind === "shot").map((l) => [l.tc, l.text])).toEqual([
    [100, "걸어오는 큐 정면"],
    [118, "문 여는 큐"],
    [160, "악수하는 큐와 할"],
    [200, "집 sk"],
  ]);
  expect(out.length).toBe(base.length + 2);
});

test("camera-file layout: one head line for each file, notes and turns below it", () => {
  const lines: PreviewLine[] = [
    { kind: "scene", text: "마을", level: 1, tc: 0 },
    shot(0, "걸어가는 큐 후면"),
    say(11, "큐", "와 예쁘다"),
    shot(40, "돌아보는 큐"),
    { kind: "scene", text: "할 인터뷰", level: 2, tc: 80 },
    shot(80, "큐, 할 2s"),
    foreign(85, "할"),
    say(200, "코", "네 맞습니다"),
  ];
  const rows = clipRows("0101", lines, [80, 150, 150.4, 190], 240, [{ label: "할", look: "모자 쓴 할아버지", from: 80, to: 240, turns: 1 }]);
  const body = rows.map((r) => r.text);
  expect(body.slice(body.lastIndexOf("-".repeat(103)) + 1)).toEqual([
    "# 마을",
    "0000\t■ 걸어가는 큐 후면 (1:20)",
    "0011\t큐\t와 예쁘다",
    "0040\t· 돌아보는 큐",
    "# - 할 인터뷰",
    "0120\t■ 큐, 할 2s (1:10)",
    "0125\t할\t@@(조)",
    // Two files with no line of their own: the picture went on. The 0.4 s piece between two cuts is no file.
    "0230\t■ 이어서 (0:40)",
    "0310\t■ 이어서 (0:50)",
    "0320\t코\t네 맞습니다",
    "0400\t영상종료",
  ]);
  expect(body).toContain("할\t모자 쓴 할아버지 (0120~)");
  expect(rows.filter((r) => r.style === "clip").length).toBe(4);
});

test("scene lines have two levels; the document starts with a place", () => {
  const lines = [shot(0, "a"), say(5, "큐", "b"), shot(200, "c"), say(205, "큐", "d")];
  const out = applyScenes(lines, { scenes: [{ first_line: 1, level: 2, title: "마을 sk" }, { first_line: 3, level: 2, title: "검남 인터뷰" }] });
  expect(out.filter((l) => l.kind === "scene").map((l) => renderLine(l))).toEqual(["# 마을 sk", "# - 검남 인터뷰"]);
});
