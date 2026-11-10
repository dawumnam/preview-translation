// A pass can come back with finishReason=STOP and valid JSON, but stop part
// way through the clip. On 1103, passes 2 and 3 of chunk 01bbba ended at 1:34
// of a 3:34 clip (18 and 16 utterances, against 60 in pass 1). Nothing failed,
// so stt_chunks.ts counted them as done and merge_stt.ts merged them.
//
// One pass cannot tell a cut-off transcript from a quiet end of the clip, so
// the check compares passes: a pass is truncated when another pass of the same
// chunk continues for more than GAP_SEC after it ends, with at least MIN_UTTS
// more utterances in that time.
//
// On 1103, good passes of the same chunk ended within 1s of each other in 18 of
// 19 chunks. In 04aba one pass alone heard 2 short lines ("포토 타임") 35s after
// the others stopped; that is a quiet tail, not a cut. The cut-off 01bbba passes
// were 120s short, with 44 utterances in the full pass after that point.
// MIN_UTTS = 5 keeps the first case out and catches the second. A missed tail
// is cheap anyway: merge_stt.ts still takes those lines from the other pass.

export const GAP_SEC = 30;
export const MIN_UTTS = 5;

export interface PassUtterances {
  pass: string;
  utterances: { start_sec: number; end_sec: number }[];
}

const clip = (sec: number) => {
  const m = Math.floor(sec / 60);
  return `${m}:${(sec - m * 60).toFixed(1).padStart(4, "0")}`;
};

/** Returns pass name → reason, for each pass that looks cut off. */
export function findTruncated(passes: PassUtterances[]): Map<string, string> {
  const lastEnd = (p: PassUtterances) =>
    p.utterances.reduce((a, u) => Math.max(a, Number(u.end_sec) || 0), 0);
  const out = new Map<string, string>();
  for (const p of passes) {
    const end = lastEnd(p);
    for (const q of passes) {
      if (q === p) continue;
      const qEnd = lastEnd(q);
      const later = q.utterances.filter((u) => Number(u.start_sec) > end).length;
      if (qEnd - end > GAP_SEC && later >= MIN_UTTS) {
        out.set(
          p.pass,
          `ends at ${clip(end)} (${p.utterances.length} utterances), but ${q.pass} goes on to ${clip(qEnd)} with ${later} more`,
        );
        break;
      }
    }
  }
  return out;
}
