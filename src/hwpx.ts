import AdmZip from "adm-zip";
import path from "path";
import { DEFAULT_SELECT, parseSelect, readStyles, selectIds, type CharStyle, type Rule } from "./select";

export interface HwpxData {
  zip: AdmZip;
  xml: string;
  filePath: string;
  /** The character styles of the document, by id. */
  styles: Map<string, CharStyle>;
  /** Which @@ lines are requested, and the ids of the styles that match. */
  rule: Rule;
  selectedIds: Set<string>;
}

/**
 * Opens a script. `select` says in plain words which text style marks the
 * requested @@ lines (see select.ts). The default is "bold".
 */
export function extractHwpx(filePath: string, select: string = DEFAULT_SELECT): HwpxData {
  const zip = new AdmZip(filePath);
  const entry = zip.getEntry("Contents/section0.xml");
  if (!entry) throw new Error("Contents/section0.xml not found in HWPX");
  const xml = entry.getData().toString("utf-8");
  const header = zip.getEntry("Contents/header.xml");
  const styles = readStyles(header ? header.getData().toString("utf-8") : "");
  const rule = parseSelect(select);
  return { zip, xml, filePath, styles, rule, selectedIds: selectIds(styles, rule) };
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
