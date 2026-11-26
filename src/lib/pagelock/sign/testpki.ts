/**
 * Builds a complete certificate setup (root authority, founders, timestamp authority, revocation list) in memory.
 * Used by tests, by the fixture script, and to generate the public DEMO authority. Never for real identities.
 */
import * as pkijs from "pkijs";
import { CmsSigner, TsaIdentity } from "./cms";
import { crlPem, exportPrivateKeyPem, certPem, generateKeyPair, issueCertificate, issueCrl, RevokedEntry } from "./pki";
import { TrustProfile } from "./trust";

export interface TestPki {
  root: { cert: pkijs.Certificate; key: CryptoKey };
  tsa: TsaIdentity;
  founders: CmsSigner[];
  crl: pkijs.CertificateRevocationList;
  trust: TrustProfile;
  keyPems?: { root: string; tsa: string; founders: string[] };
}

export interface TestPkiOptions {
  rootName?: string;
  org?: string;
  founders?: { cn: string; email?: string }[];
  revoked?: RevokedEntry[];
  notBefore?: Date;
  years?: number;
  exportKeys?: boolean;
  demo?: boolean;
}

export async function makeTestPki(o: TestPkiOptions = {}): Promise<TestPki> {
  const ex = !!o.exportKeys;
  const nb = o.notBefore ?? new Date(Date.now() - 86400_000);
  const na = new Date(nb.getTime() + (o.years ?? 3) * 365 * 86400_000);
  const org = o.org ?? "PageLock test";
  const rootKeys = await generateKeyPair(ex);
  const rootCert = await issueCertificate({
    kind: "ca",
    subject: { cn: o.rootName ?? "PageLock Test Root", o: org },
    publicKey: rootKeys.publicKey,
    selfKey: rootKeys.privateKey,
    notBefore: nb,
    notAfter: na,
  });
  const root = { cert: rootCert, key: rootKeys.privateKey };
  const tsaKeys = await generateKeyPair(ex);
  const tsaCert = await issueCertificate({
    kind: "tsa",
    subject: { cn: `${o.rootName ?? "PageLock Test"} Timestamp Authority`, o: org },
    publicKey: tsaKeys.publicKey,
    issuer: root,
    notBefore: nb,
    notAfter: na,
  });
  const people = o.founders ?? [
    { cn: "Founder A", email: "founder.a@example.com" },
    { cn: "Founder B", email: "founder.b@example.com" },
  ];
  const founders: CmsSigner[] = [];
  const founderKeys: CryptoKey[] = [];
  for (const p of people) {
    const k = await generateKeyPair(ex);
    founderKeys.push(k.privateKey);
    const cert = await issueCertificate({ kind: "signer", subject: { ...p, o: org }, publicKey: k.publicKey, issuer: root, notBefore: nb, notAfter: na });
    founders.push({ certificate: cert, chain: [rootCert], privateKey: k.privateKey });
  }
  const crl = await issueCrl({ issuer: root, thisUpdate: nb, nextUpdate: na, revoked: o.revoked });
  const tsa: TsaIdentity = { certificate: tsaCert, chain: [rootCert], privateKey: tsaKeys.privateKey };
  const trust: TrustProfile = {
    name: o.rootName ?? "PageLock Test Root",
    demo: !!o.demo,
    signerAnchors: [rootCert],
    tsaAnchors: [rootCert],
    crls: [crl],
    requiredSigners: 2,
    requireTimestamp: true,
  };
  const pki: TestPki = { root, tsa, founders, crl, trust };
  if (ex)
    pki.keyPems = {
      root: await exportPrivateKeyPem(rootKeys.privateKey),
      tsa: await exportPrivateKeyPem(tsaKeys.privateKey),
      founders: await Promise.all(founderKeys.map(exportPrivateKeyPem)),
    };
  return pki;
}

/** Serialisable form of a PKI (for the built-in demo authority). */
export interface PkiBundle {
  rootCert: string;
  rootKey: string;
  tsaCert: string;
  tsaKey: string;
  crl: string;
  founders: { cert: string; key: string }[];
}

export async function bundlePki(p: TestPki): Promise<PkiBundle> {
  if (!p.keyPems) throw new Error("Keys were not exported.");
  return {
    rootCert: certPem(p.root.cert),
    rootKey: p.keyPems.root,
    tsaCert: certPem(p.tsa.certificate),
    tsaKey: p.keyPems.tsa,
    crl: crlPem(p.crl),
    founders: p.founders.map((f, i) => ({ cert: certPem(f.certificate), key: p.keyPems!.founders[i] })),
  };
}
