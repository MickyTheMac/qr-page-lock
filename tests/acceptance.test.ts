/**
 * Acceptance tests from brief §12. Each test names the attack it simulates.
 * Rule under test throughout: never report an inconclusive check as a pass.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { PDFDocument, PDFName, StandardFonts } from "pdf-lib";
import { makeSampleAgreement } from "./helpers";
import * as T from "./tamper";
import {
  ParsedReference,
  PrepareResult,
  UnsupportedPdfError,
  parseReference,
  preparePdf,
  serializeManifestFile,
  verifyPdf,
} from "../src/lib/pagelock";

let original: Uint8Array;
let genuine: PrepareResult;
let ref: ParsedReference;
let digestRef: ParsedReference;
let other: PrepareResult; // a different agreement, sealed separately

const status = (r: Awaited<ReturnType<typeof verifyPdf>>, id: string) => r.checks.find((c) => c.id === id)?.status;

beforeAll(async () => {
  original = await makeSampleAgreement(3);
  genuine = await preparePdf(original);
  ref = await parseReference(serializeManifestFile(genuine.manifest));
  digestRef = await parseReference(genuine.manifest.manifestDigest);
  other = await preparePdf(await makeSampleAgreement(3, { marker: "Draft B - different wording" }));
});

describe("genuine documents", () => {
  it("REFERENCE MATCH with the trusted manifest file", async () => {
    const r = await verifyPdf(genuine.pdfBytes, { reference: ref });
    expect(r.outcome).toBe("REFERENCE MATCH");
    expect(r.checks.filter((c) => c.status === "fail")).toEqual([]);
    expect(status(r, "exact-file")).toBe("pass");
  });
  it("REFERENCE MATCH with only the manifest digest (e.g. from an email)", async () => {
    expect((await verifyPdf(genuine.pdfBytes, { reference: digestRef })).outcome).toBe("REFERENCE MATCH");
  });
  it("INTERNALLY CONSISTENT without any trusted reference", async () => {
    const r = await verifyPdf(genuine.pdfBytes);
    expect(r.outcome).toBe("INTERNALLY CONSISTENT");
    expect(status(r, "reference")).toBe("not-provided");
  });
  it("unsigned documents are never reported as VERIFIED", async () => {
    const r = await verifyPdf(genuine.pdfBytes, { reference: ref });
    expect(r.outcome).not.toBe("VERIFIED");
    expect(status(r, "signatures")).toBe("not-provided");
  });
  it("fingerprints are computed before QR codes and match the manifest", async () => {
    const r = await verifyPdf(genuine.pdfBytes);
    expect(r.pages.map((p) => p.computedHash)).toEqual(genuine.manifest.body.pages.map((p) => p.hash));
    expect(genuine.manifest.body.pages[0].prev).toBe("START");
    expect(genuine.manifest.body.pages[2].next).toBe("END");
  });
  it("QR payload contains no document wording", () => {
    for (const p of genuine.pages) expect(p.payload).toMatch(/^PL1:[0-9A-Z]{24}:\d+:\d+(:[0-9A-F]{64}|:START|:END){3}$/);
  });
});

describe("repeatable fingerprints", () => {
  it("same input gives the same page hashes every time", async () => {
    const a = await preparePdf(original);
    const b = await preparePdf(original);
    expect(a.manifest.body.pages).toEqual(b.manifest.body.pages);
    expect(a.documentId).not.toBe(b.documentId); // random document IDs
  });
  it("fixed ID + timestamp gives a byte-identical prepared PDF", async () => {
    const opts = { documentId: "0123456789ABCDEFGHJKMNPQ", createdAt: "2026-11-26T00:00:00.000Z" };
    const a = await preparePdf(original, opts);
    const b = await preparePdf(original, opts);
    expect(a.manifest.preparedPdfSha256).toBe(b.manifest.preparedPdfSha256);
  });
  it("handles inherited resources and multiple content streams", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    const page = doc.addPage([612, 792]);
    page.drawText("First stream", { x: 72, y: 700, size: 12, font });
    const ctx = doc.context;
    // second content stream
    page.node.addContentStream(ctx.register(ctx.flateStream("BT /F1 12 Tf 72 680 Td (Second stream) Tj ET")));
    // move Resources up to the page tree root so the page inherits them
    const res = page.node.get(PDFName.of("Resources"))!;
    doc.catalog.Pages().set(PDFName.of("Resources"), res);
    page.node.delete(PDFName.of("Resources"));
    const bytes = await doc.save({ useObjectStreams: false });
    const r = await preparePdf(bytes);
    const v = await verifyPdf(r.pdfBytes, { reference: await parseReference(serializeManifestFile(r.manifest)) });
    expect(v.outcome).toBe("REFERENCE MATCH");
  });
  it("different content gives a different hash", async () => {
    expect(other.manifest.body.pages[0].hash).not.toBe(genuine.manifest.body.pages[0].hash);
  });
});

describe("tampering is detected (ALTERED / INVALID)", () => {
  const cases: [string, () => Promise<Uint8Array>, string[]][] = [
    ["changed characters (50% -> 60%)", () => T.changeCharacter(genuine.pdfBytes), ["content"]],
    ["copied QR code from page 1 onto page 2", () => T.copyQr(genuine.pdfBytes, 0, 1), ["content", "order"]],
    ["page replaced with an unsealed page", async () => T.replacePage(genuine.pdfBytes, await makeSampleAgreement(3, { marker: "x" }), 1), ["sealed"]],
    ["page replaced with a sealed page from another document", () => T.replacePage(genuine.pdfBytes, other.pdfBytes, 1), ["document", "links"]],
    ["unsealed page inserted", async () => T.insertPage(genuine.pdfBytes, await makeSampleAgreement(1), 1), ["sealed", "order"]],
    ["sealed page from another document inserted", () => T.insertPage(genuine.pdfBytes, other.pdfBytes, 1, 1), ["document", "order"]],
    ["middle page deleted", () => T.deletePage(genuine.pdfBytes, 1), ["order", "links"]],
    ["last page deleted", () => T.deletePage(genuine.pdfBytes, 2), ["order", "links"]],
    ["first page deleted", () => T.deletePage(genuine.pdfBytes, 0), ["order", "links"]],
    ["pages reordered", () => T.swapPages(genuine.pdfBytes, 1, 2), ["order", "links"]],
    ["white box drawn over a clause", () => T.overlayBox(genuine.pdfBytes), ["structure"]],
    ["footer text edited", () => T.editFooterText(genuine.pdfBytes), ["structure"]],
    ["annotation added on top of a page", () => T.addAnnotation(genuine.pdfBytes), ["structure"]],
    ["embedded manifest removed", () => T.removeEmbeddedManifest(genuine.pdfBytes), ["manifest-binding"]],
    ["embedded manifest edited to drop a page", () => T.editEmbeddedManifest(genuine.pdfBytes, (b) => { b.pageCount = 2; (b.pages as unknown[]).pop(); }), ["manifest-binding"]],
    ["edit saved as an incremental update", async () => T.appendIncrementalUpdate(genuine.pdfBytes), ["revisions"]],
  ];
  for (const [name, make, failing] of cases) {
    it(name, async () => {
      const bytes = await make();
      for (const reference of [undefined, ref]) {
        const r = await verifyPdf(bytes, { reference });
        expect(r.outcome, JSON.stringify(r.checks, null, 1)).toBe("ALTERED / INVALID");
        for (const id of failing) expect(status(r, id), id).toBe("fail");
      }
    });
  }

  it("cross-document pages (two seals of the same text mixed)", async () => {
    const twin = await preparePdf(original); // same wording, different document ID
    const mixed = await T.replacePage(genuine.pdfBytes, twin.pdfBytes, 1);
    const r = await verifyPdf(mixed);
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(status(r, "document")).toBe("fail");
  });
});

describe("regenerated chains", () => {
  it("a re-sealed edited copy looks internally consistent but FAILS against the trusted reference", async () => {
    // attacker edits the original wording and runs PageLock again
    const edited = await T.changeOriginalCharacter(original, 0);
    const forged = await preparePdf(edited);
    expect((await verifyPdf(forged.pdfBytes)).outcome).toBe("INTERNALLY CONSISTENT");
    const r = await verifyPdf(forged.pdfBytes, { reference: ref });
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(status(r, "reference")).toBe("fail");
    expect((await verifyPdf(forged.pdfBytes, { reference: digestRef })).outcome).toBe("ALTERED / INVALID");
  });
  it("re-sealing with the SAME document ID still fails the trusted reference", async () => {
    const edited = await T.changeOriginalCharacter(original, 0);
    const forged = await preparePdf(edited, { documentId: genuine.documentId });
    const r = await verifyPdf(forged.pdfBytes, { reference: digestRef });
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
  it("the wrong reference manifest is reported as a mismatch", async () => {
    const otherRef = await parseReference(serializeManifestFile(other.manifest));
    expect((await verifyPdf(genuine.pdfBytes, { reference: otherRef })).outcome).toBe("ALTERED / INVALID");
  });
});

describe("re-saved files", () => {
  it("re-saving with the same tool and no changes is byte-identical", async () => {
    const r = await verifyPdf(await T.resave(genuine.pdfBytes), { reference: ref });
    expect(r.outcome).toBe("REFERENCE MATCH");
  });
  it("metadata changed: pages still match, but the exact-file check fails", async () => {
    const resaved = await T.changeMetadata(genuine.pdfBytes);
    expect((await verifyPdf(resaved, { reference: digestRef })).outcome).toBe("REFERENCE MATCH");
    const r = await verifyPdf(resaved, { reference: ref });
    expect(status(r, "exact-file")).toBe("fail");
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
});

describe("inconclusive is never a pass (UNABLE TO VERIFY)", () => {
  it("unreadable QR code", async () => {
    const r = await verifyPdf(await T.scrambleQr(genuine.pdfBytes, 1));
    expect(r.outcome).toBe("UNABLE TO VERIFY");
  });
  it("a PDF that was never sealed", async () => {
    expect((await verifyPdf(original)).outcome).toBe("UNABLE TO VERIFY");
  });
  it("not a PDF at all", async () => {
    expect((await verifyPdf(new TextEncoder().encode("hello"))).outcome).toBe("UNABLE TO VERIFY");
  });
});

describe("ambiguous or active PDFs are rejected at CREATE", () => {
  async function build(mod: (doc: PDFDocument) => void | Promise<void>) {
    const doc = await PDFDocument.load(original);
    await mod(doc);
    return doc.save({ useObjectStreams: false });
  }
  const rejects = async (bytes: Uint8Array, msg: RegExp) => {
    await expect(preparePdf(bytes)).rejects.toThrow(UnsupportedPdfError);
    await expect(preparePdf(bytes)).rejects.toThrow(msg);
  };
  it("JavaScript", async () =>
    rejects(await build((d) => d.catalog.set(PDFName.of("OpenAction"), d.context.obj({ S: "JavaScript", JS: "app.alert(1)" }))), /active/));
  it("form fields", async () => {
    const bytes = await build((d) => {
      d.getForm().createTextField("name").addToPage(d.getPages()[0], { x: 72, y: 100 });
    });
    await expect(preparePdf(bytes)).rejects.toThrow(UnsupportedPdfError);
  });
  it("comments / links on pages", async () => rejects(await T.addAnnotation(original), /comments, links or form fields/));
  it("rotated pages", async () => rejects(await build((d) => d.getPages()[1].setRotation({ type: "degrees", angle: 90 } as never)), /rotated/));
  it("cropped pages", async () => rejects(await build((d) => d.getPages()[0].setCropBox(0, 0, 300, 300)), /cropped/));
  it("hidden layers", async () => rejects(await build((d) => d.catalog.set(PDFName.of("OCProperties"), d.context.obj({}))), /layers/));
  it("attachments", async () =>
    rejects(await build((d) => d.attach(new Uint8Array([1, 2, 3]), "secret.bin", { mimeType: "application/octet-stream" })), /attached|embedded/));
  it("already sealed documents", async () => rejects(genuine.pdfBytes, /already carries PageLock seals/));
  it("files that are not PDFs", async () => rejects(new TextEncoder().encode("not a pdf"), /not a PDF/));
  it("files over the size limit", async () => {
    const big = new Uint8Array(26 * 1024 * 1024);
    big.set(new TextEncoder().encode("%PDF-1.7"));
    await rejects(big, /larger than/);
  });
  it("encrypted PDFs", async () => {
    const s = Array.from(original, (c) => String.fromCharCode(c)).join("");
    const enc = s.replace(/trailer\s*<</, "trailer\n<< /Encrypt << /Filter /Standard /V 1 /R 2 /O <00> /U <00> /P -4 >>");
    await rejects(Uint8Array.from(enc, (c) => c.charCodeAt(0)), /encrypted/);
  });
});

// Signing acceptance tests (brief §12, Phase 2) are in tests/signing.test.ts.
