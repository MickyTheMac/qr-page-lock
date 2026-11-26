/**
 * PL1-PAGE: the versioned, deterministic page representation (brief §5).
 *
 * A page is represented by:
 *   1. its box (MediaBox: llx lly urx ury),
 *   2. its fully decoded content stream bytes (multiple streams joined with a single LF),
 *   3. a canonical serialisation of its Resources graph (fonts, images, nested forms ...),
 *      with references resolved, dictionary keys sorted and every value length-prefixed.
 *
 * This hashes the exact drawing instructions and every embedded resource that the page uses,
 * so it is identical on every device (no rasteriser differences) and any change that can
 * alter what the page shows changes the hash. See docs/PROTOCOL.md for why this was chosen
 * over a pixel hash.
 */
import {
  PDFArray,
  PDFBool,
  PDFContext,
  PDFDict,
  PDFHexString,
  PDFName,
  PDFNull,
  PDFNumber,
  PDFObject,
  PDFRawStream,
  PDFRef,
  PDFStream,
  PDFString,
  decodePDFRawStream,
} from "pdf-lib";
import { PAGE_REPRESENTATION } from "./constants";
import { concatBytes, utf8 } from "./encoding";
import { UnsupportedPdfError } from "./errors";

const MAX_DEPTH = 64;

class Writer {
  chunks: Uint8Array[] = [];
  tag(t: string) {
    this.chunks.push(utf8(t));
  }
  /** length-prefixed raw bytes */
  blob(t: string, b: Uint8Array) {
    this.chunks.push(utf8(`${t}${b.length}:`));
    this.chunks.push(b);
  }
  text(t: string, s: string) {
    this.blob(t, utf8(s));
  }
  bytes() {
    return concatBytes(this.chunks);
  }
}

function writeObject(ctx: PDFContext, obj: PDFObject | undefined, w: Writer, path: Set<string>, depth: number) {
  if (depth > MAX_DEPTH) throw new UnsupportedPdfError("Page resources are nested too deeply.");
  if (obj === undefined || obj === PDFNull) return w.tag("n;");
  if (obj instanceof PDFRef) {
    const key = obj.toString();
    if (path.has(key)) return w.tag("c;"); // reference cycle: stable marker
    path.add(key);
    writeObject(ctx, ctx.lookup(obj), w, path, depth + 1);
    path.delete(key);
    return;
  }
  if (obj instanceof PDFBool) return w.tag(obj.asBoolean() ? "t;" : "f;");
  if (obj instanceof PDFNumber) return w.text("#", String(obj.asNumber()));
  if (obj instanceof PDFName) return w.text("/", obj.decodeText());
  if (obj instanceof PDFString || obj instanceof PDFHexString) return w.blob("s", obj.asBytes());
  if (obj instanceof PDFArray) {
    w.tag(`[${obj.size()}:`);
    for (const item of obj.asArray()) writeObject(ctx, item, w, path, depth + 1);
    return w.tag("]");
  }
  if (obj instanceof PDFRawStream) {
    writeDict(ctx, obj.dict, w, path, depth, ["Length"]);
    return w.blob("~", obj.contents);
  }
  if (obj instanceof PDFStream) {
    throw new UnsupportedPdfError("Unexpected stream type in page resources.");
  }
  if (obj instanceof PDFDict) return writeDict(ctx, obj, w, path, depth, []);
  throw new UnsupportedPdfError("Page contains an invalid or unsupported PDF object.");
}

function writeDict(ctx: PDFContext, dict: PDFDict, w: Writer, path: Set<string>, depth: number, skip: string[]) {
  const entries = dict
    .entries()
    .map(([k, v]) => [k.decodeText(), v] as const)
    .filter(([k]) => !skip.includes(k))
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  w.tag(`<${entries.length}:`);
  for (const [k, v] of entries) {
    w.text("/", k);
    writeObject(ctx, v, w, path, depth + 1);
  }
  w.tag(">");
}

/** Decode one content stream fully. Rejects predictors and filters we cannot decode deterministically. */
export function decodeContentStream(ctx: PDFContext, ref: PDFObject): Uint8Array {
  const stream = ref instanceof PDFRef ? ctx.lookup(ref) : ref;
  if (!(stream instanceof PDFRawStream)) throw new UnsupportedPdfError("Page content is not a valid stream.");
  const parms = stream.dict.get(PDFName.of("DecodeParms"));
  if (parms !== undefined && parms !== PDFNull) {
    throw new UnsupportedPdfError("Page content uses an encoding option (predictor) that PageLock v1 does not support.");
  }
  try {
    return decodePDFRawStream(stream).decode();
  } catch {
    throw new UnsupportedPdfError("Page content uses a compression format PageLock v1 cannot read.");
  }
}

/** Joined, decoded content of a page's /Contents (stream or array of streams). */
export function decodePageContents(ctx: PDFContext, contents: PDFObject | undefined): Uint8Array {
  if (contents === undefined || contents === PDFNull) return new Uint8Array(0);
  const resolved = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
  if (resolved instanceof PDFArray) {
    const parts = resolved.asArray().map((r) => decodeContentStream(ctx, r));
    const out: Uint8Array[] = [];
    parts.forEach((p, i) => {
      if (i > 0) out.push(new Uint8Array([0x0a]));
      out.push(p);
    });
    return concatBytes(out);
  }
  return decodeContentStream(ctx, resolved as PDFObject);
}

export interface PageRepresentationInput {
  box: number[]; // [llx, lly, urx, ury]
  content: Uint8Array;
  resources: PDFObject | undefined;
}

/** Build the PL1-PAGE byte representation that gets hashed. */
export function pageRepresentation(ctx: PDFContext, input: PageRepresentationInput): Uint8Array {
  const w = new Writer();
  w.text("V", PAGE_REPRESENTATION);
  w.tag(`B[4:`);
  for (const n of input.box) w.text("#", String(n));
  w.tag("]");
  w.blob("C", input.content);
  w.tag("R");
  writeObject(ctx, input.resources, w, new Set(), 0);
  return w.bytes();
}

export function readBox(ctx: PDFContext, obj: PDFObject | undefined): number[] | undefined {
  const arr = obj instanceof PDFRef ? ctx.lookup(obj) : obj;
  if (!(arr instanceof PDFArray) || arr.size() !== 4) return undefined;
  const nums = arr.asArray().map((v) => {
    const r = v instanceof PDFRef ? ctx.lookup(v) : v;
    return r instanceof PDFNumber ? r.asNumber() : NaN;
  });
  if (nums.some((n) => !Number.isFinite(n))) return undefined;
  // normalise so llx<urx, lly<ury
  const [a, b, c, d] = nums;
  return [Math.min(a, c), Math.min(b, d), Math.max(a, c), Math.max(b, d)];
}
