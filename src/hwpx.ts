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

export function extractHwpx(filePath: string): HwpxData {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry("Contents/section0.xml");
  if (!entry) throw new Error("Contents/section0.xml not found in HWPX");
  const xml = entry.getData().toString("utf-8");
  const boldIds = extractBoldIds(zip);
  return { zip, xml, filePath, boldIds };
}

export function repackHwpx(data: HwpxData, newXml: string): string {
  data.zip.updateFile("Contents/section0.xml", Buffer.from(newXml, "utf-8"));

  // hwp2hwpx output sets the data-descriptor flag (bit 3) on every entry.
  // adm-zip keeps the flag but writes CRC/sizes into the local header and no
  // descriptor, so the result is a zip that adm-zip itself (and any strict
  // reader) rejects. Clear the flag to match what is actually written.
  for (const entry of data.zip.getEntries()) {
    entry.header.flags_desc = false;
  }

  const ext = path.extname(data.filePath);
  const base = data.filePath.slice(0, -ext.length);
  const outPath = `${base}_translated${ext}`;

  data.zip.writeZip(outPath);
  return outPath;
}
