/**
 * SIGN (brief §2, §6): each founder reviews the same sealed agreement, explicitly consents, and applies a
 * PAdES signature (ETSI.CAdES.detached, baseline B-T when a timestamp source is given) in a new incremental
 * revision. Earlier signatures and the original sealed bytes are never changed.
 */
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFRef, PDFString } from "pdf-lib";
import { concatBytes, utf8 } from "../encoding";
import { CmsSigner, TimestampSource, createCadesDetached } from "./cms";
import { appendRevision, serializeObject } from "./incremental";
import { ab, allPem, certFromDer, fromPem, importPrivateKeyPkcs8, nameInfo, subtle, u8 } from "./pki";

/** Bytes reserved for the CMS signature. Fits a 3-certificate chain plus a timestamp with room to spare. */
export const SIGNATURE_RESERVE = 16384;
export const SIG_FIELD_PREFIX = "PageLock signature ";

export interface ConsentInput {
  documentId: string;
  manifestDigest: string;
  pageCount: number;
}

/** The exact consent wording. It is stored in the signed part of the PDF (/Reason) and checked by the verifier. */
export function consentStatement(c: ConsentInput): string {
  return (
    `PageLock consent: I have reviewed all ${c.pageCount} pages of document ${c.documentId} ` +
    `and agree to the whole document. Document fingerprint (manifest digest): ${c.manifestDigest}.`
  );
}

export interface SignPdfOptions {
  signer: CmsSigner;
  consent: ConsentInput & { accepted: boolean };
  timestamp?: TimestampSource;
  signingTime?: Date;
}

function pdfDate(d: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `D:${d.getUTCFullYear()}${p(d.getUTCMonth() + 1)}${p(d.getUTCDate())}${p(d.getUTCHours())}${p(d.getUTCMinutes())}${p(d.getUTCSeconds())}Z`;
}

function pdfLiteral(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error("Consent text must be plain ASCII.");
  return "(" + s.replace(/[\\()]/g, (c) => "\\" + c) + ")";
}

function utf16Hex(s: string): string {
  let h = "FEFF";
  for (let i = 0; i < s.length; i++) h += s.charCodeAt(i).toString(16).padStart(4, "0").toUpperCase();
  return `<${h}>`;
}

const BR_PLACEHOLDER = "[0 0000000000 0000000000 0000000000]";

/**
 * Adds one signature to an already sealed (and possibly already signed) PageLock PDF.
 * The caller must have shown the person the document and their consent must be explicit.
 */
