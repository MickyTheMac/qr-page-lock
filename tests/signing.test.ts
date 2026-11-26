import { beforeAll, describe, expect, it } from "vitest";
import { makeSampleAgreement } from "./helpers";
import { PrepareResult, preparePdf, verifyPdf, addSignature, makeTestPki, localTimestampSource, TestPki } from "../src/lib/pagelock";

let sealed: PrepareResult;
let pki: TestPki;
beforeAll(async () => {
  sealed = await preparePdf(await makeSampleAgreement(3));
  pki = await makeTestPki();
});

describe("signing", () => {
  it("two founders -> VERIFIED", async () => {
    const r0 = await verifyPdf(sealed.pdfBytes);
    const consent = { documentId: r0.documentId!, manifestDigest: r0.manifestDigest!, pageCount: r0.pageCount, accepted: true };
    const ts = localTimestampSource(pki.tsa);
    const once = await addSignature(sealed.pdfBytes, { signer: pki.founders[0], consent, timestamp: ts });
    const r1 = await verifyPdf(once, { trust: pki.trust });
    console.log(r1.outcome, JSON.stringify(r1.checks.filter((c) => c.status !== "pass"), null, 1));
    const twice = await addSignature(once, { signer: pki.founders[1], consent, timestamp: ts });
    const r2 = await verifyPdf(twice, { trust: pki.trust });
    console.log(r2.outcome, JSON.stringify(r2.checks.filter((c) => c.status !== "pass"), null, 1));
    expect(r2.outcome).toBe("VERIFIED");
  });
});
