/** The last page's QR code is a web link that a phone camera opens. */
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "./tamper";
import { makeSampleAgreement } from "./helpers";
import { PDFDict, PDFName, PDFRawStream, PDFRef } from "pdf-lib";
import { footerContent } from "../src/lib/pagelock/footer";
import { FOOTER_HEIGHT, LINK_BASE, PrepareResult, encodePayload, parsePayload, preparePdf, qrBitmap, verifyPdf } from "../src/lib/pagelock";

let sealed: PrepareResult;
beforeAll(async () => {
  sealed = await preparePdf(await makeSampleAgreement(3));
});

describe("last page QR link", () => {
  it("only the last page is a link, and it carries the start of the document fingerprint", () => {
    const [p1, p2, p3] = sealed.pages;
    expect(p1.payload.startsWith("PL1:")).toBe(true);
    expect(p2.payload.startsWith("PL1:")).toBe(true);
    expect(p3.payload.startsWith(LINK_BASE + "PL1:")).toBe(true);
    const parsed = parsePayload(p3.payload)!;
    expect(parsed.fingerprintPrefix).toBe(sealed.manifest.manifestDigest.slice(0, 16));
  });
  it("stays in QR alphanumeric mode and no bigger than a middle page's code", () => {
    for (const p of sealed.pages) expect(p.payload).toMatch(/^[0-9A-Z $%*+\-./:]+$/);
    expect(qrBitmap(sealed.pages[2].payload, 0).size).toBeLessThanOrEqual(qrBitmap(sealed.pages[1].payload, 0).size);
  });
  it("a link on a page that is not the last is rejected", () => {
    const p = parsePayload(sealed.pages[1].payload)!;
    expect(parsePayload(encodePayload({ ...p, fingerprintPrefix: "0123456789ABCDEF" }))).toBeNull();
  });
  it("a link to another site is rejected", () => {
    expect(parsePayload(sealed.pages[2].payload.replace("PAGELOCK-INDOL", "PAGEL0CK-INDOL"))).toBeNull();
  });
  it("codes without the link (sealed earlier) still parse", () => {
    const p = parsePayload(sealed.pages[2].payload)!;
    const old = encodePayload({ ...p, fingerprintPrefix: undefined });
    expect(old.startsWith("PL1:")).toBe(true);
    expect(parsePayload(old)?.fingerprintPrefix).toBeUndefined();
  });
  it("a one-page document's only page gets the link and verifies", async () => {
    const one = await preparePdf(await makeSampleAgreement(1));
    expect(one.pages).toHaveLength(1);
    expect(one.pages[0].payload.startsWith(LINK_BASE + "PL1:")).toBe(true);
    const p = parsePayload(one.pages[0].payload)!;
    expect(p.prev).toBe("START");
    expect(p.next).toBe("END");
    expect(p.fingerprintPrefix).toBe(one.manifest.manifestDigest.slice(0, 16));
    expect((await verifyPdf(one.pdfBytes)).outcome).toBe("INTERNALLY CONSISTENT");
  });
  it("genuine document still verifies", async () => {
    const r = await verifyPdf(sealed.pdfBytes);
    expect(r.outcome).toBe("INTERNALLY CONSISTENT");
    expect(r.checks.find((c) => c.id === "manifest-binding")?.status).toBe("pass");
  });
  it("a QR whose link names a different fingerprint fails", async () => {
    const p = parsePayload(sealed.pages[2].payload)!;
    const forged = await T.replaceQrText(sealed.pdfBytes, 2, encodePayload({ ...p, fingerprintPrefix: "0000000000000000" }));
    const r = await verifyPdf(forged);
    expect(r.outcome).toBe("ALTERED / INVALID");
    expect(r.checks.find((c) => c.id === "manifest-binding")?.details.join(" ")).toMatch(/different document fingerprint/);
  });
});

const footerText = async (pdf: Uint8Array, pageIdx: number) => {
  const doc = await T.load(pdf);
  const xo = doc.getPages()[pageIdx].node.Resources()!.lookup(PDFName.of("XObject"), PDFDict);
  const ref = xo.get(PDFName.of("PLFoot")) as PDFRef;
  return { doc, ref, stream: doc.context.lookup(ref) as PDFRawStream };
};

describe("'scan to check' line on the last page", () => {
  it("only the last page says it can be scanned", async () => {
    const texts = sealed.pages.map((p) => parsePayload(p.payload)!).map((p) =>
      footerContent({ pageWidth: 595.28, documentId: p.documentId, index: p.index, count: p.count, hash: p.hash, scanHint: p.index === p.count }),
    );
    expect(texts[0]).not.toMatch(/Scan/);
    expect(texts[1]).not.toMatch(/Scan/);
    expect(texts[2]).toMatch(/Scan this QR code with a phone to check this document\./);
  });
  it("on a narrow page it replaces the tagline instead, and stays inside the band", () => {
    const t = footerContent({ pageWidth: 288, documentId: "7K3MQ2XR9VDF4HNC8WBT6JZP", index: 1, count: 1, hash: "A".repeat(64), scanHint: true });
    expect(t).toMatch(/\(Scan[^)]*\) Tj/);
    expect(t).not.toMatch(/Every page accounted for/);
    for (const m of t.matchAll(/ ([\d.]+) ([\d.]+) Td /g)) {
      expect(Number(m[2])).toBeGreaterThanOrEqual(18);
      expect(Number(m[2])).toBeLessThan(FOOTER_HEIGHT);
    }
  });
  it("documents sealed with the link but before this line existed still verify", async () => {
    const { doc, ref, stream } = await footerText(sealed.pdfBytes, 2);
    const p = parsePayload(sealed.pages[2].payload)!;
    const old = footerContent({ pageWidth: doc.getPages()[2].getWidth(), documentId: p.documentId, index: p.index, count: p.count, hash: p.hash, scanHint: false });
    const dict: Record<string, unknown> = {};
    for (const [k, v] of stream.dict.entries()) if (!["Length", "Filter"].includes(k.asString().slice(1))) dict[k.asString().slice(1)] = v;
    doc.context.assign(ref, doc.context.flateStream(new TextEncoder().encode(old), dict as never));
    const r = await verifyPdf(await T.save(doc));
    expect(r.outcome).toBe("INTERNALLY CONSISTENT");
  });
  it("removing the line from a page without a link is still caught as an edit", async () => {
    const { doc, ref, stream } = await footerText(sealed.pdfBytes, 1);
    const p = parsePayload(sealed.pages[1].payload)!;
    const wrong = footerContent({ pageWidth: doc.getPages()[1].getWidth(), documentId: p.documentId, index: p.index, count: p.count, hash: p.hash, scanHint: true });
    const dict: Record<string, unknown> = {};
    for (const [k, v] of stream.dict.entries()) if (!["Length", "Filter"].includes(k.asString().slice(1))) dict[k.asString().slice(1)] = v;
    doc.context.assign(ref, doc.context.flateStream(new TextEncoder().encode(wrong), dict as never));
    expect((await verifyPdf(await T.save(doc))).outcome).toBe("ALTERED / INVALID");
  });
});
