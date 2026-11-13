// The preview document: as text, and as HWPX in the look of an earlier preview.
//
// The HWPX is made from a template: an earlier preview of the same programme
// (.hwpx). Page setup, fonts and styles come from it; the body is replaced.
// The writer reads which styles the template uses for the title, the scene
// lines and the body lines from the template's own paragraphs.
import AdmZip from "adm-zip";
import fs from "fs";
import { tcShown, type StyleOptions } from "./assemble";
import { renderLine, tcText, type PreviewLine } from "./gt";

export interface Row {
  text: string;
  style: "rule" | "title" | "scene" | "body";
}

const RULE = "-".repeat(103);

/** The rows of the document, in the layout of the human previews. */
export function documentRows(title: string, lines: PreviewLine[], durationSec: number, style: StyleOptions): Row[] {
  const rows: Row[] = [
    { text: RULE, style: "rule" },
    { text: title, style: "title" },
    { text: RULE, style: "rule" },
  ];
  for (const l of lines) if (l.kind === "scene") rows.push({ text: `# ${l.text}`, style: "scene" });
  rows.push({ text: RULE, style: "rule" });
  const shown = tcShown(lines, style);
  let first = true;
  lines.forEach((l, i) => {
    if (l.kind === "scene") {
      if (!first) rows.push({ text: "", style: "body" });
      first = false;
      rows.push({ text: `# ${l.text}`, style: "scene" });
    } else rows.push({ text: renderLine(l, shown[i]), style: "body" });
  });
  rows.push({ text: `${tcText(durationSec)}\t영상종료`, style: "body" });
  return rows;
}

export function writeTxt(rows: Row[], outPath: string) {
  fs.writeFileSync(outPath, `${rows.map((r) => r.text).join("\n")}\n`);
}

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

interface Proto {
  /** Opening tag of the paragraph. */
  open: string;
  charPr: string;
}

function proto(para: string): Proto {
  const open = para.match(/^<hp:p\b[^>]*>/)![0];
  // The run that holds the text (the first paragraph has a run with section settings before it).
  const runs = [...para.matchAll(/<hp:run\s+charPrIDRef="(\d+)"/g)];
  const withText = para.match(/<hp:run\s+charPrIDRef="(\d+)">(?:(?!<\/hp:run>).)*<hp:t>/s);
  return { open, charPr: withText?.[1] ?? runs[runs.length - 1]?.[1] ?? "0" };
}

/**
 * Writes the rows as HWPX with the page setup and styles of `templatePath`.
 * The template must be a preview in the usual layout: a rule, the title, a
 * rule, "# scene" lines, and body lines with tabs.
 */
export function writeHwpx(rows: Row[], templatePath: string, outPath: string) {
  const zip = new AdmZip(templatePath);
  const entry = zip.getEntry("Contents/section0.xml");
  if (!entry) throw new Error(`Contents/section0.xml not found in ${templatePath}`);
  const xml = entry.getData().toString("utf-8");
  const head = xml.slice(0, xml.indexOf("<hp:p "));
  const paras = [...xml.matchAll(/<hp:p\b[^>]*>.*?<\/hp:p>/gs)].map((m) => m[0]);
  const textOf = (p: string) => [...p.matchAll(/<hp:t>(.*?)<\/hp:t>/gs)].map((m) => m[1].replace(/<[^>]+>/g, "")).join("");
  const firstPara = paras[0];
  const titlePara = paras.find((p, i) => i > 0 && textOf(p).trim() && !/^-+$/.test(textOf(p).trim()));
  const rulePara = paras.find((p, i) => i > 0 && /^-{5,}$/.test(textOf(p).trim()));
  const scenePara = paras.find((p) => textOf(p).trim().startsWith("#"));
  const bodyPara = paras.find((p) => p.includes("<hp:tab") && /\d{4}/.test(textOf(p)));
  if (!firstPara || !titlePara || !scenePara || !bodyPara) throw new Error(`${templatePath} does not look like a preview document (no title, "# scene" line or body line found)`);
  const tab = bodyPara.match(/<hp:tab\b[^>]*\/>/)![0];
  const protos: Record<Row["style"], Proto> = {
    title: proto(titlePara),
    rule: proto(rulePara ?? bodyPara),
    scene: proto(scenePara),
    body: proto(bodyPara),
  };
  const para = (r: Row) => {
    const p = protos[r.style];
    if (!r.text) return `${p.open}<hp:run charPrIDRef="${p.charPr}"/></hp:p>`;
    const t = r.text.split("\t").map(esc).join(tab);
    return `${p.open}<hp:run charPrIDRef="${p.charPr}"><hp:t>${t}</hp:t></hp:run></hp:p>`;
  };
  // The first paragraph carries the section settings (page size, margins,
  // page number). It is the top rule of the document and stays as it is.
  const body = rows.slice(1).map(para).join("");
  const out = `${head}${firstPara}${body}</hs:sec>`;
  zip.updateFile("Contents/section0.xml", Buffer.from(out, "utf-8"));
  // A preview image of the template would show the old text.
  for (const e of zip.getEntries()) {
    if (/^Preview\//.test(e.entryName)) zip.deleteFile(e.entryName);
  }
  // See src/hwpx.ts: hwp2hwpx sets the data-descriptor flag, adm-zip writes no descriptor.
  for (const e of zip.getEntries()) e.header.flags_desc = false;
  zip.writeZip(outPath);
}
