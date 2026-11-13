// The editor step: from the detailed machine log to the lines that a human
// writer would keep, and the lines that show a timecode.
//
// The watch step writes down every shot change, every action and every turn.
// A human 프리뷰어 writes fewer lines, and puts a TC on some lines only. Which
// lines, is a habit and not a fixed rule: no signal in picture or sound decides
// it (see README, "Where the writers put a TC line"). So this step learns the
// habit from examples: stretches of other episodes for which both the machine
// log and the human preview exist. A text model gets those pairs and the
// machine log of the new episode, and says for each machine line if it stays
// and if it shows its TC.
import { callJson } from "../src/llm";
import type { GtLine, PreviewLine } from "./gt";

export interface EditExample {
  /** What kind of footage this is, in a few words. */
  title: string;
  /** The machine log of the stretch (lines in time order). */
  machine: PreviewLine[];
  /** The human preview of the same stretch. */
  human: GtLine[];
}

interface EditAnswer {
  lines: { id: number; keep: boolean; tc: boolean }[];
}

const EDIT_SCHEMA = {
  type: "OBJECT",
  properties: {
    lines: {
      type: "ARRAY",
      items: {
        type: "OBJECT",
        properties: {
          id: { type: "INTEGER", description: "The number of the machine line" },
          keep: { type: "BOOLEAN", description: "true when the 프리뷰어 would write this line" },
          tc: { type: "BOOLEAN", description: "true when the line stays and shows its timecode" },
        },
        required: ["id", "keep", "tc"],
        propertyOrdering: ["id", "keep", "tc"],
      },
    },
  },
  required: ["lines"],
};

const mmss = (sec: number, origin = 0) => {
  const s = Math.max(0, Math.round(sec - origin));
  return `${String(Math.floor(s / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
};

const cut = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** One machine line for the prompt. `origin` makes the times start at 00:00 in each stretch. */
function machineRow(l: PreviewLine, id: number, origin: number): string {
  const t = `[${mmss(l.tc ?? 0, origin)}]`;
  if (l.kind === "shot") return `${id} ${t} SHOT${l.tcDoc !== undefined ? " (new camera file)" : ""}: ${l.text}`;
  if (l.kind === "foreign") return `${id} ${t} ${l.speaker}: @@`;
  return `${id} ${t} ${l.speaker}: ${cut(l.text, 60)}`;
}

function humanRow(l: GtLine, origin: number): string {
  const t = l.tc !== undefined ? `[${mmss(l.tc, origin)}]` : "[  -  ]";
  if (l.kind === "shot") return `${t} SHOT: ${l.text}`;
  if (l.kind === "foreign") return `${t} ${l.speaker}: @@`;
  return `${t} ${l.speaker}: ${cut(l.text, 60)}`;
}

export function buildEditPrompt(examples: EditExample[], target: PreviewLine[], firstId: number): string {
  const ex = examples
    .map((e, i) => {
      const origin = Math.min(...e.machine.map((l) => l.tc ?? Infinity));
      return `### Example ${i + 1}: ${e.title}\nMachine log:\n${e.machine.map((l, k) => machineRow(l, k + 1, origin)).join("\n")}\n\nThe 프리뷰어's version of the same footage:\n${e.human.map((l) => humanRow(l, origin)).join("\n")}`;
    })
    .join("\n\n");
  const origin = Math.min(...target.map((l) => l.tc ?? Infinity));
  return `A machine logged raw footage of a Korean TV travel documentary in full detail: every change of shot, every action, every spoken turn, each with its time. A human 프리뷰어 (footage logger) writes a shorter log of the same footage: fewer shot lines, and a timecode on some lines only. Your task is to edit a machine log into the version that the 프리뷰어 would write.

How to read the logs:
- \`SHOT\` is a line about the picture. \`(new camera file)\` means that the picture jumps there: a new recording starts.
- Other lines are speech: speaker, then the words. \`@@\` is a turn in a foreign language (the words are not written). 큐 is the host, 코 the interpreter, 피 the director, 카감 the camera director; other labels are locals. \`디렉\` stands for directions of the crew.
- In the 프리뷰어's version, \`[mm:ss]\` is a line with a timecode and \`[  -  ]\` is a line with no timecode.

What is known about the 프리뷰어's habits (measured on nine episodes):
- Every shot line has a timecode. About 4 in 10 Korean speech lines and 1 in 4 \`@@\` lines have one. A \`디렉\` line has none.
- Two timecodes are hardly ever less than 5 seconds apart. Most are 10 to 25 seconds apart, few more than 40.
- A speech line gets a timecode when some time has passed since the last timecode: nearly never within 6 seconds, about half of the lines between 9 and 25 seconds, nearly all after 25 seconds. The host's lines get one sooner than other lines.
- About half of the shot lines stand where a new camera file starts. The other half are notes inside a running recording: what the people do now, a new subject, a new framing. There are about two times as many of them for each minute when nobody speaks as during talk. During an interview or a conversation in one place the 프리뷰어 writes the speech and nearly no shot lines.
- Takes: each new take of the same action gets its shot line again, also with the same words.

The examples show a machine log and the 프리뷰어's version of the same footage. Study which machine lines the 프리뷰어 has, which not, and which lines carry a timecode.

${ex}

## Your task
Edit the machine log below in the same way. For each machine line give:
- \`keep\`: true when the 프리뷰어 would write this line. Speech lines stay, except small talk and single words that the 프리뷰어 leaves out in the examples. Decide for each SHOT line by the habits above and the examples.
- \`tc\`: true when the line stays and shows its timecode. A SHOT line that stays always has tc true.
Return one entry for each machine line, ids ${firstId} to ${firstId + target.length - 1}, in order.

Machine log:
${target.map((l, k) => machineRow(l, firstId + k, origin)).join("\n")}`;
}

