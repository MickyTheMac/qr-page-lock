/** Tampering helpers used by the acceptance tests and the fixture generator. */
import { PDFArray, PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef, decodePDFRawStream } from "pdf-lib";
import { qrBitmap } from "../pagelock/qr";

export async function load(bytes: Uint8Array) {
  return PDFDocument.load(bytes, { updateMetadata: false });
}
export async function save(doc: PDFDocument) {
  return doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
}

function xobjects(doc: PDFDocument, pageIdx: number) {
  const leaf = doc.getPages()[pageIdx].node;
  const res = doc.context.lookup(leaf.get(PDFName.of("Resources")), PDFDict);
  return res.lookup(PDFName.of("XObject"), PDFDict);
}

function latin1(b: Uint8Array) {
  return Array.from(b, (c) => String.fromCharCode(c)).join("");
}
function fromLatin1(s: string) {
  return Uint8Array.from(s, (c) => c.charCodeAt(0));
}

/** Replace a stream's decoded content, keeping its dictionary. */
function rewriteStream(doc: PDFDocument, ref: PDFRef, edit: (s: string) => string) {
  const stream = doc.context.lookup(ref) as PDFRawStream;
  const decoded = latin1(decodePDFRawStream(stream).decode());
  const next = edit(decoded);
  if (next === decoded) throw new Error("tamper: edit had no effect");
  const dict: Record<string, unknown> = {};
  for (const [k, v] of stream.dict.entries()) {
    const key = k.decodeText();
    if (key !== "Length" && key !== "Filter" && key !== "DecodeParms") dict[key] = v;
  }
  doc.context.assign(ref, doc.context.flateStream(fromLatin1(next), dict as never));
}

const hexOf = (s: string) => Array.from(s, (c) => c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")).join("");

/** Change one character in the sealed original content of a page ("50%" -> "60%" on page 1). */
export async function changeCharacter(prepared: Uint8Array, pageIdx = 0, from = "50%", to = "60%") {
  const doc = await load(prepared);
  const ref = xobjects(doc, pageIdx).get(PDFName.of("PLOrig")) as PDFRef;
  rewriteStream(doc, ref, (s) => s.replace(hexOf(from), hexOf(to)));
  return save(doc);
}

/** Copy page `from`'s footer (QR + text) onto page `to`. */
export async function copyQr(prepared: Uint8Array, from = 0, to = 1) {
  const doc = await load(prepared);
  xobjects(doc, to).set(PDFName.of("PLFoot"), xobjects(doc, from).get(PDFName.of("PLFoot"))!);
  return save(doc);
}

/** Replace page `idx` with page `idx` of another PDF (sealed or not). */
export async function replacePage(prepared: Uint8Array, other: Uint8Array, idx = 1) {
  const doc = await load(prepared);
  const src = await load(other);
  const [p] = await doc.copyPages(src, [idx]);
  doc.removePage(idx);
  doc.insertPage(idx, p);
  return save(doc);
}

export async function insertPage(prepared: Uint8Array, other: Uint8Array, at = 1, srcIdx = 0) {
  const doc = await load(prepared);
  const src = await load(other);
  const [p] = await doc.copyPages(src, [srcIdx]);
  doc.insertPage(at, p);
  return save(doc);
}

export async function deletePage(prepared: Uint8Array, idx = 1) {
  const doc = await load(prepared);
  doc.removePage(idx);
  return save(doc);
}

export async function swapPages(prepared: Uint8Array, a = 1, b = 2) {
  const doc = await load(prepared);
  const pages = await doc.copyPages(doc, [a, b]);
  const [lo, hi] = a < b ? [a, b] : [b, a];
  doc.removePage(hi);
  doc.removePage(lo);
  doc.insertPage(lo, pages[1]);
  doc.insertPage(hi, pages[0]);
  return save(doc);
}

/** Draw a white box over part of the page via the page's own content (e.g. to hide a clause). */
export async function overlayBox(prepared: Uint8Array, pageIdx = 0) {
  const doc = await load(prepared);
  const leaf = doc.getPages()[pageIdx].node;
  rewriteStream(doc, leaf.get(PDFName.of("Contents")) as PDFRef, (s) => s + "q 1 g 60 600 480 60 re f Q\n");
  return save(doc);
}

/** Edit the human-readable footer text (e.g. change "Page 1 of 3"). */
export async function editFooterText(prepared: Uint8Array, pageIdx = 0) {
  const doc = await load(prepared);
  const ref = xobjects(doc, pageIdx).get(PDFName.of("PLFoot")) as PDFRef;
  rewriteStream(doc, ref, (s) => s.replace(/Page (\d+) of (\d+)/, "Page $1 of 9"));
  return save(doc);
}

/** Add a sticky-note style annotation on top of a page. */
export async function addAnnotation(prepared: Uint8Array, pageIdx = 0) {
  const doc = await load(prepared);
  const annot = doc.context.register(
    doc.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [100, 500, 400, 560], Contents: "Equity now 70/30", DA: "/Helv 12 Tf 0 g" }),
  );
  doc.getPages()[pageIdx].node.addAnnot(annot);
  return save(doc);
}

