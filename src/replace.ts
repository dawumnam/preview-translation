import type { Translation, TranslationSegment } from "./translate";

function stripLineSegArrays(xml: string): string {
  return xml.replace(/<hp:linesegarray>[\s\S]*?<\/hp:linesegarray>/g, "");
}

// Script-style timecode: MMSS, or HMMSS past one hour (e.g. 10655 = 1:06:55)
function formatTC(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = Math.floor(seconds % 60);
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}${mm}${ss}` : `${mm}${ss}`;
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Placeholder wrapped in private-use-area chars so it can never collide with document text
const PH_OPEN = "";
const PH_CLOSE = "";

interface SplitInfo {
  charPrId: string;
  markerPrefix: string; // e.g. "@@(카)"
  translation: Translation;
}

export function replaceMarkers(
  xml: string,
  translations: Translation[],
  boldIds: Set<string>,
): string {
  // Build map: global marker index -> translation
  const translationMap = new Map<number, Translation>();
  for (const t of translations) {
    translationMap.set(t.markerIndex, t);
  }

  // Match bold <hp:run> containing @@ markers (with optional language code) in document order
  const idPattern = [...boldIds].join("|");
  const regex = new RegExp(
    `(<hp:run\\s+charPrIDRef="(${idPattern})"><hp:t>(?:[^<]|<hp:tab[^/]*\\/>)*)` +
    `(@@(?:\\([^)]+\\))?)[^<]*(</hp:t>)`,
    "g",
  );

  let markerIndex = 0;
  const splits = new Map<number, SplitInfo>();

  // Pass 1: insert first segment into each marker run; tag multi-segment
  // markers with a placeholder for paragraph insertion in pass 2
  let newXml = xml.replace(
    regex,
    (
      _match,
      prefix: string,
      charPrId: string,
      markerPrefix: string,
      suffix: string,
    ) => {
      const t = translationMap.get(markerIndex);
      const idx = markerIndex;
      markerIndex++;

      if (!t) {
        // No translation: keep marker prefix, strip any hint/range text
        return `${prefix}${markerPrefix}${suffix}`;
      }

      const segments = getSegments(t);
      const confidenceSuffix = t.confidence === "low" ? " ??" : "";
      const first = segments[0];

      let placeholder = "";
      if (segments.length > 1) {
        splits.set(idx, { charPrId, markerPrefix, translation: t });
        placeholder = `${PH_OPEN}SPLIT${idx}${PH_CLOSE}`;
      }

      return `${prefix}${markerPrefix} ${escapeXml(first.text)}${confidenceSuffix}${placeholder}${suffix}`;
    },
  );

  // Pass 2: for each multi-segment marker, clone its paragraph for segments 2..N,
  // each prefixed with its own timecode
  for (const [idx, info] of splits) {
    const ph = `${PH_OPEN}SPLIT${idx}${PH_CLOSE}`;
    const pos = newXml.indexOf(ph);
    if (pos === -1) continue;

    const paraStart = newXml.lastIndexOf("<hp:p", pos);
    const paraOpenEnd = newXml.indexOf(">", paraStart) + 1;
    const paraOpen = newXml.slice(paraStart, paraOpenEnd);
    const paraEnd = newXml.indexOf("</hp:p>", pos) + "</hp:p>".length;

    const t = info.translation;
    const segments = getSegments(t);
    const confidenceSuffix = t.confidence === "low" ? " ??" : "";

    const clones = segments
      .slice(1)
      .map((seg) => {
        const tc = formatTC(seg.timestamp);
        return (
          `${paraOpen}<hp:run charPrIDRef="${info.charPrId}"><hp:t>` +
          `${tc}<hp:tab width="1000" leader="0" type="1"/>` +
          `${escapeXml(t.charName)}<hp:tab width="1000" leader="0" type="1"/>` +
          `${info.markerPrefix} ${escapeXml(seg.text)}${confidenceSuffix}` +
          `</hp:t></hp:run></hp:p>`
        );
      })
      .join("");

    newXml =
      newXml.slice(0, paraEnd).replace(ph, "") +
      clones +
      newXml.slice(paraEnd);
  }

  // Strip cached line layout metrics so the viewer recalculates for new text lengths
  return stripLineSegArrays(newXml);
}

function getSegments(t: Translation): TranslationSegment[] {
  if (t.segments && t.segments.length > 0) {
    return [...t.segments].sort((a, b) => a.timestamp - b.timestamp);
  }
  return [{ timestamp: t.timestamp, text: t.translation ?? "" }];
}
