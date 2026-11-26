import { PDFDict, PDFDocument, PDFName, PDFNumber, PDFObject, PDFRawStream, PDFRef } from "pdf-lib";
import {
  END,
  FONT_BOLD,
  FONT_REGULAR,
  FOOTER_HEIGHT,
  FOOTER_XOBJECT,
  MANIFEST_KEY,
  MANIFEST_TYPE,
  PROTOCOL,
  MAX_FILE_BYTES,
  MAX_PAGES,
  ORIGINAL_XOBJECT,
  QR_XOBJECT,
  START,
} from "./constants";
import { decodeContentStream, pageRepresentation, readBox } from "./canonical";
import { sha256Hex } from "./crypto";
import { canonicalJson, utf8 } from "./encoding";
import { UnsupportedPdfError } from "./errors";
import { footerContent, wrapperContent } from "./footer";
import { ManifestBody, ParsedReference, manifestDigest } from "./manifest";
import { inheritedNumber, isSealedPage, listPages } from "./pages";
import { QrPayload, decodeQrBitmap, parsePayload } from "./qr";
import { assertBasicFile, findActiveContent, loadPdf } from "./safety";
import { revisionEnds } from "./sign/incremental";
import { SignatureInfo, analyzeSignatures } from "./sign/validate";
import { TrustProfile } from "./sign/trust";

/** Brief §9 result levels. */
export type Outcome = "VERIFIED" | "REFERENCE MATCH" | "INTERNALLY CONSISTENT" | "ALTERED / INVALID" | "UNABLE TO VERIFY";
export type CheckStatus = "pass" | "fail" | "inconclusive" | "not-provided" | "not-available";

export interface Check {
  id: string;
  label: string;
  status: CheckStatus;
  details: string[];
}

export interface PageResult {
  position: number; // physical position in the file, 1-based
  sealed: boolean;
  payload: QrPayload | null;
  computedHash: string | null;
  problems: string[];
}

export interface VerifyReport {
  outcome: Outcome;
  summary: string;
  checks: Check[];
  pages: PageResult[];
  documentId: string | null;
  fileSha256: string;
  /** SHA-256 of the sealed original (revision 1), before any signatures. */
  sealedSha256: string;
  manifestDigest: string | null;
  pageCount: number;
  signatures: SignatureInfo[];
  requiredSigners: number;
  trustName: string | null;
  trustIsDemo: boolean;
}

const SUMMARY: Record<Outcome, string> = {
  VERIFIED:
    "Every page is intact and every required signer has a valid, trusted, timestamped signature on this exact file. Nothing was changed after signing.",
  "REFERENCE MATCH":
    "Every page matches the trusted reference you supplied. This shows the content is unchanged. It does NOT establish who signed or agreed to it.",
  "INTERNALLY CONSISTENT":
    "The page seals and links are consistent, but no trusted reference or signature was checked. Someone could have rebuilt the whole chain, so compare against your own saved reference before relying on this.",
  "ALTERED / INVALID": "At least one content, sequence or reference check failed. Do not rely on this copy.",
  "UNABLE TO VERIFY": "PageLock could not reach a conclusion. This is not a pass.",
};

const bytesEq = (a: Uint8Array, b: Uint8Array) => a.length === b.length && a.every((v, i) => v === b[i]);

function onlyKeys(dict: PDFDict, allowed: string[]): string | null {
  for (const k of dict.keys()) if (!allowed.includes(k.decodeText())) return k.decodeText();
  return null;
}

function nameIs(dict: PDFDict, key: string, value: string) {
  const v = dict.get(PDFName.of(key));
  return v instanceof PDFName && v.decodeText() === value;
}

function num(ctx: PDFDocument["context"], o: PDFObject | undefined): number | undefined {
  const r = o instanceof PDFRef ? ctx.lookup(o) : o;
  return r instanceof PDFNumber ? r.asNumber() : undefined;
}

function checkFont(ctx: PDFDocument["context"], o: PDFObject | undefined, base: string): boolean {
  const d = ctx.lookupMaybe(o, PDFDict);
  return (
    !!d &&
    onlyKeys(d, ["Type", "Subtype", "BaseFont", "Encoding"]) === null &&
    nameIs(d, "Type", "Font") &&
    nameIs(d, "Subtype", "Type1") &&
    nameIs(d, "BaseFont", base) &&
    nameIs(d, "Encoding", "WinAnsiEncoding")
  );
}

