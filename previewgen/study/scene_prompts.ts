// Prompt variants for the scene step (see scenes_eval.ts).
import { clock } from "../../src/script";
import type { GtLine } from "../gt";
import { SCENE_INTRO, SCENE_RULES } from "../scenes";
import type { Body } from "./scenes_eval";

export type Variant = "base" | "fewshot" | "fewshot2" | "levels" | "kinds" | "rules";

export const SCENE_SCHEMA_V = {
  type: "OBJECT",
  properties: {
    scenes: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          first_line: { type: "INTEGER", description: "Number of the first line of the scene" },
          level: { type: "INTEGER", description: "1 = a new place, 2 = a new activity or person at the same place" },
          title: { type: "STRING", description: "Short Korean title in the house style" },
        },
        required: ["first_line", "title"],
        propertyOrdering: ["first_line", "level", "title"],
      },
    },
  },
  required: ["scenes"],
};

function brief(l: GtLine, max = 40): string {
  if (l.kind === "shot") return `shot: ${l.text}`;
  if (l.kind === "foreign") return `${l.speaker}: (외국어)`;
  return `${l.speaker}: ${l.text.length > max ? `${l.text.slice(0, max)}…` : l.text}`;
}

const numbered = (lines: GtLine[]) => lines.map((l, i) => `${i + 1} [${clock(l.tc ?? l.tcPrev)}] ${brief(l)}`).join("\n");

/** A finished log with its "#" lines in place, as an example. */
function example(b: Body, max = 26): string {
  const starts = new Map(b.scenes.map((s) => [s.at, s.title]));
  const out: string[] = [];
  b.lines.forEach((l, i) => {
    if (starts.has(i)) out.push(`# ${starts.get(i)}`);
    out.push(`${i + 1} [${clock(l.tc ?? l.tcPrev)}] ${brief(l, max)}`);
  });
  return out.join("\n");
}

const INTRO = `Below is the preview log of one day of raw footage for a Korean TV travel documentary: shots and spoken turns in time order, each with a line number and a time. 큐 is the host, 피 the director, 카감 the camera director, 코 the coordinator; other labels are locals.

Divide the log into scenes, as the 프리뷰어 does with "# title" lines, and give each scene a title.`;

const RULES = `A scene is a stretch of footage in one place with one activity: the host walks and talks to the camera (all the takes together), a set of scenery shots, a visit to a house, an interview with one person, a meal, a drive. A new scene starts when the place or the activity changes. Takes of the same action are one scene.

The title is a short Korean phrase that ends in a noun, in the style of the shot lines. It names the place or the people and the activity.

Return the scenes in order. \`first_line\` is the number of the first line of the scene. The first scene starts at line 1. A scene starts at a shot line when there is one at the change.`;

const LEVELS = `Below is the preview log of one day of raw footage for a Korean TV travel documentary: shots and spoken turns in time order, each with a line number and a time. 큐 is the host, 피 the director, 카감 the camera director, 코 the coordinator; other labels are locals.

Divide the log into parts on two levels, and give each part a title.

Level 1 is the place. A new level 1 part starts when the crew is at a new place: another village, another house or shop, the road or a car between two places, a walk to the next place. All that happens at one place is one level 1 part, also when it is long.

Level 2 is the activity at that place. Inside a level 1 part, a new level 2 part starts when the main thing in the footage changes for some minutes:
- from takes of the host alone to a meeting or an interview with a local;
- from an interview to a work process that someone shows (they cook, build, harvest), or from one such process to the next;
- to a meal, to a goodbye;
- to a block of scenery or detail shots with no talk (at least five shot lines one after the other, or two minutes), and back from it;
- to another local who becomes the main person.
A part of level 2 is seldom shorter than two minutes. Takes of the same action are one part. Talk between takes and directions do not start a part.

Each level 1 part starts with a first level 2 part at the same line: give that line once, as level 1, with a title that fits the place and the first activity.

The title is a short Korean phrase that ends in a noun, in the style of the shot lines of the log. It names the place or the people and the activity (for example: 마을 sk / 식당 주방, 빵 만드는 / 음식 먹는 큐 / 검남 인터뷰 / 산길 걷는 큐, 산길 sk).

Return the parts in order. \`first_line\` is the number of the first line of the part, \`level\` is 1 or 2. The first part starts at line 1 with level 1. A part starts at a shot line when there is one at the change.`;

/** The "#" lines of a finished log as a table: start, length, shot lines, speech lines, title. */
export function toc(b: Body): string {
  const timeOf = (k: number) => b.lines[Math.min(b.lines.length - 1, k)].tc ?? b.lines[Math.min(b.lines.length - 1, k)].tcPrev;
  const end = timeOf(b.lines.length - 1);
  return b.scenes
    .map((s, i) => {
      const to = b.scenes[i + 1]?.at ?? b.lines.length;
      const part = b.lines.slice(s.at, to);
      const len = ((b.scenes[i + 1] ? timeOf(b.scenes[i + 1].at) : end) - timeOf(s.at)) / 60;
      return `[${clock(timeOf(s.at))}] ${len.toFixed(0)} min, ${part.filter((l) => l.kind === "shot").length} shot lines, ${part.filter((l) => l.kind !== "shot").length} speech lines: # ${s.title}`;
    })
    .join("\n");
}

export function buildScenePromptV(v: Variant, lines: GtLine[], others: Body[], id: string): string {
  if (v === "levels") return `${LEVELS}\n\n## Log\n${numbered(lines)}`;
  // The prompt of scenes.ts as it is: the rules with no example.
  if (v === "rules") return `${SCENE_INTRO}\n\n${SCENE_RULES}\n\n## Log\n${numbered(lines)}`;
  if (v === "kinds") {
    // The scene tables of all other days, and the shortest other day in full.
    const full = [...others].sort((a, b) => a.lines.length - b.lines.length)[0];
    return `${SCENE_INTRO}

${SCENE_RULES}

## Scene tables of other days
The scenes that the 프리뷰어 made for other days of the same programme: start, length, count of lines, title. Learn from them how long a scene is and how a title is worded.

${others.map((b, i) => `### Day ${i + 1}\n${toc(b)}`).join("\n\n")}

## One other day in full
${example(full)}

## The new log
Divide this log. It has no "#" lines yet.
${numbered(lines)}`;
  }
  if (v === "base") {
    return `${INTRO}\n\n${RULES}\n\nA scene is seldom shorter than three minutes; most are 5 to 25 minutes, and two hours of footage have about 6 to 12 scenes.\n\n## Log\n${numbered(lines)}`;
  }
  // The two shortest other episodes as examples (fewer tokens), or four of them.
  const n = v === "fewshot" ? 2 : 4;
  const ex = [...others].sort((a, b) => a.lines.length - b.lines.length).slice(0, n);
  return `${INTRO}

${RULES}

## Examples
These are finished logs of other days of the same programme, with the "# title" lines that the 프리뷰어 wrote. Learn from them how long a scene is, where a scene starts, and how a title is worded. Divide the new log in the same way.

${ex.map((b, i) => `### Example ${i + 1}\n${example(b)}`).join("\n\n")}

## The new log
Divide this log. It has no "#" lines yet.
${numbered(lines)}`;
}
