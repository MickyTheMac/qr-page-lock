/**
 * Phase 2 acceptance tests (brief §6, §12): sequential two-party PAdES signatures, explicit consent,
 * certificate trust, revocation, timestamps and changes between or after signatures.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDict, PDFDocument, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { makeSampleAgreement } from "./helpers";
import * as T from "./tamper";
import {
  CmsSigner,
  PrepareResult,
  TestPki,
  TimestampSource,
  VerifyReport,
  addSignature,
  appendRevision,
  generateKeyPair,
  issueCertificate,
  issueCrl,
  localTimestampSource,
  makeTestPki,
  parseReference,
  parseTrustFile,
  preparePdf,
  serializeManifestFile,
  serializeObject,
  serialHex,
  serializeTrustProfile,
  verifyPdf,
  evidenceReport,
} from "../src/lib/pagelock";

let sealed: PrepareResult;
let pki: TestPki;
let ts: TimestampSource;
let consent: { documentId: string; manifestDigest: string; pageCount: number; accepted: boolean };
let once: Uint8Array;
let twice: Uint8Array;

const status = (r: VerifyReport, id: string) => r.checks.find((c) => c.id === id)?.status;
const details = (r: VerifyReport, id: string) => r.checks.find((c) => c.id === id)?.details.join(" ") ?? "";
const sign = (pdf: Uint8Array, signer: CmsSigner, o: Partial<Parameters<typeof addSignature>[1]> = {}) =>
  addSignature(pdf, { signer, consent, timestamp: ts, ...o });

beforeAll(async () => {
  sealed = await preparePdf(await makeSampleAgreement(3));
  pki = await makeTestPki();
  ts = localTimestampSource(pki.tsa);
  const r = await verifyPdf(sealed.pdfBytes);
  consent = { documentId: r.documentId!, manifestDigest: r.manifestDigest!, pageCount: r.pageCount, accepted: true };
  once = await sign(sealed.pdfBytes, pki.founders[0]);
  twice = await sign(once, pki.founders[1]);
});

/** Append a revision that changes one existing object (what an editor does when it saves a small change). */
async function editObject(pdf: Uint8Array, pick: (doc: PDFDocument) => PDFRef, change: (o: PDFDict | PDFRawStream, doc: PDFDocument) => Uint8Array) {
  const doc = await PDFDocument.load(pdf, { updateMetadata: false });
  const ref = pick(doc);
  const obj = doc.context.lookup(ref) as PDFDict | PDFRawStream;
  const body = change(obj, doc);
  return appendRevision(pdf, [{ ref, body }], {
    size: doc.context.largestObjectNumber + 1,
    root: doc.context.trailerInfo.Root as PDFRef,
    info: doc.context.trailerInfo.Info as PDFRef,
  }).bytes;
}