interface SealRead {
  payload: QrPayload | null;
  computedHash: string | null;
  structural: string[]; // failures that mean tampering
  inconclusive: string[]; // could not read
  footerMismatch: boolean;
}

/** Read one sealed page strictly: the page must be exactly [original form] + [footer form], nothing else. */
async function readSealedPage(doc: PDFDocument, leafDict: PDFDict, position: number): Promise<SealRead> {
  const ctx = doc.context;
  const r: SealRead = { payload: null, computedHash: null, structural: [], inconclusive: [], footerMismatch: false };
  const bad = (m: string) => r.structural.push(`Page ${position}: ${m}`);

  const extra = onlyKeys(leafDict, ["Type", "Parent", "StructParents", "MediaBox", "CropBox", "Rotate", "Contents", "Resources"]);
  if (extra) bad(`has extra page data added after sealing (/${extra}, e.g. comments or form fields).`);

  const res = ctx.lookupMaybe(leafDict.get(PDFName.of("Resources")), PDFDict)!;
  if (onlyKeys(res, ["XObject"])) bad("has extra resources added after sealing.");
  const xo = res.lookupMaybe(PDFName.of("XObject"), PDFDict)!;
  if (onlyKeys(xo, [ORIGINAL_XOBJECT, FOOTER_XOBJECT])) bad("has extra drawing objects added after sealing.");

  const orig = ctx.lookup(xo.get(PDFName.of(ORIGINAL_XOBJECT)));
  const foot = ctx.lookup(xo.get(PDFName.of(FOOTER_XOBJECT)));
  if (!(orig instanceof PDFRawStream) || !(foot instanceof PDFRawStream)) {
    bad("seal structure is damaged.");
    return r;
  }

  // Original page form: only these keys, so no transform/clip can change how it shows without changing the hash.
  const origExtra = onlyKeys(orig.dict, ["Type", "Subtype", "BBox", "Resources", "Length", "Filter"]);
  if (origExtra) bad(`original page object was modified (/${origExtra}).`);
  const box = readBox(ctx, orig.dict.get(PDFName.of("BBox")));
  if (!box) {
    bad("original page size is missing.");
    return r;
  }
  const W = box[2] - box[0];
  const H = box[3] - box[1];

  // Page geometry must be exactly the original plus the footer band.
  const media = readBox(ctx, leafDict.get(PDFName.of("MediaBox")));
  const crop = readBox(ctx, leafDict.get(PDFName.of("CropBox")) ?? leafDict.get(PDFName.of("MediaBox")));
  const expect = [0, 0, W, H + FOOTER_HEIGHT];
  const same = (b?: number[]) => !!b && b.every((v, i) => Math.abs(v - expect[i]) < 1e-6);
  if (!same(media) || !same(crop)) bad("page size or visible area was changed.");
  if ((inheritedNumber(doc.getPages()[position - 1].node, "Rotate") ?? 0) % 360 !== 0) bad("page rotation was changed.");

  // The page's own drawing instructions must be exactly the PageLock wrapper.
  try {
    const contents = leafDict.get(PDFName.of("Contents"));
    const resolved = contents instanceof PDFRef ? ctx.lookup(contents) : contents;
    if (!(resolved instanceof PDFRawStream)) bad("page drawing instructions were changed.");
    else if (!bytesEq(decodeContentStream(ctx, resolved), utf8(wrapperContent(box))))
      bad("page drawing instructions were changed (something may be drawn over the original).");
  } catch {
    bad("page drawing instructions could not be read.");
  }

  // Fingerprint of the original content.
  try {
    const content = decodeContentStream(ctx, orig);
    const rep = pageRepresentation(ctx, { box, content, resources: orig.dict.get(PDFName.of("Resources")) });
    r.computedHash = await sha256Hex(rep);
  } catch (e) {
    r.inconclusive.push(`Page ${position}: content could not be read (${e instanceof Error ? e.message : "unknown"}).`);
  }

  // Footer form.
  if (onlyKeys(foot.dict, ["Type", "Subtype", "BBox", "Resources", "Length", "Filter"])) bad("footer object was modified.");
  const fbox = readBox(ctx, foot.dict.get(PDFName.of("BBox")));
  if (!fbox || fbox[0] !== 0 || fbox[1] !== 0 || Math.abs(fbox[2] - W) > 1e-6 || fbox[3] !== FOOTER_HEIGHT)
    bad("footer area was changed (it could overlap the page).");
  const fres = ctx.lookupMaybe(foot.dict.get(PDFName.of("Resources")), PDFDict);
  const fonts = fres?.lookupMaybe(PDFName.of("Font"), PDFDict);
  const fxo = fres?.lookupMaybe(PDFName.of("XObject"), PDFDict);
  if (
    !fres ||
    onlyKeys(fres, ["Font", "XObject"]) ||
    !fonts ||
    onlyKeys(fonts, [FONT_REGULAR, FONT_BOLD]) ||
    !checkFont(ctx, fonts.get(PDFName.of(FONT_REGULAR)), "Helvetica") ||
    !checkFont(ctx, fonts.get(PDFName.of(FONT_BOLD)), "Helvetica-Bold") ||
    !fxo ||
    onlyKeys(fxo, [QR_XOBJECT])
  )
    bad("footer resources were changed.");

  // QR image -> payload.
  const img = fxo ? ctx.lookup(fxo.get(PDFName.of(QR_XOBJECT))) : undefined;
  if (!(img instanceof PDFRawStream)) {
    r.inconclusive.push(`Page ${position}: QR code is missing.`);
    return r;
  }
  const iw = num(ctx, img.dict.get(PDFName.of("Width")));
  const ih = num(ctx, img.dict.get(PDFName.of("Height")));
  if (
    onlyKeys(img.dict, ["Type", "Subtype", "Width", "Height", "ColorSpace", "BitsPerComponent", "Length", "Filter"]) ||
    !nameIs(img.dict, "ColorSpace", "DeviceGray") ||
    num(ctx, img.dict.get(PDFName.of("BitsPerComponent"))) !== 1 ||
    !nameIs(img.dict, "Filter", "FlateDecode") ||
    !iw ||
    !ih ||
    iw > 400 ||
    ih > 400
  ) {
    bad("QR code image was changed.");
    return r;
  }
  let text: string | null = null;
  try {
    text = decodeQrBitmap(decodeContentStream(ctx, img), iw, ih);
  } catch {
    text = null;
  }
  if (text === null) {
    r.inconclusive.push(`Page ${position}: QR code could not be read.`);
    return r;
  }
  r.payload = parsePayload(text);
  if (!r.payload) {
    bad("QR code is not a valid PageLock v1 code.");
    return r;
  }

  // Footer text must be exactly what the QR says (short fingerprint, page x of n, document ID).
  try {
    const expected = footerContent({
      pageWidth: W,
      documentId: r.payload.documentId,
      index: r.payload.index,
      count: r.payload.count,
      hash: r.payload.hash,
    });
    if (!bytesEq(decodeContentStream(ctx, foot), utf8(expected))) {
      r.footerMismatch = true;
      bad("footer text or layout was edited.");
    }
  } catch {
    bad("footer could not be read.");
  }
  return r;
}