export interface EditResult {
  lines: PreviewLine[];
  /** Chunks for which the model gave no usable answer: their lines stay as the fallback made them. */
  failed: number;
}

/**
 * Edits the machine lines chunk by chunk (about `chunkSec` seconds each; a
 * chunk ends at a new camera file). `fallback` gives the lines of a chunk when
 * the model does not answer (the clock rule of assemble.ts).
 */
export async function editLines(
  machine: PreviewLine[],
  examples: EditExample[],
  model: string,
  fallback: (chunk: PreviewLine[]) => PreviewLine[],
  chunkSec = 420,
  thinkingLevel: "LOW" | "MEDIUM" | "HIGH" = "LOW",
): Promise<EditResult> {
  const chunks: PreviewLine[][] = [];
  let cur: PreviewLine[] = [];
  for (const l of machine) {
    const start = cur[0]?.tc ?? l.tc ?? 0;
    const long = (l.tc ?? 0) - start >= chunkSec;
    // A chunk ends at a new camera file when it is long enough, and in any case at 1.5 times the length.
    if (cur.length && ((long && l.kind === "shot" && l.tcDoc !== undefined) || (l.tc ?? 0) - start >= chunkSec * 1.5)) {
      chunks.push(cur);
      cur = [];
    }
    cur.push(l);
  }
  if (cur.length) chunks.push(cur);

  let failed = 0;
  const done = await Promise.all(
    chunks.map(async (chunk): Promise<PreviewLine[]> => {
      const r = await callJson<EditAnswer>({
        model,
        parts: [{ text: buildEditPrompt(examples, chunk, 1) }],
        schema: EDIT_SCHEMA,
        thinkingLevel,
        timeoutMs: 180_000,
        hedgeAfterMs: [60_000],
        attempts: 3,
        label: `edit ${Math.round(chunk[0].tc ?? 0)}`,
      });
      const byId = new Map((r.value?.lines ?? []).map((x) => [x.id, x]));
      // An answer that leaves out more than a tenth of the lines is not used.
      if (!r.value || chunk.filter((_, k) => byId.has(k + 1)).length < chunk.length * 0.9) {
        failed++;
        return fallback(chunk);
      }
      const out: PreviewLine[] = [];
      chunk.forEach((l, k) => {
        const d = byId.get(k + 1);
        // A line with no decision stays; a new camera file always stays.
        const keep = d ? d.keep || (l.kind === "shot" && l.tcDoc !== undefined) : true;
        if (!keep) return;
        out.push({ ...l, showTc: l.kind === "shot" ? true : !!d?.tc });
      });
      return out;
    }),
  );
  return { lines: done.flat(), failed };
}
