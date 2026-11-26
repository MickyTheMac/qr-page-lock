/**
 * Incremental updates: append a new revision to a PDF without touching a single earlier byte,
 * so earlier signatures (and the original sealed file) stay intact. Classic cross-reference tables only.
 */
import { PDFObject, PDFRef } from "pdf-lib";
import { utf8, concatBytes } from "../encoding";

const latin1 = (b: Uint8Array) => new TextDecoder("latin1").decode(b);

/** Byte offsets just after each "%%EOF" marker, in file order. Each one ends a saved revision. */
export function revisionEnds(bytes: Uint8Array): number[] {
  const s = latin1(bytes);
  const out: number[] = [];
  let i = s.indexOf("%%EOF");
  while (i !== -1) {
    out.push(i + 5);
    i = s.indexOf("%%EOF", i + 5);
  }
  return out;
}

/** Length of the end-of-line marker (0, 1 or 2) at a position; used to tolerate a trailing newline after %%EOF. */
export function eolLength(bytes: Uint8Array, at: number): number {
  if (bytes[at] === 0x0d && bytes[at + 1] === 0x0a) return 2;
  if (bytes[at] === 0x0a || bytes[at] === 0x0d) return 1;
  return 0;
}

export function lastStartXref(bytes: Uint8Array): number {
  const tail = latin1(bytes.subarray(Math.max(0, bytes.length - 2048)));
  const m = [...tail.matchAll(/startxref\s+(\d+)\s+%%EOF/g)].pop();
  if (!m) throw new Error("The PDF has no readable cross-reference pointer.");
  return Number(m[1]);
}

export function serializeObject(obj: PDFObject): Uint8Array {
  const buf = new Uint8Array(obj.sizeInBytes());
  obj.copyBytesInto(buf, 0);
  return buf;
}

export interface NewObject {
  ref: PDFRef;
  body: Uint8Array; // serialized object (without "n g obj" / "endobj")
}

export interface TrailerFields {
  size: number;
  root: PDFRef;
  info?: PDFObject;
  id?: PDFObject;
}

/**
 * Appends one revision. The new revision starts with a newline and ends exactly at "%%EOF" (no trailing newline),
 * so a signature's byte range can end exactly at the end of its revision.
 */
export function appendRevision(prev: Uint8Array, objects: NewObject[], trailer: TrailerFields): { bytes: Uint8Array; offsets: Map<string, number> } {
  const prevXref = lastStartXref(prev);
  const chunks: Uint8Array[] = [prev, utf8("\n")];
  let pos = prev.length + 1;
  const offsets = new Map<string, number>();
  const entries: { num: number; gen: number; offset: number }[] = [];
  for (const o of objects) {
    const head = utf8(`${o.ref.objectNumber} ${o.ref.generationNumber} obj\n`);
    const tail = utf8("\nendobj\n");
    offsets.set(o.ref.toString(), pos);
    entries.push({ num: o.ref.objectNumber, gen: o.ref.generationNumber, offset: pos });
    chunks.push(head, o.body, tail);
    pos += head.length + o.body.length + tail.length;
  }
  entries.sort((a, b) => a.num - b.num);
  let xref = "xref\n";
  for (let i = 0; i < entries.length; ) {
    let j = i;
    while (j + 1 < entries.length && entries[j + 1].num === entries[j].num + 1) j++;
    xref += `${entries[i].num} ${j - i + 1}\n`;
    for (let k = i; k <= j; k++) xref += `${String(entries[k].offset).padStart(10, "0")} ${String(entries[k].gen).padStart(5, "0")} n\r\n`;
    i = j + 1;
  }
  const t = [`/Size ${trailer.size}`, `/Root ${trailer.root.toString()}`];
  if (trailer.info) t.push(`/Info ${trailer.info.toString()}`);
  if (trailer.id) t.push(`/ID ${trailer.id.toString()}`);
  t.push(`/Prev ${prevXref}`);
  const xrefOffset = pos;
  chunks.push(utf8(`${xref}trailer\n<< ${t.join(" ")} >>\nstartxref\n${xrefOffset}\n%%EOF`));
  return { bytes: concatBytes(chunks), offsets };
}
