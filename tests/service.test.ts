/**
 * PageLock service: certificates issued after an email check, timestamps, and the private sign-off log
 * ("signed, then double signed"), with only fingerprint + sign-off time public.
 */
import { beforeAll, describe, expect, it } from "vitest";
import { makeSampleAgreement, testStore } from "./helpers";
import {
  Identity,
  MemoryStore,
  PageLockClient,
  PageLockService,
  addSignature,
  checkDocumentLog,
  inPageFetch,
  makeSubmission,
  makeTestPki,
  preparePdf,
  serialHex,
  sha256Hex,
  verifyPdf,
} from "../src/lib/pagelock";

const mail: { to: string; text: string }[] = [];
let service: PageLockService;
let client: PageLockClient;
let alice: Identity;
let bob: Identity;
let sealed: Uint8Array;
let facts: { documentId: string; manifestDigest: string; pageCount: number };

async function enrol(name: string, email: string) {
  const s = await client.startEnrolment(name, email);
  const code = mail.filter((m) => m.to === email).pop()!.text.match(/\d{6}/)![0];
  return client.finishEnrolment(s.enrolmentId, code, s.keys);
}

beforeAll(async () => {
  service = await PageLockService.create({
    store: await testStore(),
    mailer: { send: async (to, _s, text) => void mail.push({ to, text }) },
    adminToken: "secret",
  });
  client = new PageLockClient("https://service.test", inPageFetch(service));
  alice = await enrol("Alice Founder", "alice@example.com");
  bob = await enrol("Bob Founder", "bob@example.com");
  sealed = (await preparePdf(await makeSampleAgreement(3))).pdfBytes;
  const r = await verifyPdf(sealed);
  facts = { documentId: r.documentId!, manifestDigest: r.manifestDigest!, pageCount: r.pageCount };
});

describe("certificates", () => {
  it("issues a certificate naming the person, for a key made on their device", async () => {
    expect(alice.certificatePem).toMatch(/BEGIN CERTIFICATE/);
    expect(alice.privateKey.extractable).toBe(false);
  });
  it("wrong email code is refused, and 5 wrong tries lock the request", async () => {
    const s = await client.startEnrolment("Mallory", "mallory@example.com");
    for (let i = 0; i < 5; i++) await expect(client.finishEnrolment(s.enrolmentId, "000000x", s.keys)).rejects.toThrow(/not right/);
    await expect(client.finishEnrolment(s.enrolmentId, "000000", s.keys)).rejects.toThrow(/Too many/);
  });
  it("refuses an enrolment without proof of the key", async () => {
    const r = await service.handle(
      new Request("https://x/api/enrol/start", { method: "POST", body: JSON.stringify({ name: "Eve", email: "eve@example.com", publicKey: "AAAA", proof: "AAAA" }) }),
    );
    expect(r.status).toBe(400);
  });
});

describe("signing with service certificates and timestamps", () => {
  let twice: Uint8Array;
  it("both founders sign -> VERIFIED with the service's trust file", async () => {
    const consent = { ...facts, accepted: true };
    const once = await addSignature(sealed, { signer: alice, consent, timestamp: client.timestampSource() });
    twice = await addSignature(once, { signer: bob, consent, timestamp: client.timestampSource() });
    const r = await verifyPdf(twice, { trust: await client.trust() });
    expect(r.outcome).toBe("VERIFIED");
    expect(r.signatures.map((s) => s.signerName)).toEqual(["Alice Founder", "Bob Founder"]);
    expect(r.signatures[0].signerEmail).toBe("alice@example.com");
  });
  it("a certificate revoked later does not undo earlier timestamped signatures", async () => {
    const svc = await PageLockService.create({ store: new MemoryStore(), mailer: { send: async (to, _s, text) => void mail.push({ to, text }) }, adminToken: "t" });
    const c = new PageLockClient("https://s2.test", inPageFetch(svc));
    const s1 = await c.startEnrolment("Carol", "carol@example.com");
    const carol = await c.finishEnrolment(s1.enrolmentId, mail.filter((m) => m.to === "carol@example.com").pop()!.text.match(/\d{6}/)![0], s1.keys);
    const pdf = await addSignature(sealed, { signer: carol, consent: { ...facts, accepted: true }, timestamp: c.timestampSource() });
    await new Promise((r) => setTimeout(r, 1100));
    await svc.revoke(serialHex(carol.certificate));
    const trust = await c.trust();
    const r = await verifyPdf(pdf, { trust: { ...trust, requiredSigners: 1 } });
    expect(r.outcome).toBe("VERIFIED");
    expect(r.checks.find((x) => x.id === "sig-revocation")!.details.join(" ")).toMatch(/revoked later/);
    // ...but a revoked certificate cannot log a new sign-off.
    const sub = await makeSubmission({ ...facts, signedPdfSha256: await sha256Hex(pdf), counterSigns: null }, carol, carol.certificatePem);
    await expect(c.recordSignOff(sub)).rejects.toThrow(/revoked/);
  });
});

