/** The last page's QR code is a web link that a phone camera opens. */
import { beforeAll, describe, expect, it } from "vitest";
import * as T from "./tamper";
import { makeSampleAgreement } from "./helpers";
import { LINK_BASE, PrepareResult, encodePayload, parsePayload, preparePdf, qrBitmap, verifyPdf } from "../src/lib/pagelock";

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