/** Append an incremental update (how most PDF editors save small edits), changing the document title. */
export function appendIncrementalUpdate(prepared: Uint8Array): Uint8Array {
  const s = latin1(prepared);
  const startxref = Number(/startxref\s+(\d+)\s+%%EOF\s*$/.exec(s)![1]);
  const size = Number(/\/Size (\d+)/.exec(s.slice(s.lastIndexOf("trailer")))![1]);
  const root = /\/Root (\d+ \d+ R)/.exec(s.slice(s.lastIndexOf("trailer")))![1];
  const objOffset = prepared.length + 1;
  const obj = `\n${size} 0 obj\n<< /Title (Edited after sealing) >>\nendobj\n`;
  const xrefOffset = prepared.length + obj.length;
  const tail =
    `xref\n0 1\n0000000000 65535 f \n${size} 1\n${String(objOffset).padStart(10, "0")} 00000 n \n` +
    `trailer\n<< /Size ${size + 1} /Root ${root} /Info ${size} 0 R /Prev ${startxref} >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return fromLatin1(s + obj + tail);
}

/** Corrupt the QR image data on a page (keeps the dictionary valid). */
export async function scrambleQr(prepared: Uint8Array, pageIdx = 0) {
  const doc = await load(prepared);
  const foot = doc.context.lookup(xobjects(doc, pageIdx).get(PDFName.of("PLFoot"))) as PDFRawStream;
  const res = doc.context.lookup(foot.dict.get(PDFName.of("Resources")), PDFDict);
  const qrRef = res.lookup(PDFName.of("XObject"), PDFDict).get(PDFName.of("PLQR")) as PDFRef;
  const img = doc.context.lookup(qrRef) as PDFRawStream;
  const w = (img.dict.get(PDFName.of("Width")) as unknown as { asNumber(): number }).asNumber();
  const blank = new Uint8Array(Math.ceil(w / 8) * w).fill(0xff);
  doc.context.assign(qrRef, doc.context.flateStream(blank, { Type: "XObject", Subtype: "Image", Width: w, Height: w, ColorSpace: "DeviceGray", BitsPerComponent: 1 }));
  return save(doc);
}

/** Replace a page's QR code with a valid code for different text (same image settings). */
export async function replaceQrText(prepared: Uint8Array, pageIdx: number, text: string) {
  const doc = await load(prepared);
  const foot = doc.context.lookup(xobjects(doc, pageIdx).get(PDFName.of("PLFoot"))) as PDFRawStream;
  const res = doc.context.lookup(foot.dict.get(PDFName.of("Resources")), PDFDict);
  const qrRef = res.lookup(PDFName.of("XObject"), PDFDict).get(PDFName.of("PLQR")) as PDFRef;
  const q = qrBitmap(text, 0);
  doc.context.assign(qrRef, doc.context.flateStream(q.bits, { Type: "XObject", Subtype: "Image", Width: q.size, Height: q.size, ColorSpace: "DeviceGray", BitsPerComponent: 1 }));
  return save(doc);
}

/** Simply open and re-save with another tool (pdf-lib). Pages are untouched; bytes change. */
export async function resave(prepared: Uint8Array) {
  return save(await load(prepared));
}

/** Edit the wording of an UNSEALED original (an attacker preparing a forged copy). */
export async function changeOriginalCharacter(original: Uint8Array, pageIdx = 0, from = "50%", to = "60%") {
  const doc = await load(original);
  const leaf = doc.getPages()[pageIdx].node;
  const contents = doc.context.lookup(leaf.get(PDFName.of("Contents")));
  const refs = contents instanceof PDFArray ? (contents.asArray() as PDFRef[]) : [leaf.get(PDFName.of("Contents")) as PDFRef];
  let done = false;
  for (const r of refs) {
    try {
      rewriteStream(doc, r, (s) => s.replace(hexOf(from), hexOf(to)));
      done = true;
    } catch {
      /* not in this stream */
    }
  }
  if (!done) throw new Error("tamper: text not found");
  return save(doc);
}

/** Change only document metadata (outside the visible pages). */
export async function changeMetadata(prepared: Uint8Array) {
  const doc = await load(prepared);
  doc.setTitle("Renamed by someone else");
  return save(doc);
}

/** Remove the embedded manifest from the catalog. */
export async function removeEmbeddedManifest(prepared: Uint8Array) {
  const doc = await load(prepared);
  doc.catalog.delete(PDFName.of("PLManifest"));
  return save(doc);
}

/** Rewrite the embedded manifest (e.g. to claim a different page count). */
export async function editEmbeddedManifest(prepared: Uint8Array, edit: (body: Record<string, unknown>) => void) {
  const doc = await load(prepared);
  const ref = doc.catalog.get(PDFName.of("PLManifest")) as PDFRef;
  rewriteStream(doc, ref, (s) => {
    const body = JSON.parse(s);
    edit(body);
    return JSON.stringify(body);
  });
  return save(doc);
}
