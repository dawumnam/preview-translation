import AdmZip from "adm-zip";
import path from "path";

export interface HwpxData {
  zip: AdmZip;
  xml: string;
  filePath: string;
  boldIds: Set<string>;
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

// Every charPr id used by a run that actually contains "@@".
//
// Markers used to be recognised by bold alone, but writers bold inconsistently:
// on 0907 only 53 of 221 markers were bold, and the bold ones sat in the middle
// of interviews whose other turns were plain — same speakers, same exchange.
// The "@@" is the marker; the formatting is decoration. Set MARKER_BOLD_ONLY=1
// to restore the old bold-only behaviour.
export function extractMarkerCharPrIds(xml: string): Set<string> {
  const ids = new Set<string>();
  const re = /<hp:run\s+charPrIDRef="(\d+)">(.*?)<\/hp:run>/gs;
  let m;
  while ((m = re.exec(xml))) {
    if (m[2].replace(/<[^>]+>/g, "").includes("@@")) ids.add(m[1]);
  }
  return ids;
}

export function extractHwpx(filePath: string): HwpxData {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry("Contents/section0.xml");
  if (!entry) throw new Error("Contents/section0.xml not found in HWPX");
  const xml = entry.getData().toString("utf-8");
  const boldIds =
    process.env.MARKER_BOLD_ONLY === "1"
      ? extractBoldIds(zip)
      : extractMarkerCharPrIds(xml);
  return { zip, xml, filePath, boldIds };
}

export function repackHwpx(data: HwpxData, newXml: string): string {
  data.zip.updateFile("Contents/section0.xml", Buffer.from(newXml, "utf-8"));

  const ext = path.extname(data.filePath);
  const base = data.filePath.slice(0, -ext.length);
  const outPath = `${base}_translated${ext}`;

  data.zip.writeZip(outPath);
  return outPath;
}
