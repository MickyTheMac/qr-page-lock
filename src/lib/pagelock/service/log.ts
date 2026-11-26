/**
 * The sign-off log (Micky's "scan, agree and log" idea).
 *
 * Founder A signs the PDF, then records a sign-off statement for the document's fingerprint, signed with the same
 * key. Founder B does the same, and B's statement names A's log entry, so the record is "signed, then double
 * signed". The log server adds each entry to an append-only hash chain, countersigns it and timestamps it.
 *
 * Privacy (decided 26 Nov 2026): entries are private to the founders. Only the fingerprint and the sign-off time
 * are public. The log never sees the PDF or its wording.
 */
import * as pkijs from "pkijs";
import { canonicalJson, toHex, utf8 } from "../encoding";
import { sha256Hex } from "../crypto";
import { EC_ALG, ab, b64decode, b64encode, certFingerprint, certFromPem, nameInfo, subtle, u8 } from "../sign/pki";

export interface SignOffStatement {
  type: "pagelock-signoff";
  version: 1;
  documentId: string;
  manifestDigest: string;
  pageCount: number;
  /** SHA-256 of the PDF right after this founder's signature. */
  signedPdfSha256: string;
  /** Entry hash of the counterparty's earlier sign-off (null for the first founder). This is the "double sign". */
  counterSigns: string | null;
  signerCertSha256: string;
  statedAt: string;
}

export interface SignOffSubmission {
  statement: SignOffStatement;
  /** Base64 ECDSA P-256 / SHA-256 signature (raw r||s) over canonicalJson(statement). */
  signature: string;
  /** Signer certificate (PEM). */
  certificate: string;
}

export interface LogEntry {
  seq: number;
  prevEntryHash: string; // previous entry in the whole log ("0"*64 for the first)
  receivedAt: string;
  submission: SignOffSubmission;
  entryHash: string; // SHA-256 of canonicalJson({seq, prevEntryHash, receivedAt, submission})
  serverSignature: string; // base64, log key over entryHash bytes
  timestampToken: string; // base64 RFC 3161 token over entryHash
}

export const GENESIS = "0".repeat(64);

export function entryHashInput(e: Pick<LogEntry, "seq" | "prevEntryHash" | "receivedAt" | "submission">): Uint8Array {
  return utf8(canonicalJson({ seq: e.seq, prevEntryHash: e.prevEntryHash, receivedAt: e.receivedAt, submission: e.submission }));
}

export async function computeEntryHash(e: Pick<LogEntry, "seq" | "prevEntryHash" | "receivedAt" | "submission">): Promise<string> {
  return sha256Hex(entryHashInput(e));
}

export async function signBytes(key: CryptoKey, data: Uint8Array): Promise<string> {
  return b64encode(u8(await subtle().sign({ name: "ECDSA", hash: "SHA-256" }, key, ab(data))));
}

export async function publicKeyOf(cert: pkijs.Certificate): Promise<CryptoKey> {
  return subtle().importKey("spki", cert.subjectPublicKeyInfo.toSchema().toBER(false), EC_ALG, false, ["verify"]);
}

export async function verifyBytes(cert: pkijs.Certificate | CryptoKey, data: Uint8Array, sigB64: string): Promise<boolean> {
  try {
    const key = cert instanceof CryptoKey ? cert : await publicKeyOf(cert);
    return await subtle().verify({ name: "ECDSA", hash: "SHA-256" }, key, ab(b64decode(sigB64)), ab(data));
  } catch {
    return false;
  }
}

/** Builds and signs a sign-off statement with the founder's own key (in their browser). */
export async function makeSubmission(
  s: Omit<SignOffStatement, "type" | "version" | "signerCertSha256" | "statedAt"> & { statedAt?: string },
  signer: { certificate: pkijs.Certificate; privateKey: CryptoKey },
  certificatePem: string,
): Promise<SignOffSubmission> {
  const statement: SignOffStatement = {
    type: "pagelock-signoff",
    version: 1,
    documentId: s.documentId,
    manifestDigest: s.manifestDigest,
    pageCount: s.pageCount,
    signedPdfSha256: s.signedPdfSha256,
    counterSigns: s.counterSigns,
    signerCertSha256: await certFingerprint(signer.certificate),
    statedAt: s.statedAt ?? new Date().toISOString(),
  };
  return { statement, signature: await signBytes(signer.privateKey, utf8(canonicalJson(statement))), certificate: certificatePem };
}

export interface LogCheck {
  ok: boolean;
  problems: string[];
  signers: { name: string; email?: string; certSha256: string; at: string }[];
  complete: boolean;
  signedOffAt: string | null;
}

/**
 * Independently checks a document's log entries (as returned to a founder): hash chain links, the log's
 * countersignature, each founder's statement signature, and that the second statement countersigns the first.
 */
export async function checkDocumentLog(entries: LogEntry[], logPublicKey: CryptoKey, manifestDigest: string, required = 2): Promise<LogCheck> {
  const problems: string[] = [];
  const signers: LogCheck["signers"] = [];
  let prevOwn: string | null = null;
  const seen = new Set<string>();
  for (const e of entries) {
    if ((await computeEntryHash(e)) !== e.entryHash) problems.push(`Log entry ${e.seq} does not match its hash.`);
    if (!(await verifyBytes(logPublicKey, utf8(e.entryHash), e.serverSignature))) problems.push(`Log entry ${e.seq} is not countersigned by the log.`);
    const st = e.submission.statement;
    if (st.manifestDigest !== manifestDigest) problems.push(`Log entry ${e.seq} is for a different document.`);
    let cert: pkijs.Certificate;
    try {
      cert = certFromPem(e.submission.certificate);
    } catch {
      problems.push(`Log entry ${e.seq} has a damaged certificate.`);
      continue;
    }
    const fp = await certFingerprint(cert);
    if (fp !== st.signerCertSha256) problems.push(`Log entry ${e.seq} names a different certificate.`);
    if (!(await verifyBytes(cert, utf8(canonicalJson(st)), e.submission.signature))) problems.push(`Log entry ${e.seq}: the founder's signature is invalid.`);
    if (st.counterSigns !== prevOwn) problems.push(`Log entry ${e.seq} does not countersign the previous sign-off.`);
    if (seen.has(fp)) problems.push(`Log entry ${e.seq}: the same founder signed off twice.`);
    seen.add(fp);
    prevOwn = e.entryHash;
    const n = nameInfo(cert.subject);
    signers.push({ name: n.commonName ?? n.text, email: n.email, certSha256: fp, at: e.receivedAt });
  }
  const complete = problems.length === 0 && signers.length >= required;
  return { ok: problems.length === 0, problems, signers, complete, signedOffAt: complete ? entries[required - 1].receivedAt : null };
}

export const hex = toHex;
