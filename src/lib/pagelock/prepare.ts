import { PDFArray, PDFDict, PDFDocument, PDFName, PDFObject, PDFRawStream, PDFRef, PDFStream } from "pdf-lib";
import {
  END,
  FONT_BOLD,
  FONT_REGULAR,
  FOOTER_HEIGHT,
  qrQuietZoneFor,
  FOOTER_XOBJECT,
  MANIFEST_TYPE,
  MAX_FILE_BYTES,
  MANIFEST_KEY,
  MAX_PAGES,
  ORIGINAL_XOBJECT,
  PAGE_REPRESENTATION,
  PROTOCOL,
  QR_XOBJECT,
  START,
} from "./constants";
import { newDocumentId, sha256Hex } from "./crypto";
import { canonicalJson, utf8 } from "./encoding";
import { UnsupportedPdfError } from "./errors";
import { footerContent, wrapperContent } from "./footer";
import { ManifestBody, ManifestFile, manifestDigest } from "./manifest";
import { OriginalPage, isSealedPage, listPages, readOriginalPage } from "./pages";
import { FINGERPRINT_PREFIX_LENGTH, encodePayload, qrBitmap } from "./qr";
import { assertBasicFile, findActiveContent, loadPdf } from "./safety";

export interface PreparedPage {
  index: number;
  hash: string;
  payload: string;
}

export interface PrepareResult {
  pdfBytes: Uint8Array;
  manifest: ManifestFile;
  documentId: string;
  pages: PreparedPage[];
}

export interface PrepareOptions {
  /** For tests only: fix the ID / timestamp to make output reproducible. */
  documentId?: string;
  createdAt?: string;
}

const KEEP_PAGE_KEYS = new Set(["Type", "Parent", "StructParents"]);

export function standardFont(doc: PDFDocument, baseFont: string) {
  return doc.context.obj({ Type: "Font", Subtype: "Type1", BaseFont: baseFont, Encoding: "WinAnsiEncoding" });
}

/** Remove an AcroForm that has no fields (common in exported PDFs and harmless). */
function stripEmptyAcroForm(doc: PDFDocument) {
  const af = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!af) return;
  const fields = af.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if ((!fields || fields.size() === 0) && !af.get(PDFName.of("XFA"))) doc.catalog.delete(PDFName.of("AcroForm"));
}

/** Delete every object not reachable from the trailer, so no stale or hidden leftovers ship. */
export function sweepUnreachable(doc: PDFDocument) {
  const ctx = doc.context;
  const seen = new Set<string>();
  const walk = (o: PDFObject | undefined) => {
    if (!o) return;
    if (o instanceof PDFRef) {
      const k = o.toString();
      if (seen.has(k)) return;
      seen.add(k);
      walk(ctx.lookup(o));
    } else if (o instanceof PDFDict) {
      for (const [, v] of o.entries()) walk(v);
    } else if (o instanceof PDFStream) {
      walk((o as PDFRawStream).dict);
    } else if (o instanceof PDFArray) {
      for (const v of o.asArray()) walk(v);
    }
  };
  walk(ctx.trailerInfo.Root);
  walk(ctx.trailerInfo.Info);
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (!seen.has(ref.toString())) ctx.delete(ref);
  }
}

/**
 * CREATE (brief §2): import a PDF, give it a random document ID, fingerprint every page,
 * then add linked QR footers. All page hashes are computed BEFORE any QR is added.
 */