export async function addSignature(input: Uint8Array, o: SignPdfOptions): Promise<Uint8Array> {
  if (!o.consent.accepted) throw new Error("The signer has not given explicit consent.");
  const doc = await PDFDocument.load(input, { updateMetadata: false, throwOnInvalidObject: true });
  const ctx = doc.context;
  const rootRef = ctx.trailerInfo.Root;
  if (!(rootRef instanceof PDFRef)) throw new Error("This PDF has no document catalog reference.");

  let next = ctx.largestObjectNumber + 1;
  const sigRef = PDFRef.of(next++);
  const fieldRef = PDFRef.of(next++);
  const objects: { ref: PDFRef; body: Uint8Array }[] = [];

  // AcroForm: create it on the first signature, extend it afterwards.
  const catalog = doc.catalog;
  const existingAf = catalog.get(PDFName.of("AcroForm"));
  let fieldCount = 0;
  if (existingAf instanceof PDFRef) {
    const af = (ctx.lookup(existingAf, PDFDict) as PDFDict).clone(ctx);
    const fields = af.get(PDFName.of("Fields"));
    if (!(fields instanceof PDFArray)) throw new Error("Unsupported form structure (indirect /Fields).");
    const nf = fields.clone(ctx);
    fieldCount = nf.size();
    nf.push(fieldRef);
    af.set(PDFName.of("Fields"), nf);
    af.set(PDFName.of("SigFlags"), PDFNumber.of(3));
    objects.push({ ref: existingAf, body: serializeObject(af) });
  } else if (existingAf) {
    throw new Error("Unsupported form structure (direct /AcroForm).");
  } else {
    const afRef = PDFRef.of(next++);
    objects.push({ ref: afRef, body: serializeObject(ctx.obj({ Fields: [fieldRef], SigFlags: 3 })) });
    const cat = catalog.clone(ctx);
    cat.set(PDFName.of("AcroForm"), afRef);
    objects.push({ ref: rootRef, body: serializeObject(cat) });
  }

  // Invisible signature widget on the last page (it draws nothing, so the sealed pages look exactly the same).
  const pages = doc.getPages();
  const last = pages[pages.length - 1];
  const leaf = last.node.clone(ctx);
  const oldAnnots = last.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
  const annots = ctx.obj([]) as PDFArray;
  if (oldAnnots) for (const a of oldAnnots.asArray()) annots.push(a);
  annots.push(fieldRef);
  leaf.set(PDFName.of("Annots"), annots);
  objects.push({ ref: last.ref, body: serializeObject(leaf) });

  const field = ctx.obj({
    Type: "Annot",
    Subtype: "Widget",
    FT: "Sig",
    Rect: [0, 0, 0, 0],
    F: 132,
    P: last.ref,
    V: sigRef,
  }) as PDFDict;
  field.set(PDFName.of("T"), PDFString.of(SIG_FIELD_PREFIX + (fieldCount + 1)));
  objects.push({ ref: fieldRef, body: serializeObject(field) });

  // Signature dictionary with placeholders for /ByteRange and /Contents.
  const when = o.signingTime ?? new Date();
  const signerName = nameInfo(o.signer.certificate.subject).commonName ?? "";
  const placeholder = "0".repeat(SIGNATURE_RESERVE * 2);
  const sigDict =
    `<<\n/Type /Sig\n/Filter /Adobe.PPKLite\n/SubFilter /ETSI.CAdES.detached\n/ByteRange ${BR_PLACEHOLDER}\n` +
    `/Contents <${placeholder}>\n/M ${pdfLiteral(pdfDate(when))}\n/Reason ${pdfLiteral(consentStatement(o.consent))}\n` +
    (signerName ? `/Name ${utf16Hex(signerName)}\n` : "") +
    `>>`;
  objects.push({ ref: sigRef, body: utf8(sigDict) });

  const size = Math.max(next, ...objects.map((x) => x.ref.objectNumber + 1));
  const { bytes, offsets } = appendRevision(input, objects, {
    size,
    root: rootRef,
    info: ctx.trailerInfo.Info as PDFRef | undefined,
    id: ctx.trailerInfo.ID as PDFArray | undefined,
  });

  // Patch the byte range.
  const sigAt = offsets.get(sigRef.toString())!;
  const text = new TextDecoder("latin1").decode(bytes.subarray(sigAt, sigAt + sigDict.length + 64));
  const contentsStart = sigAt + text.indexOf("/Contents <") + "/Contents ".length;
  const contentsEnd = contentsStart + placeholder.length + 2;
  const br = [0, contentsStart, contentsEnd, bytes.length - contentsEnd];
  const brText = `[${br.join(" ")}]`.padEnd(BR_PLACEHOLDER.length, " ");
  if (brText.length !== BR_PLACEHOLDER.length) throw new Error("File too large to sign.");
  const brAt = sigAt + text.indexOf(BR_PLACEHOLDER);
  bytes.set(utf8(brText), brAt);

  const signed = concatBytes([bytes.subarray(0, contentsStart), bytes.subarray(contentsEnd)]);
  const digest = u8(await subtle().digest("SHA-256", ab(signed)));
  const cms = await createCadesDetached(digest, o.signer, o.timestamp);
  if (cms.length > SIGNATURE_RESERVE) throw new Error("The signature is larger than the space reserved for it.");
  const hex = PDFHexString.of(Array.from(cms, (b) => b.toString(16).padStart(2, "0")).join("").toUpperCase()).asString();
  bytes.set(utf8(hex.padEnd(placeholder.length, "0")), contentsStart + 1);
  return bytes;
}

/** Helper to build a CmsSigner from PEM text (a PKCS#8 private key and a certificate chain, leaf first). */
export async function signerFromPem(privateKeyPem: string, chainPem: string): Promise<CmsSigner> {
  const certs = allPem(chainPem, "CERTIFICATE").map(certFromDer);
  if (!certs.length) throw new Error("No certificate found.");
  return { certificate: certs[0], chain: certs.slice(1), privateKey: await importPrivateKeyPkcs8(fromPem(privateKeyPem, "PRIVATE KEY")) };
}

export type { CmsSigner } from "./cms";
