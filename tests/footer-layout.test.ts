/** Footer layout 2 (print-safe) and backwards compatibility with layout 1 seals. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PDFName, PDFRawStream, decodePDFRawStream } from "pdf-lib";
import { makeSampleAgreement } from "./helpers";
import * as T from "./tamper";
import { FOOTER_HEIGHT, PRINT_SAFE_BOTTOM, parseReference, preparePdf, serializeManifestFile, verifyPdf } from "../src/lib/pagelock";
import { parseTrustFile } from "../src/lib/pagelock/sign/trust";

const legacyFile = (layout: string, f: string) => new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", layout, f)));
const legacy = (f: string) => new Uint8Array(readFileSync(join(__dirname, "..", "fixtures", "legacy-layout1", f)));

describe("current footer layout", () => {
  it("adds the band below the page and keeps every footer mark at least 0.5 in above the bottom edge", async () => {
    const r = await preparePdf(await makeSampleAgreement(2));
    const doc = await T.load(r.pdfBytes);
    for (const page of doc.getPages()) {
      expect(page.getHeight()).toBeCloseTo(841.89 + FOOTER_HEIGHT, 2);
      const xo = page.node.lookup(PDFName.of("Resources")) as unknown as { lookup(n: PDFName): { get(n: PDFName): unknown } };
      const foot = doc.context.lookup(xo.lookup(PDFName.of("XObject")).get(PDFName.of("PLFoot")) as never) as PDFRawStream;
      const ops = new TextDecoder().decode(decodePDFRawStream(foot).decode());
      // every y position used in the footer (Td and cm operands) is >= the print-safe margin
      const ys = [...ops.matchAll(/ (\d+(?:\.\d+)?) Td /g), ...ops.matchAll(/ (\d+(?:\.\d+)?) cm /g)].map((m) => Number(m[1]));
      expect(ys.length).toBeGreaterThan(5);
      for (const y of ys) expect(y).toBeGreaterThanOrEqual(PRINT_SAFE_BOTTOM);
      // the page number appears once, right-aligned
      expect(ops.match(/Page \d+ of \d+/g)).toHaveLength(1);
    }
    const ref = await parseReference(serializeManifestFile(r.manifest));
    expect((await verifyPdf(r.pdfBytes, { reference: ref })).outcome).toBe("REFERENCE MATCH");
  });
});

describe("documents sealed with layout 1 still verify", () => {
  it("genuine layout-1 copy -> REFERENCE MATCH", async () => {
    const ref = await parseReference(readFileSync(join(__dirname, "..", "fixtures", "legacy-layout1", "01-sealed-genuine.pagelock-reference.json"), "utf8"));
    const r = await verifyPdf(legacy("01-sealed-genuine.pdf"), { reference: ref });
    expect(r.outcome).toBe("REFERENCE MATCH");
  });
  it("layout-1 copy signed by both founders -> VERIFIED with the test trust file", async () => {
    const trust = parseTrustFile(readFileSync(join(__dirname, "..", "fixtures", "legacy-layout1", "test-authority.pagelock-trust.json"), "utf8"));
    const r = await verifyPdf(legacy("16-signed-by-both.pdf"), { trust });
    expect(r.outcome).toBe("VERIFIED");
  });
  it("tampering with a layout-1 copy is still caught", async () => {
    const r = await verifyPdf(await T.changeCharacter(legacy("01-sealed-genuine.pdf")));
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
});

describe("documents sealed with layout 2 still verify", () => {
  it("genuine layout-2 copy -> REFERENCE MATCH", async () => {
    const ref = await parseReference(readFileSync(join(__dirname, "..", "fixtures", "legacy-layout2", "01-sealed-genuine.pagelock-reference.json"), "utf8"));
    const r = await verifyPdf(legacyFile("legacy-layout2", "01-sealed-genuine.pdf"), { reference: ref });
    expect(r.outcome).toBe("REFERENCE MATCH");
  });
  it("layout-2 copy signed by both founders -> VERIFIED with the test trust file", async () => {
    const trust = parseTrustFile(readFileSync(join(__dirname, "..", "fixtures", "legacy-layout2", "test-authority.pagelock-trust.json"), "utf8"));
    const r = await verifyPdf(legacyFile("legacy-layout2", "16-signed-by-both.pdf"), { trust });
    expect(r.outcome).toBe("VERIFIED");
  });
  it("tampering with a layout-2 copy is still caught", async () => {
    const r = await verifyPdf(await T.changeCharacter(legacyFile("legacy-layout2", "01-sealed-genuine.pdf")));
    expect(r.outcome).toBe("ALTERED / INVALID");
  });
});