describe("valid sequential signatures", () => {
  it("both founders signed, trusted and timestamped -> VERIFIED", async () => {
    const r = await verifyPdf(twice, { trust: pki.trust });
    expect(r.outcome).toBe("VERIFIED");
    expect(r.checks.filter((c) => c.status !== "pass" && c.id !== "reference")).toEqual([]);
    expect(r.signatures.map((s) => s.signerName)).toEqual(["Founder A", "Founder B"]);
    expect(r.signatures.every((s) => s.valid && s.timestampTime)).toBe(true);
    expect(r.signatures[1].coversWholeFile).toBe(true);
  });
  it("earlier signature and the sealed original are preserved byte for byte", async () => {
    expect(twice.subarray(0, once.length)).toEqual(once);
    expect(once.subarray(0, sealed.pdfBytes.length)).toEqual(sealed.pdfBytes);
  });
  it("with the trusted reference too: the sealed revision is the exact prepared file", async () => {
    const ref = await parseReference(serializeManifestFile(sealed.manifest));
    const r = await verifyPdf(twice, { trust: pki.trust, reference: ref });
    expect(r.outcome).toBe("VERIFIED");
    expect(status(r, "exact-file")).toBe("pass");
    expect(status(r, "reference")).toBe("pass");
  });
  it("only one founder signed -> not VERIFIED (1 of 2)", async () => {
    const r = await verifyPdf(once, { trust: pki.trust });
    expect(r.outcome).toBe("INTERNALLY CONSISTENT");
    expect(status(r, "signatures")).toBe("inconclusive");
    expect(details(r, "signatures")).toMatch(/1 of 2/);
  });
  it("the same founder signing twice counts once", async () => {
    const r = await verifyPdf(await sign(once, pki.founders[0]), { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(details(r, "signatures")).toMatch(/1 of 2/);
  });
  it("a trust file round-trips", async () => {
    const t = parseTrustFile(serializeTrustProfile(pki.trust));
    expect((await verifyPdf(twice, { trust: t })).outcome).toBe("VERIFIED");
  });
  it("visible pages are unchanged by signing (same page fingerprints)", async () => {
    const a = await verifyPdf(sealed.pdfBytes);
    const b = await verifyPdf(twice, { trust: pki.trust });
    expect(b.pages.map((p) => p.computedHash)).toEqual(a.pages.map((p) => p.computedHash));
  });
});

describe("unsigned and untrusted", () => {
  it("unsigned document is never VERIFIED, even with a trust file", async () => {
    const r = await verifyPdf(sealed.pdfBytes, { trust: pki.trust });
    expect(r.outcome).toBe("INTERNALLY CONSISTENT");
    expect(status(r, "signatures")).toBe("not-provided");
  });
  it("no trust file -> signatures cannot establish identity -> not VERIFIED", async () => {
    const r = await verifyPdf(twice);
    expect(r.outcome).toBe("INTERNALLY CONSISTENT");
    expect(status(r, "sig-integrity")).toBe("pass");
    expect(status(r, "sig-trust")).toBe("not-provided");
  });
  it("untrusted signer certificate (another authority) -> not VERIFIED", async () => {
    const stranger = await makeTestPki({ rootName: "Some Other CA" });
    const pdf = await sign(once, stranger.founders[1]);
    const r = await verifyPdf(pdf, { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "sig-trust")).toBe("inconclusive");
    expect(details(r, "sig-trust")).toMatch(/not from a trusted authority/);
  });
  it("self-signed certificate -> not VERIFIED", async () => {
    const k = await generateKeyPair();
    const cert = await issueCertificate({ kind: "signer", subject: { cn: "Founder B" }, publicKey: k.publicKey, selfKey: k.privateKey });
    const r = await verifyPdf(await sign(once, { certificate: cert, chain: [], privateKey: k.privateKey }), { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "sig-trust")).toBe("inconclusive");
  });
  it("expired certificate at signing time -> not trusted", async () => {
    const k = await generateKeyPair();
    const old = new Date(Date.now() - 400 * 86400_000);
    const cert = await issueCertificate({
      kind: "signer",
      subject: { cn: "Founder B" },
      publicKey: k.publicKey,
      issuer: pki.root,
      notBefore: old,
      notAfter: new Date(old.getTime() + 86400_000),
    });
    const r = await verifyPdf(await sign(once, { certificate: cert, chain: [pki.root.cert], privateKey: k.privateKey }), { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "sig-trust")).toBe("inconclusive");
  });
});

describe("changes between or after signatures", () => {
  it("title edited after the second signature -> ALTERED / INVALID", async () => {
    const r = await verifyPdf(T.appendIncrementalUpdate(twice), { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(status(r, "revisions")).toBe("fail");
  });
  it("edit between the first and second signature -> ALTERED / INVALID", async () => {
    const edited = T.appendIncrementalUpdate(once);
    const r = await verifyPdf(await sign(edited, pki.founders[1]), { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(details(r, "revisions")).toMatch(/Revision 3/);
  });
  it("page content replaced in a later revision -> ALTERED / INVALID", async () => {
    const pdf = await editObject(
      twice,
      (doc) => doc.getPages()[0].node.get(PDFName.of("Contents")) as PDFRef,
      (_o, doc) => serializeObject(doc.context.flateStream("0 0 1 rg 0 0 600 800 re f")),
    );
    const r = await verifyPdf(pdf, { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
  it("a visible annotation added after signing -> ALTERED / INVALID", async () => {
    const pdf = await editObject(
      twice,
      (doc) => doc.getPages()[0].ref,
      (o, doc) => {
        const d = (o as PDFDict).clone(doc.context);
        d.set(PDFName.of("Annots"), doc.context.obj([doc.context.obj({ Type: "Annot", Subtype: "FreeText", Rect: [10, 10, 300, 60], Contents: "70/30" })]));
        return serializeObject(d);
      },
    );
    const r = await verifyPdf(pdf, { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
  it("one byte of the signed content flipped -> ALTERED / INVALID", async () => {
    const bad = twice.slice();
    const at = bad.length - 30; // inside the last trailer/xref
    bad[at] = bad[at] === 0x30 ? 0x31 : 0x30;
    const r = await verifyPdf(bad, { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(["ALTERED / INVALID", "UNABLE TO VERIFY"]).toContain(r.outcome);
  });
  it("signature value corrupted -> ALTERED / INVALID", async () => {
    const s = new TextDecoder("latin1").decode(twice);
    const i = s.lastIndexOf("/Contents <") + 200;
    const bad = twice.slice();
    bad[i] = bad[i] === 0x41 ? 0x42 : 0x41;
    const r = await verifyPdf(bad, { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
  it("data appended after the last signature -> ALTERED / INVALID", async () => {
    const pdf = new Uint8Array([...twice, ...new TextEncoder().encode("\n% extra\n")]);
    const r = await verifyPdf(pdf, { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
  it("a tampered page under valid signatures still fails the page checks", async () => {
    // Sign a document whose page was edited (and fully re-saved) after sealing: signatures cannot launder it.
    const tampered = await T.changeCharacter(sealed.pdfBytes);
    const r = await verifyPdf(await sign(await sign(tampered, pki.founders[0]), pki.founders[1]), { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
});

describe("consent", () => {
  it("signing without explicit consent is refused", async () => {
    await expect(sign(sealed.pdfBytes, pki.founders[0], { consent: { ...consent, accepted: false } })).rejects.toThrow(/consent/);
  });
  it("consent naming a different document -> ALTERED / INVALID", async () => {
    const wrong = { ...consent, manifestDigest: "0".repeat(64) };
    const r = await verifyPdf(await sign(once, pki.founders[1], { consent: wrong }), { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(status(r, "sig-consent")).toBe("fail");
  });
});

describe("timestamps and revocation", () => {
  it("no timestamp -> not VERIFIED (time rests on the signer's clock)", async () => {
    const r = await verifyPdf(await sign(once, pki.founders[1], { timestamp: undefined }), { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "sig-timestamp")).toBe("inconclusive");
  });
  it("timestamp from an untrusted authority -> not VERIFIED", async () => {
    const other = await makeTestPki({ rootName: "Rogue TSA" });
    const r = await verifyPdf(await sign(once, pki.founders[1], { timestamp: localTimestampSource(other.tsa) }), { trust: pki.trust });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "sig-timestamp")).toBe("inconclusive");
  });
  it("timestamp for a different signature -> ALTERED / INVALID", async () => {
    const lying: TimestampSource = (imprint) => ts(imprint.map((b) => b ^ 0xff));
    const r = await verifyPdf(await sign(once, pki.founders[1], { timestamp: lying }), { trust: pki.trust });
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(status(r, "sig-timestamp")).toBe("fail");
  });
  it("certificate revoked before signing -> ALTERED / INVALID", async () => {
    const crl = await issueCrl({
      issuer: pki.root,
      nextUpdate: new Date(Date.now() + 86400_000),
      revoked: [{ serial: serialHex(pki.founders[1].certificate), date: new Date(Date.now() - 3600_000) }],
    });
    const r = await verifyPdf(twice, { trust: { ...pki.trust, crls: [crl] } });
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(status(r, "sig-revocation")).toBe("fail");
  });
  it("certificate revoked after signing -> still VERIFIED (the timestamp proves it was signed first)", async () => {
    const crl = await issueCrl({
      issuer: pki.root,
      nextUpdate: new Date(Date.now() + 86400_000),
      revoked: [{ serial: serialHex(pki.founders[1].certificate), date: new Date(Date.now() + 3600_000) }],
    });
    const r = await verifyPdf(twice, { trust: { ...pki.trust, crls: [crl] } });
    expect(r.outcome).toBe("VERIFIED");
    expect(details(r, "sig-revocation")).toMatch(/revoked later/);
  });
  it("no revocation information -> inconclusive, not VERIFIED", async () => {
    const r = await verifyPdf(twice, { trust: { ...pki.trust, crls: [] } });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "sig-revocation")).toBe("inconclusive");
  });
  it("revocation list forged by someone else is ignored", async () => {
    const other = await makeTestPki({ rootName: "PageLock Test Root" }); // same name, different key
    const r = await verifyPdf(twice, { trust: { ...pki.trust, crls: [other.crl] } });
    expect(status(r, "sig-revocation")).toBe("inconclusive");
  });
});

describe("evidence report", () => {
  it("is a PDF listing the outcome, signers and every check", async () => {
    const r = await verifyPdf(twice, { trust: pki.trust });
    const pdf = await evidenceReport(r, { fileName: "agreement.pdf" });
    const doc = await PDFDocument.load(pdf);
    expect(doc.getPageCount()).toBeGreaterThanOrEqual(1);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    mkdirSync("test-output", { recursive: true });
    writeFileSync("test-output/evidence-verified.pdf", pdf);
    const bad = await verifyPdf(T.appendIncrementalUpdate(twice), { trust: pki.trust });
    writeFileSync("test-output/evidence-altered.pdf", await evidenceReport(bad));
  });
});