describe("sign-off log: signed, then double signed", () => {
  let firstHash: string;
  it("founder A logs the sign-off (signed once); nothing is public yet", async () => {
    const sub = await makeSubmission({ ...facts, signedPdfSha256: "A".repeat(64), counterSigns: null }, alice, alice.certificatePem);
    const r = await client.recordSignOff(sub);
    expect(r.complete).toBe(false);
    firstHash = r.entry.entryHash;
    expect(await client.publicStatus(facts.manifestDigest)).toEqual({ signedOff: false, signedOffAt: null });
    expect(await client.publicByDocument(facts.documentId)).toEqual([]);
  });
  it("founder B can see only what to countersign, not who signed", async () => {
    const view = await client.readSignOff(facts.manifestDigest, bob);
    expect(view.entries).toEqual([]);
    expect(view.pendingCountersign).toBe(firstHash);
  });
  it("B's sign-off must countersign A's entry", async () => {
    const wrong = await makeSubmission({ ...facts, signedPdfSha256: "B".repeat(64), counterSigns: null }, bob, bob.certificatePem);
    await expect(client.recordSignOff(wrong)).rejects.toThrow(/countersign/);
  });
  it("A cannot sign off twice", async () => {
    const again = await makeSubmission({ ...facts, signedPdfSha256: "A".repeat(64), counterSigns: firstHash }, alice, alice.certificatePem);
    await expect(client.recordSignOff(again)).rejects.toThrow(/already signed off/);
  });
  it("B countersigns -> double signed; only fingerprint and time become public", async () => {
    const sub = await makeSubmission({ ...facts, signedPdfSha256: "B".repeat(64), counterSigns: firstHash }, bob, bob.certificatePem);
    const r = await client.recordSignOff(sub);
    expect(r.complete).toBe(true);
    const pub = await service.handle(new Request(`https://x/api/public/${facts.manifestDigest}`));
    const body = await pub.json();
    expect(Object.keys(body).sort()).toEqual(["manifestDigest", "signedOff", "signedOffAt"]);
    expect(JSON.stringify(body)).not.toMatch(/Alice|Bob|example\.com/);
    // Phone scan of the last page: lookup by the printed document ID shows the same two facts only.
    const byDoc = await (await service.handle(new Request(`https://x/api/public/doc/${facts.documentId}`))).json();
    expect(byDoc.signOffs).toHaveLength(1);
    expect(Object.keys(byDoc.signOffs[0]).sort()).toEqual(["manifestDigest", "signedOffAt"]);
    expect(byDoc.signOffs[0].manifestDigest).toBe(facts.manifestDigest);
    expect(JSON.stringify(byDoc)).not.toMatch(/Alice|Bob|example\.com/);
  });
  it("founders can read and independently check the whole log", async () => {
    const view = await client.readSignOff(facts.manifestDigest, alice);
    expect(view.entries).toHaveLength(2);
    const key = await service.logPublicKey();
    const c = await checkDocumentLog(view.entries, key, facts.manifestDigest);
    expect(c.ok).toBe(true);
    expect(c.complete).toBe(true);
    expect(c.signers.map((s) => s.name)).toEqual(["Alice Founder", "Bob Founder"]);
    // Any edit to a stored entry is detected.
    const forged = structuredClone(view.entries);
    forged[0].submission.statement.signedPdfSha256 = "C".repeat(64);
    expect((await checkDocumentLog(forged, key, facts.manifestDigest)).ok).toBe(false);
  });
  it("someone else with a valid certificate cannot read a completed log", async () => {
    const eve = await enrol("Eve Outsider", "eve@example.com");
    await expect(client.readSignOff(facts.manifestDigest, eve)).rejects.toThrow(/Only the founders/);
  });
  it("certificates from another authority are refused", async () => {
    const other = await makeTestPki();
    const { certPem } = await import("../src/lib/pagelock");
    const sub = await makeSubmission({ ...facts, documentId: facts.documentId, signedPdfSha256: "D".repeat(64), counterSigns: null, manifestDigest: "E".repeat(64) }, other.founders[0], certPem(other.founders[0].certificate));
    await expect(client.recordSignOff(sub)).rejects.toThrow(/not issued by this PageLock service/);
  });
  it("the log is one hash chain", async () => {
    const head = await (await service.handle(new Request("https://x/api/head"))).json();
    expect(head.size).toBe(2);
  });
});
