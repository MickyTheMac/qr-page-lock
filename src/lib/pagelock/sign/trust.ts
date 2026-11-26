/**
 * Trust file: which certificate authorities the verifier trusts for founders' signatures and for timestamps,
 * current revocation lists, and how many distinct signers the agreement needs.
 */
import * as pkijs from "pkijs";
import { allPem, certFromDer, certPem, crlFromPem, crlPem, parseDer, b64decode } from "./pki";

export interface TrustProfile {
  name: string;
  /** True for the built-in demo authority, whose keys are public. Never proof of anyone's identity. */
  demo: boolean;
  signerAnchors: pkijs.Certificate[];
  tsaAnchors: pkijs.Certificate[];
  crls: pkijs.CertificateRevocationList[];
  requiredSigners: number;
  requireTimestamp: boolean;
}

/** On-disk format (`*.pagelock-trust.json`). */
export interface TrustFile {
  pagelockTrust: 1;
  name: string;
  demo?: boolean;
  signerAuthorities: string[]; // PEM certificates
  timestampAuthorities: string[]; // PEM certificates
  revocationLists?: string[]; // PEM CRLs
  requiredSigners?: number;
  requireTimestamp?: boolean;
}

export function parseTrustFile(text: string): TrustProfile {
  let j: TrustFile;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error("The trust file is not valid JSON.");
  }
  if (!j || j.pagelockTrust !== 1 || !Array.isArray(j.signerAuthorities) || !Array.isArray(j.timestampAuthorities))
    throw new Error("This is not a PageLock trust file.");
  const certs = (pems: string[]) => pems.flatMap((p) => allPem(p, "CERTIFICATE")).map(certFromDer);
  return {
    name: String(j.name ?? "Unnamed trust file"),
    demo: !!j.demo,
    signerAnchors: certs(j.signerAuthorities),
    tsaAnchors: certs(j.timestampAuthorities),
    crls: (j.revocationLists ?? []).map((p) => crlFromPem(p)),
    requiredSigners: Math.max(1, Math.floor(j.requiredSigners ?? 2)),
    requireTimestamp: j.requireTimestamp ?? true,
  };
}

export function serializeTrustProfile(t: TrustProfile): string {
  const f: TrustFile = {
    pagelockTrust: 1,
    name: t.name,
    demo: t.demo || undefined,
    signerAuthorities: t.signerAnchors.map(certPem),
    timestampAuthorities: t.tsaAnchors.map(certPem),
    revocationLists: t.crls.map(crlPem),
    requiredSigners: t.requiredSigners,
    requireTimestamp: t.requireTimestamp,
  };
  return JSON.stringify(f, null, 2) + "\n";
}

/** Accepts a CRL in PEM or raw DER (base64) form, e.g. as fetched from a PageLock server. */
export function crlFromText(text: string): pkijs.CertificateRevocationList {
  if (text.includes("-----BEGIN")) return crlFromPem(text);
  return new pkijs.CertificateRevocationList({ schema: parseDer(b64decode(text)) });
}