export async function preparePdf(input: Uint8Array, opts: PrepareOptions = {}): Promise<PrepareResult> {
  assertBasicFile(input, MAX_FILE_BYTES);
  const sourcePdfSha256 = await sha256Hex(input);
  const doc = await loadPdf(input);
  const ctx = doc.context;
  stripEmptyAcroForm(doc);
  const active = findActiveContent(doc);
  if (active) throw new UnsupportedPdfError(`This PDF ${active}. PageLock v1 only accepts plain, static documents.`);

  const pages = listPages(doc);
  if (pages.length === 0) throw new UnsupportedPdfError("This PDF has no pages.");
  if (pages.length > MAX_PAGES) throw new UnsupportedPdfError(`This PDF has more than ${MAX_PAGES} pages.`);
  if (pages.some((p) => isSealedPage(p.leaf)))
    throw new UnsupportedPdfError("This PDF already carries PageLock seals. Use Verify instead, or start from the unsealed original.");

  // 1. Fingerprint every page first.
  const originals: OriginalPage[] = [];
  for (let i = 0; i < pages.length; i++) originals.push(await readOriginalPage(pages[i].leaf, i + 1));
  const hashes = originals.map((o) => o.hash);
  const n = hashes.length;

  // 2. Build and digest the ordered manifest.
  const documentId = opts.documentId ?? newDocumentId();
  const body: ManifestBody = {
    type: MANIFEST_TYPE,
    protocol: PROTOCOL,
    pageRepresentation: PAGE_REPRESENTATION,
    hashAlgorithm: "SHA-256",
    documentId,
    createdAt: opts.createdAt ?? new Date().toISOString(),
    pageCount: n,
    sourcePdfSha256,
    pages: hashes.map((h, i) => ({
      index: i + 1,
      hash: h,
      prev: i === 0 ? START : hashes[i - 1],
      next: i === n - 1 ? END : hashes[i + 1],
    })),
  };
  const digest = await manifestDigest(body);

  // 3. Rebuild each page: original (untouched) as a form XObject + reserved footer band below it.
  const fontRegular = ctx.register(standardFont(doc, "Helvetica"));
  const fontBold = ctx.register(standardFont(doc, "Helvetica-Bold"));
  const prepared: PreparedPage[] = [];

  pages.forEach(({ leaf }, i) => {
    const o = originals[i];
    const [llx, lly, urx, ury] = o.box;
    const W = urx - llx;
    const H = ury - lly;
    const m = body.pages[i];
    const payload = encodePayload({
      version: PROTOCOL,
      documentId,
      index: m.index,
      count: n,
      hash: m.hash,
      prev: m.prev,
      next: m.next,
      // Last page: make the code a link to the PageLock site, with the start of the document fingerprint.
      fingerprintPrefix: m.index === n ? digest.slice(0, FINGERPRINT_PREFIX_LENGTH) : undefined,
    });
    prepared.push({ index: m.index, hash: m.hash, payload });

    const origDict: Record<string, unknown> = { Type: "XObject", Subtype: "Form", BBox: o.box };
    if (o.resources) origDict.Resources = o.resources;
    const origRef = ctx.register(ctx.flateStream(o.content, origDict as never));

    const qr = qrBitmap(payload, qrQuietZoneFor(FOOTER_HEIGHT));
    const qrRef = ctx.register(
      ctx.flateStream(qr.bits, {
        Type: "XObject",
        Subtype: "Image",
        Width: qr.size,
        Height: qr.size,
        ColorSpace: "DeviceGray",
        BitsPerComponent: 1,
      }),
    );
    const footRef = ctx.register(
      ctx.flateStream(utf8(footerContent({ pageWidth: W, documentId, index: m.index, count: n, hash: m.hash })), {
        Type: "XObject",
        Subtype: "Form",
        BBox: [0, 0, W, FOOTER_HEIGHT],
        Resources: {
          Font: { [FONT_REGULAR]: fontRegular, [FONT_BOLD]: fontBold },
          XObject: { [QR_XOBJECT]: qrRef },
        },
      }),
    );
    const wrapRef = ctx.register(ctx.flateStream(utf8(wrapperContent(o.box))));

    for (const key of leaf.keys()) if (!KEEP_PAGE_KEYS.has(key.decodeText())) leaf.delete(key);
    const newBox = ctx.obj([0, 0, W, H + FOOTER_HEIGHT]);
    leaf.set(PDFName.of("MediaBox"), newBox);
    leaf.set(PDFName.of("CropBox"), ctx.obj([0, 0, W, H + FOOTER_HEIGHT]));
    leaf.set(PDFName.of("Rotate"), ctx.obj(0));
    leaf.set(PDFName.of("Contents"), wrapRef);
    leaf.set(PDFName.of("Resources"), ctx.obj({ XObject: { [ORIGINAL_XOBJECT]: origRef, [FOOTER_XOBJECT]: footRef } }));
  });

  // Embed the manifest body so a verifier can recompute its digest and compare it with the trusted one.
  doc.catalog.set(PDFName.of(MANIFEST_KEY), ctx.register(ctx.flateStream(utf8(canonicalJson(body)))));

  sweepUnreachable(doc);
  const pdfBytes = await doc.save({ useObjectStreams: false, addDefaultPage: false, updateFieldAppearances: false });
  const preparedPdfSha256 = await sha256Hex(pdfBytes);

  const manifest: ManifestFile = {
    pagelockManifest: 1,
    body,
    manifestDigest: digest,
    preparedPdfSha256,
    keepSafe:
      "Keep this file (or at least the manifestDigest) somewhere the other party cannot change. It is your trusted reference for verifying the agreement later.",
  };
  return { pdfBytes, manifest, documentId, pages: prepared };
}
