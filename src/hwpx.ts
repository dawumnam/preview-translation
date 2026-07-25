import AdmZip from "adm-zip";
import path from "path";

export interface HwpxData {
  zip: AdmZip;
  xml: string;
  filePath: string;
  markerStyleIds: Set<string>;
}

export function extractBoldIds(zip: AdmZip): Set<string> {
  const header = zip.getEntry("Contents/header.xml");
  if (!header) return new Set();
  const headerXml = header.getData().toString("utf-8");
  const ids = new Set<string>();
  const re = /<hh:charPr\s+id="(\d+)"[\s\S]*?<\/hh:charPr>/g;
  let m;
  while ((m = re.exec(headerXml))) {
    if (m[0].includes("<hh:bold")) ids.add(m[1]);
  }
  return ids;
}

// Markers are normally bold. Excerpt files pasted out of a full script sometimes
// lose that styling, so fall back to whichever styles actually carry an @@ marker.
export function resolveMarkerStyleIds(
  xml: string,
  boldIds: Set<string>,
): Set<string> {
  const markerRunIds = new Set<string>();
  const re = /<hp:run\s+charPrIDRef="(\d+)">([\s\S]*?)<\/hp:run>/g;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2].includes("@@")) markerRunIds.add(m[1]);
  }

  const bold = [...markerRunIds].filter((id) => boldIds.has(id));
  return bold.length > 0 ? new Set(bold) : markerRunIds;
}

export function extractHwpx(filePath: string): HwpxData {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry("Contents/section0.xml");
  if (!entry) throw new Error("Contents/section0.xml not found in HWPX");
  const xml = entry.getData().toString("utf-8");
  const markerStyleIds = resolveMarkerStyleIds(xml, extractBoldIds(zip));
  return { zip, xml, filePath, markerStyleIds };
}

export function repackHwpx(data: HwpxData, newXml: string): string {
  data.zip.updateFile("Contents/section0.xml", Buffer.from(newXml, "utf-8"));

  const ext = path.extname(data.filePath);
  const base = data.filePath.slice(0, -ext.length);
  const outPath = `${base}_translated${ext}`;

  data.zip.writeZip(outPath);
  return outPath;
}