async function readEmbeddedManifest(doc: PDFDocument): Promise<{ body?: ManifestBody; digest?: string; problem?: string }> {
  const stream = doc.context.lookup(doc.catalog.get(PDFName.of(MANIFEST_KEY)));
  if (!(stream instanceof PDFRawStream)) return { problem: "The embedded PageLock manifest is missing (it was removed or the file was rebuilt)." };
  try {
    const text = new TextDecoder("utf-8", { fatal: true }).decode(decodeContentStream(doc.context, stream));
    const body = JSON.parse(text) as ManifestBody;
    if (body?.type !== MANIFEST_TYPE || body.protocol !== PROTOCOL || !Array.isArray(body.pages)) throw new Error();
    if (canonicalJson(body) !== text) return { problem: "The embedded manifest is not in canonical form (it was edited)." };
    return { body, digest: await manifestDigest(body) };
  } catch {
    return { problem: "The embedded PageLock manifest is damaged." };
  }
}

export interface VerifyOptions {
  reference?: ParsedReference | null;
  /** Which authorities to trust for signatures and timestamps. Without it, signer identity cannot be established. */
  trust?: TrustProfile | null;
}

/** VERIFY (brief §2, §9). Never reports an inconclusive check as a pass. */
export async function verifyPdf(input: Uint8Array, opts: VerifyOptions = {}): Promise<VerifyReport> {
  const checks: Check[] = [];
  const add = (id: string, label: string, status: CheckStatus, details: string[] = []) =>
    checks.push({ id, label, status, details });
  const fileSha256 = await sha256Hex(input);
  const trust = opts.trust ?? null;
  const ends = revisionEnds(input);
  // Revision 1 is the sealed original. Later revisions may only add signatures (checked below).
  const sealed = ends.length > 1 ? input.subarray(0, ends[0]) : input;
  const sealedSha256 = ends.length > 1 ? await sha256Hex(sealed) : fileSha256;
  const base = {
    fileSha256,
    sealedSha256,
    trustName: trust?.name ?? null,
    trustIsDemo: !!trust?.demo,
    requiredSigners: trust?.requiredSigners ?? 2,
  };
  const unable = (why: string): VerifyReport => {
    add("read", "File can be read safely", "inconclusive", [why]);
    return {
      outcome: "UNABLE TO VERIFY",
      summary: SUMMARY["UNABLE TO VERIFY"],
      checks,
      pages: [],
      documentId: null,
      manifestDigest: null,
      pageCount: 0,
      signatures: [],
      ...base,
    };
  };

  let doc: PDFDocument;
  try {
    assertBasicFile(input, MAX_FILE_BYTES);
    await loadPdf(input); // the whole file must parse too
    doc = await loadPdf(sealed);
  } catch (e) {
    return unable(e instanceof UnsupportedPdfError ? e.message : "The file could not be read.");
  }
  const leaves = listPages(doc);
  if (leaves.length === 0 || leaves.length > MAX_PAGES) return unable("Page count is outside the supported range.");
  const sealedFlags = leaves.map((p) => isSealedPage(p.leaf));
  if (!sealedFlags.some(Boolean)) return unable("No PageLock seals were found in this PDF. It may never have been prepared with PageLock.");
  add("read", "File can be read safely", "pass");

  const revisionsAt = checks.length;

  const active = findActiveContent(doc);
  add("active", "No scripts, forms or attachments added", active ? "fail" : "pass", active ? [`This PDF ${active}.`] : []);

  // Per-page reads.
  const pages: PageResult[] = [];
  const structural: string[] = [];
  const inconclusive: string[] = [];
  for (let i = 0; i < leaves.length; i++) {
    const pos = i + 1;
    if (!sealedFlags[i]) {
      pages.push({ position: pos, sealed: false, payload: null, computedHash: null, problems: ["No PageLock seal (inserted or replaced page)."] });
      continue;
    }
    const s = await readSealedPage(doc, leaves[i].leaf, pos);
    structural.push(...s.structural);
    inconclusive.push(...s.inconclusive);
    pages.push({
      position: pos,
      sealed: true,
      payload: s.payload,
      computedHash: s.computedHash,
      problems: [...s.structural, ...s.inconclusive].map((m) => m.replace(/^Page \d+: /, "")),
    });
  }
  const unsealed = pages.filter((p) => !p.sealed).map((p) => `Page ${p.position} has no PageLock seal (it was inserted or replaced).`);
  add("sealed", "Every page carries a PageLock seal", unsealed.length ? "fail" : "pass", unsealed);
  add(
    "structure",
    "Nothing added on top of the sealed pages",
    structural.length ? "fail" : inconclusive.length ? "inconclusive" : "pass",
    [...structural, ...inconclusive],
  );

  // Content vs. each page's own QR.
  const contentFails: string[] = [];
  const contentUnknown: string[] = [];
  for (const p of pages) {
    if (!p.sealed) continue;
    if (!p.payload || !p.computedHash) contentUnknown.push(`Page ${p.position}: fingerprint could not be compared.`);
    else if (p.payload.hash !== p.computedHash) {
      contentFails.push(`Page ${p.position}: content does not match its own seal (the page was edited, or a QR code was copied from another page).`);
      p.problems.push("Content does not match its seal.");
    }
  }
  add(
    "content",
    "Each page's content matches its fingerprint",
    contentFails.length ? "fail" : contentUnknown.length ? "inconclusive" : "pass",
    [...contentFails, ...contentUnknown],
  );

  // Same document.
  const payloads = pages.map((p) => p.payload).filter((p): p is QrPayload => !!p);
  const docIds = [...new Set(payloads.map((p) => p.documentId))];
  const majorityId =
    docIds.sort((a, b) => payloads.filter((p) => p.documentId === b).length - payloads.filter((p) => p.documentId === a).length)[0] ?? null;
  const foreign = pages
    .filter((p) => p.payload && p.payload.documentId !== majorityId)
    .map((p) => `Page ${p.position} belongs to a different PageLock document.`);
  add("document", "All pages belong to the same document", foreign.length ? "fail" : payloads.length ? "pass" : "inconclusive", foreign);

  // Count and order.
  const N = pages.length;
  const orderFails: string[] = [];
  const counts = [...new Set(payloads.map((p) => p.count))];
  if (counts.length > 1) orderFails.push("Pages disagree about how many pages the document has.");
  else if (counts.length === 1 && counts[0] !== N)
    orderFails.push(
      counts[0] > N
        ? `The document should have ${counts[0]} pages but this file has ${N}: ${counts[0] - N} page(s) missing.`
        : `The document should have ${counts[0]} pages but this file has ${N}: extra page(s) inserted.`,
    );
  for (const p of pages) {
    if (p.payload && p.payload.index !== p.position) {
      orderFails.push(`Page ${p.position} is sealed as page ${p.payload.index}: pages are missing or out of order.`);
      p.problems.push(`Sealed as page ${p.payload.index}.`);
    }
  }
  add("order", "Page count and order are complete", orderFails.length ? "fail" : payloads.length === N ? "pass" : "inconclusive", orderFails);

  // Neighbour links START <-> 1 <-> 2 ... <-> END, using the hashes actually computed from neighbouring pages.
  const linkFails: string[] = [];
  let linkUnknown = false;
  for (let i = 0; i < N; i++) {
    const p = pages[i].payload;
    if (!p) {
      linkUnknown = true;
      continue;
    }
    const expectPrev = i === 0 ? START : pages[i - 1].computedHash;
    const expectNext = i === N - 1 ? END : pages[i + 1].computedHash;
    if (expectPrev === null || expectNext === null) linkUnknown = true;
    if (expectPrev !== null && p.prev !== expectPrev)
      linkFails.push(i === 0 ? `Page 1 is not the first page of the sealed document.` : `Page ${i + 1} does not follow page ${i} in the sealed sequence.`);
    if (expectNext !== null && p.next !== expectNext)
      linkFails.push(i === N - 1 ? `Page ${N} is not the last page of the sealed document.` : `Page ${i + 1} is not followed by its sealed next page.`);
  }
  add("links", "Neighbour links are unbroken (START to END)", linkFails.length ? "fail" : linkUnknown ? "inconclusive" : "pass", [
    ...new Set(linkFails),
  ]);

  // Embedded manifest: must exist, be well-formed, and list exactly these pages in this order.
  const embedded = await readEmbeddedManifest(doc);
  const mFails: string[] = [];
  if (!embedded.body) mFails.push(embedded.problem!);
  else {
    const b = embedded.body;
    if (majorityId && b.documentId !== majorityId) mFails.push("The embedded manifest names a different document.");
    if (b.pageCount !== N || b.pages.length !== N)
      mFails.push(`The embedded manifest lists ${b.pageCount} pages; this file has ${N}.`);
    pages.forEach((p, i) => {
      const e = b.pages[i];
      if (!e || e.index !== i + 1) return;
      if (p.computedHash && e.hash !== p.computedHash) mFails.push(`Page ${p.position} does not match page ${i + 1} in the embedded manifest.`);
      if (p.payload && (e.hash !== p.payload.hash || e.prev !== p.payload.prev || e.next !== p.payload.next))
        mFails.push(`Page ${p.position}'s seal disagrees with the embedded manifest.`);
    });
  }
  add(
    "manifest-binding",
    "The embedded manifest binds this exact page sequence",
    mFails.length ? "fail" : pages.every((p) => p.computedHash) ? "pass" : "inconclusive",
    [...new Set(mFails)],
  );

  // Trusted reference.
  const ref = opts.reference ?? null;
  let referencePass = false;
  if (!ref) {
    add("reference", "Matches your trusted reference", "not-provided", [
      "No trusted reference supplied. Load the manifest file (or digest) you saved when the document was prepared.",
    ]);
  } else {
    const fails: string[] = [];
    if (embedded.digest !== ref.digest)
      fails.push("This document's seals do not match your trusted manifest. It may be a different document, or the chain was regenerated after changes.");
    if (ref.kind === "manifest") {
      const b = ref.file.body;
      if (majorityId && b.documentId !== majorityId) fails.push("The document ID differs from your trusted manifest.");
      if (b.pageCount !== N) fails.push(`Your trusted manifest lists ${b.pageCount} pages; this file has ${N}.`);
      pages.forEach((p, i) => {
        const exp = b.pages[i]?.hash;
        if (exp && p.computedHash && p.computedHash !== exp) fails.push(`Page ${p.position} differs from page ${i + 1} in your trusted manifest.`);
      });
    }
    referencePass = fails.length === 0;
    add("reference", "Matches your trusted reference", referencePass ? "pass" : "fail", [...new Set(fails)]);
    if (ref.kind === "manifest" && ref.file.preparedPdfSha256) {
      const same = ref.file.preparedPdfSha256 === sealedSha256;
      add(
        "exact-file",
        ends.length > 1 ? "Sealed file (before signatures) is identical to the one prepared" : "Exact file is identical to the one prepared",
        same ? "pass" : "fail",
        same ? [] : ["The file's bytes differ from the prepared file, so something outside the visible pages (for example metadata or hidden data) was changed or the file was re-saved."],
      );
    }
  }
  // Signatures (Phase 2).
  const manifestDigestValue = embedded.body && mFails.length === 0 ? embedded.digest! : null;
  const sig = await analyzeSignatures(input, ends, { documentId: majorityId, manifestDigest: manifestDigestValue, pageCount: N }, trust);
  const changes = sig.checks.find((c) => c.id === "sig-changes");
  checks.splice(revisionsAt, 0, {
    id: "revisions",
    label: "No edits saved after sealing (other than signatures)",
    status: ends.length <= 1 ? "pass" : changes?.status === "pass" ? "pass" : "fail",
    details:
      ends.length <= 1
        ? []
        : changes?.status === "pass"
          ? [`${ends.length - 1} signature revision(s) added after sealing, and nothing else.`]
          : [`The file contains ${ends.length} saved versions and at least one is not just a signature. Someone edited and re-saved it after it was sealed.`, ...(changes?.details ?? [])],
  });
  for (const c of sig.checks) if (c.id !== "sig-changes") checks.push(c);

  const signatureIds = new Set(sig.checks.map((c) => c.id));
  const required = checks.filter((c) => !signatureIds.has(c.id) && c.id !== "reference");
  let outcome: Outcome;
  if (checks.some((c) => c.status === "fail")) outcome = "ALTERED / INVALID";
  else if (required.some((c) => c.status === "inconclusive")) outcome = "UNABLE TO VERIFY";
  else if (sig.allPass && trust) outcome = "VERIFIED";
  else if (referencePass) outcome = "REFERENCE MATCH";
  else outcome = "INTERNALLY CONSISTENT";

  let summary = SUMMARY[outcome];
  if (outcome !== "VERIFIED" && sig.signatures.length)
    summary += ` Signatures found: ${sig.signatures.length}, of which ${sig.trustedSigners} fully valid and trusted (${sig.requiredSigners} required).`;
  if (outcome === "VERIFIED" && trust?.demo)
    summary += " Note: the signers' certificates come from the PageLock DEMO authority, whose keys are public. This demonstrates the checks; it proves nothing about who signed.";

  return {
    outcome,
    summary,
    checks,
    pages,
    documentId: majorityId,
    manifestDigest: manifestDigestValue,
    pageCount: N,
    signatures: sig.signatures,
    ...base,
  };
}
