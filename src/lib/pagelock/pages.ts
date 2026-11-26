import { PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFPageLeaf, PDFRef } from "pdf-lib";
import { MAX_PAGE_SIDE, MIN_PAGE_WIDTH, ORIGINAL_XOBJECT, FOOTER_XOBJECT } from "./constants";
import { decodePageContents, pageRepresentation, readBox } from "./canonical";
import { sha256Hex } from "./crypto";
import { UnsupportedPdfError } from "./errors";

export interface PageLeafRef {
  leaf: PDFPageLeaf;
  ref: PDFRef;
}

export function listPages(doc: PDFDocument): PageLeafRef[] {
  return doc.getPages().map((p) => ({ leaf: p.node, ref: p.ref }));
}

export function inheritedNumber(leaf: PDFPageLeaf, key: string): number | undefined {
  const v = leaf.getInheritableAttribute(PDFName.of(key));
  const r = v instanceof PDFRef ? leaf.context.lookup(v) : v;
  return r instanceof PDFNumber ? r.asNumber() : undefined;
}

/** True if a page looks like a PageLock-prepared page (has our XObjects). */
export function isSealedPage(leaf: PDFPageLeaf): boolean {
  const res = leaf.context.lookupMaybe(leaf.get(PDFName.of("Resources")), PDFDict);
  const xo = res && res.lookupMaybe(PDFName.of("XObject"), PDFDict);
  return !!xo && !!xo.get(PDFName.of(ORIGINAL_XOBJECT)) && !!xo.get(PDFName.of(FOOTER_XOBJECT));
}

export interface OriginalPage {
  box: number[];
  content: Uint8Array;
  resources: ReturnType<PDFPageLeaf["getInheritableAttribute"]>;
  hash: string;
}

/** Inspect an ORIGINAL (unsealed) page, reject anything ambiguous, and compute its PL1-PAGE hash. */
export async function readOriginalPage(leaf: PDFPageLeaf, pageNo: number): Promise<OriginalPage> {
  const ctx = leaf.context;
  const fail = (m: string) => {
    throw new UnsupportedPdfError(`Page ${pageNo}: ${m}`, pageNo);
  };
  const annots = ctx.lookupMaybe(leaf.get(PDFName.of("Annots")), PDFArray);
  if (annots && annots.size() > 0)
    fail("has comments, links or form fields on top of the page. Flatten it (for example, Print to PDF) and try again.");
  if (leaf.get(PDFName.of("AA"))) fail("has automatic actions.");
  const rotate = inheritedNumber(leaf, "Rotate") ?? 0;
  if (rotate % 360 !== 0) fail("is rotated. PageLock v1 only supports unrotated pages; re-export the PDF without rotation.");
  const userUnit = inheritedNumber(leaf, "UserUnit");
  if (userUnit !== undefined && userUnit !== 1) fail("uses a non-standard unit size.");
  const box = readBox(ctx, leaf.getInheritableAttribute(PDFName.of("MediaBox")));
  if (!box) fail("has no valid page size.");
  const crop = readBox(ctx, leaf.getInheritableAttribute(PDFName.of("CropBox")));
  if (crop && crop.some((n, i) => Math.abs(n - box![i]) > 1e-6))
    fail("is cropped (visible area differs from the page). Re-export the PDF without cropping.");
  const w = box![2] - box![0];
  const h = box![3] - box![1];
  if (w < MIN_PAGE_WIDTH) fail("is too narrow for the PageLock footer (minimum 4 inches wide).");
  if (w > MAX_PAGE_SIDE || h > MAX_PAGE_SIDE || h < 72) fail("has an unsupported page size.");
  const content = decodePageContents(ctx, leaf.get(PDFName.of("Contents")));
  const resources = leaf.getInheritableAttribute(PDFName.of("Resources"));
  const rep = pageRepresentation(ctx, { box: box!, content, resources });
  return { box: box!, content, resources, hash: await sha256Hex(rep) };
}
