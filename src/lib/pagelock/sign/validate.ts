/**
 * Signature validation for signed PageLock PDFs (brief §6): byte-range coverage, "only signatures were added
 * after sealing", CMS integrity, consent wording, certificate trust, revocation and RFC 3161 timestamps.
 * Every check is reported separately; anything that cannot be established is inconclusive, never a pass.
 */
import * as pkijs from "pkijs";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFObject, PDFRef, PDFString } from "pdf-lib";
import { concatBytes } from "../encoding";
import { checkTimestampToken, equalBytes, findSignerCert, parseSignedData, readSigningCertificateV2Hash } from "./cms";
import { eolLength, serializeObject } from "./incremental";
import { OID, ab, certDer, certFingerprint, hasExtKeyUsage, nameInfo, subtle, u8 } from "./pki";
import { consentStatement } from "./sign";
import { TrustProfile } from "./trust";

type Status = "pass" | "fail" | "inconclusive" | "not-provided" | "not-available";

export interface SigCheck {
  id: string;
  label: string;
  status: Status;
  details: string[];
}

export interface SignatureInfo {
  index: number; // 1-based, in signing order
  revision: number; // 1 = sealed original, 2 = first signature...
  signerName: string;
  signerEmail?: string;
  issuerName: string;
  certificateSha256: string | null;
  claimedTime: string | null; // the signer's own clock (/M), informative only
  timestampTime: string | null; // trusted time from the timestamp authority
  timestampAuthority: string | null;
  coversWholeFile: boolean;
  integrity: Status;
  consent: Status;
  trust: Status;
  revocation: Status;
  timestamp: Status;
  problems: string[];
  /** Everything about this signature passed. */
  valid: boolean;
}

export interface SignatureAnalysis {
  checks: SigCheck[];
  signatures: SignatureInfo[];
  trustedSigners: number;
  requiredSigners: number;
  allPass: boolean;
}

export interface DocumentFacts {
  documentId: string | null;
  manifestDigest: string | null;
  pageCount: number;
}

const sha256 = async (d: Uint8Array) => u8(await subtle().digest("SHA-256", ab(d)));
const loadRev = (b: Uint8Array) => PDFDocument.load(b, { updateMetadata: false, throwOnInvalidObject: true });

function same(a: PDFObject | undefined, b: PDFObject | undefined): boolean {
  if (!a || !b) return a === b;
  return equalBytes(serializeObject(a), serializeObject(b));
}

function refList(ctx: PDFDocument["context"], o: PDFObject | undefined): string[] | null {
  if (!o) return [];
  const arr = ctx.lookupMaybe(o, PDFArray);
  if (!arr) return null;
  return arr.asArray().map((x) => (x instanceof PDFRef ? x.toString() : "direct"));
}

interface RevisionDiff {
  problems: string[];
  sigRef: PDFRef | null;
}

/** Revision k may only add one invisible signature field, its signature, and the form entries pointing to them. */
function diffRevision(prev: PDFDocument, cur: PDFDocument, revNo: number): RevisionDiff {
  const problems: string[] = [];
  const bad = (m: string) => problems.push(`Revision ${revNo}: ${m}`);
  const pctx = prev.context;
  const cctx = cur.context;
  const prevObjs = new Map<string, PDFObject>();
  for (const [r, o] of pctx.enumerateIndirectObjects()) prevObjs.set(r.toString(), o);
  const added: [PDFRef, PDFObject][] = [];
  const changed: [PDFRef, PDFObject][] = [];
  for (const [r, o] of cctx.enumerateIndirectObjects()) {
    const p = prevObjs.get(r.toString());
    if (!p) added.push([r, o]);
    else if (!same(p, o)) changed.push([r, o]);
  }

  const root = cctx.trailerInfo.Root;
  if (!(root instanceof PDFRef) || root.toString() !== String(pctx.trailerInfo.Root)) bad("the document catalog was replaced.");
  const afRefObj = cur.catalog.get(PDFName.of("AcroForm"));
  const afRef = afRefObj instanceof PDFRef ? afRefObj.toString() : null;
  const prevAfObj = prev.catalog.get(PDFName.of("AcroForm"));
  const prevAfRef = prevAfObj instanceof PDFRef ? prevAfObj.toString() : null;
  if (prevAfObj && !prevAfRef) bad("unsupported form structure.");
  if (prevAfRef && afRef !== prevAfRef) bad("the form structure was replaced.");

  const pageRefs = new Set(cur.getPages().map((p) => p.ref.toString()));
  const newFields: PDFRef[] = [];
  const newSigs = new Set<string>();
  let sigRef: PDFRef | null = null;

  for (const [r, o] of added) {
    const d = o instanceof PDFDict ? o : null;
    const key = r.toString();
    if (d && key === afRef && !prevAfRef) continue; // checked below
    if (d && d.get(PDFName.of("FT"))?.toString() === "/Sig" && d.get(PDFName.of("Subtype"))?.toString() === "/Widget") {
      const extra = d.keys().map((k) => k.decodeText()).filter((k) => !["Type", "Subtype", "FT", "Rect", "F", "P", "V", "T"].includes(k));
      const rect = cctx.lookupMaybe(d.get(PDFName.of("Rect")), PDFArray);
      const zero = !!rect && rect.size() === 4 && rect.asArray().every((n) => n instanceof PDFNumber && n.asNumber() === 0);
      if (extra.length) bad(`a signature field carries extra data (/${extra[0]}).`);
      if (!zero) bad("a signature field is visible (it could draw over the page).");
      if (d.get(PDFName.of("AP"))) bad("a signature field has its own appearance.");
      newFields.push(r);
      const v = d.get(PDFName.of("V"));
      if (v instanceof PDFRef) sigRef = v;
      continue;
    }
    if (d && d.get(PDFName.of("Type"))?.toString() === "/Sig") {
      newSigs.add(key);
      continue;
    }
    bad(`added object ${key} that is not part of a signature.`);
  }
  if (newFields.length !== 1 || newSigs.size !== 1 || !sigRef || !newSigs.has(sigRef.toString()))
    bad(newFields.length === 0 ? "was saved without adding a signature (an edit after sealing or signing)." : "must add exactly one signature.");

  const fieldKeys = new Set(newFields.map((f) => f.toString()));
  const checkAcroForm = (d: PDFDict | undefined, prevD: PDFDict | undefined) => {
    if (!d) return bad("the form dictionary is damaged.");
    const extra = d.keys().map((k) => k.decodeText()).filter((k) => !["Fields", "SigFlags"].includes(k));
    if (extra.length) bad(`the form dictionary carries extra data (/${extra[0]}).`);
    const now = refList(cctx, d.get(PDFName.of("Fields")));
    const before = prevD ? refList(pctx, prevD.get(PDFName.of("Fields"))) : [];
    if (!now || !before) return bad("unsupported form field list.");
    if (before.some((x, i) => now[i] !== x) || now.slice(before.length).some((x) => !fieldKeys.has(x)) || now.length !== before.length + newFields.length)
      bad("form fields were changed, not just a signature added.");
  };
  if (afRef && !prevAfRef) checkAcroForm(cctx.lookupMaybe(afRefObj, PDFDict), undefined);

  for (const [r, o] of changed) {
    const key = r.toString();
    if (key === String(root)) {
      const pc = prev.catalog;
      const cc = o as PDFDict;
      const keys = (d: PDFDict) => d.keys().map((k) => k.decodeText()).filter((k) => k !== "AcroForm").sort();
      const kc = keys(cc);
      if (kc.join() !== keys(pc).join() || kc.some((k) => !same(pc.get(PDFName.of(k)), cc.get(PDFName.of(k)))))
        bad("the document catalog was changed beyond adding a signature form.");
      continue;
    }
    if (key === afRef && prevAfRef) {
      checkAcroForm(o as PDFDict, pctx.lookupMaybe(prevAfObj, PDFDict));
      continue;
    }
    if (pageRefs.has(key) && o instanceof PDFDict) {
      const pd = pctx.lookup(r) as PDFDict;
      const keys = (d: PDFDict) => d.keys().map((k) => k.decodeText()).filter((k) => k !== "Annots").sort();
      if (keys(o).join() !== keys(pd).join() || keys(o).some((k) => !same(pd.get(PDFName.of(k)), o.get(PDFName.of(k)))))
        bad(`page object ${key} was changed beyond adding a signature field.`);
      const now = refList(cctx, o.get(PDFName.of("Annots")));
      const before = refList(pctx, pd.get(PDFName.of("Annots")));
      if (!now || !before || before.some((x, i) => now[i] !== x) || now.slice(before.length).some((x) => !fieldKeys.has(x)))
        bad("page annotations were changed, not just a signature field added.");
      continue;
    }
    bad(`changed object ${key}, which signing never changes.`);
  }
  return { problems, sigRef };
}

/** Validate a certification path to one of the anchors at a given time. */
async function validatePath(leaf: pkijs.Certificate, others: pkijs.Certificate[], anchors: pkijs.Certificate[], at: Date) {
  if (!anchors.length) return { ok: false, path: [] as pkijs.Certificate[], message: "No trusted authorities are configured." };
  const engine = new pkijs.CertificateChainValidationEngine({
    trustedCerts: anchors,
    certs: [...others.filter((c) => !equalBytes(certDer(c), certDer(leaf))), leaf],
    checkDate: at,
  });
  try {
    const r = await engine.verify();
    return { ok: r.result, path: r.certificatePath ?? [], message: r.resultMessage };
  } catch (e) {
    return { ok: false, path: [], message: (e as { resultMessage?: string; message?: string }).resultMessage ?? (e as Error).message ?? "path validation failed" };
  }
}

/** CRL-based revocation for every non-root certificate in the path. */
async function revocation(path: pkijs.Certificate[], crls: pkijs.CertificateRevocationList[], at: Date): Promise<{ status: Status; detail: string }> {
  if (path.length < 2) return { status: "inconclusive", detail: "No certification path to check." };
  const notes: string[] = [];
  for (let i = 0; i < path.length - 1; i++) {
    const cert = path[i];
    const issuer = path[i + 1];
    let crl: pkijs.CertificateRevocationList | undefined;
    for (const c of crls) {
      if (!c.issuer.isEqual(cert.issuer)) continue;
      try {
        if (await c.verify({ issuerCertificate: issuer })) {
          crl = c;
          break;
        }
      } catch {
        /* wrong issuer key */
      }
    }
    const who = nameInfo(cert.subject).text;
    if (!crl) return { status: "inconclusive", detail: `No current revocation list for ${who}.` };
    const rev = crl.revokedCertificates?.find((r) => r.userCertificate.isEqual(cert.serialNumber));
    if (rev) {
      if (rev.revocationDate.value.getTime() <= at.getTime())
        return { status: "fail", detail: `${who}'s certificate was revoked on ${rev.revocationDate.value.toISOString()}, before this signature.` };
      notes.push(`${who}'s certificate was revoked later (${rev.revocationDate.value.toISOString()}); the signature was made before that.`);
    }
    if (crl.thisUpdate.value.getTime() > Date.now() + 300_000) return { status: "inconclusive", detail: "A revocation list is dated in the future." };
  }
  return { status: "pass", detail: notes.join(" ") };
}

function hexToBytes(h: string): Uint8Array | null {
  if (!/^[0-9A-Fa-f]*$/.test(h) || h.length % 2) return null;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.substr(i * 2, 2), 16);
  return out;
}

function str(o: PDFObject | undefined): string | null {
  if (o instanceof PDFString || o instanceof PDFHexString) return o.decodeText();
  return null;
}

type Cat = "integrity" | "consent" | "timestamp" | "trust" | "revocation";

const LABELS: Record<string, string> = {
  "sig-changes": "Only signatures were added after sealing",
  "sig-coverage": "Each signature covers the whole file as it was signed",
  "sig-integrity": "Each signature is mathematically valid for its bytes",
  "sig-consent": "Each signer consented to this exact document",
  "sig-trust": "Signer certificates are issued by a trusted authority",
  "sig-revocation": "Signer certificates were not revoked",
  "sig-timestamp": "Each signature has a trusted timestamp",
  signatures: "Required signers have all signed",
};

/**
 * Analyse every signature revision. `revEnds` are the %%EOF offsets; revision 1 is the sealed original.
 * `trust` may be null (then trust-dependent checks are "not provided").
 */
export async function analyzeSignatures(input: Uint8Array, revEnds: number[], facts: DocumentFacts, trust: TrustProfile | null): Promise<SignatureAnalysis> {
  const required = trust?.requiredSigners ?? 2;
  const checks: SigCheck[] = [];
  const add = (id: string, status: Status, details: string[]) => checks.push({ id, label: LABELS[id], status, details: [...new Set(details)] });

  if (revEnds.length <= 1) {
    add("signatures", "not-provided", ["This copy has not been signed yet. Use Sign to add each founder's signature."]);
    return { checks, signatures: [], trustedSigners: 0, requiredSigners: required, allPass: false };
  }

  // Load every revision as it was when saved.
  const docs: PDFDocument[] = [];
  try {
    for (const end of revEnds) docs.push(await loadRev(input.subarray(0, end + eolLength(input, end))));
  } catch {
    add("sig-changes", "fail", ["A saved revision of this file could not be read."]);
    add("signatures", "inconclusive", ["Signatures could not be checked."]);
    return { checks, signatures: [], trustedSigners: 0, requiredSigners: required, allPass: false };
  }

  const changeProblems: string[] = [];
  const coverageProblems: string[] = [];
  const sigs: SignatureInfo[] = [];
  const byCat: Record<Cat, string[]> = { integrity: [], consent: [], timestamp: [], trust: [], revocation: [] };
  const trailing = input.length - revEnds[revEnds.length - 1];
  if (trailing > eolLength(input, revEnds[revEnds.length - 1])) coverageProblems.push("Data was added after the last signature.");

  for (let k = 1; k < docs.length; k++) {
    const revNo = k + 1;
    const diff = diffRevision(docs[k - 1], docs[k], revNo);
    changeProblems.push(...diff.problems);
    const info: SignatureInfo = {
      index: k,
      revision: revNo,
      signerName: "(unknown)",
      issuerName: "(unknown)",
      certificateSha256: null,
      claimedTime: null,
      timestampTime: null,
      timestampAuthority: null,
      coversWholeFile: false,
      integrity: "fail",
      consent: "fail",
      trust: trust ? "inconclusive" : "not-provided",
      revocation: trust ? "inconclusive" : "not-provided",
      timestamp: "inconclusive",
      problems: [],
      valid: false,
    };
    sigs.push(info);
    const p = (c: Cat, m: string) => {
      info.problems.push(m);
      byCat[c].push(`Signature ${info.index} (${info.signerName}): ${m}`);
    };
    const sigDict = diff.sigRef ? docs[k].context.lookupMaybe(diff.sigRef, PDFDict) : undefined;
    if (!sigDict) {
      p("integrity", "No signature was found in this revision.");
      continue;
    }
    const subFilter = sigDict.get(PDFName.of("SubFilter"))?.toString();
    if (subFilter !== "/ETSI.CAdES.detached") p("integrity", `Unsupported signature format (${subFilter ?? "none"}); PAdES needs ETSI.CAdES.detached.`);
    info.claimedTime = str(sigDict.get(PDFName.of("M")));

    // Byte range: [0 a b c], gap = exactly the /Contents hex string, ending exactly at this revision's end.
    const br = docs[k].context.lookupMaybe(sigDict.get(PDFName.of("ByteRange")), PDFArray);
    const nums = br?.asArray().map((n) => (n instanceof PDFNumber ? n.asNumber() : NaN)) ?? [];
    const end = revEnds[k];
    const [s0, a, b, c] = nums;
    const okRange =
      nums.length === 4 &&
      nums.every((n) => Number.isSafeInteger(n) && n >= 0) &&
      s0 === 0 &&
      a > 0 &&
      b > a + 1 &&
      (b + c === end || b + c === end + eolLength(input, end)) &&
      input[a] === 0x3c &&
      input[b - 1] === 0x3e;
    if (!okRange) {
      coverageProblems.push(`Signature ${k} does not cover its whole revision (gaps in the signed bytes).`);
      continue;
    }
    info.coversWholeFile = k === docs.length - 1;
    const hex = new TextDecoder("latin1").decode(input.subarray(a + 1, b - 1));
    const der = hexToBytes(hex);
    if (!der) {
      coverageProblems.push(`Signature ${k}'s unsigned gap contains something other than the signature.`);
      continue;
    }

    // CMS integrity.
    const signed = concatBytes([input.subarray(0, a), input.subarray(b, b + c)]);
    let sd: pkijs.SignedData;
    try {
      sd = parseSignedData(der);
    } catch {
      p("integrity", "The signature data is damaged.");
      continue;
    }
    const si = sd.signerInfos[0];
    const cert = findSignerCert(sd);
    const certs = (sd.certificates ?? []).filter((x): x is pkijs.Certificate => x instanceof pkijs.Certificate);
    if (!cert || sd.signerInfos.length !== 1) {
      p("integrity", "The signer's certificate is missing from the signature.");
      continue;
    }
    const subj = nameInfo(cert.subject);
    info.signerName = subj.commonName ?? subj.text;
    info.signerEmail = subj.email;
    info.issuerName = nameInfo(cert.issuer).text;
    info.certificateSha256 = await certFingerprint(cert);
    let cryptoOk = false;
    try {
      const r = await sd.verify({ signer: 0, data: ab(signed), checkChain: false, extendedMode: true });
      cryptoOk = !!r.signatureVerified;
    } catch (e) {
      p("integrity", `Signature check failed: ${(e as { message?: string }).message ?? "invalid"}.`);
    }
    const ct = si.signedAttrs?.attributes.find((x) => x.type === OID.contentType);
    const certHash = readSigningCertificateV2Hash(si.signedAttrs?.attributes);
    if (!ct || !certHash || !equalBytes(certHash, await sha256(certDer(cert)))) {
      cryptoOk = false;
      p("integrity", "The signature is not bound to its certificate (missing or wrong signing-certificate attribute).");
    }
    if (cryptoOk && subFilter === "/ETSI.CAdES.detached") info.integrity = "pass";
    else if (!info.problems.length) p("integrity", "The signed bytes were changed after signing, or the signature is not valid.");

    // Consent wording must name exactly this document.
    const reason = str(sigDict.get(PDFName.of("Reason")));
    const expected =
      facts.documentId && facts.manifestDigest
        ? consentStatement({ documentId: facts.documentId, manifestDigest: facts.manifestDigest, pageCount: facts.pageCount })
        : null;
    if (expected && reason === expected) info.consent = "pass";
    else p("consent", reason ? "The consent statement does not name this exact document." : "No consent statement was signed.");

    // Timestamp (RFC 3161) over the signature value.
    let trustedTime: Date | null = null;
    const tsAttr = si.unsignedAttrs?.attributes.find((x) => x.type === OID.signatureTimeStampToken);
    if (!tsAttr) {
      info.timestamp = trust && !trust.requireTimestamp ? "pass" : "inconclusive";
      p("timestamp", "The signature has no trusted timestamp, so its time rests on the signer's own clock.");
    } else {
      try {
        const tokenDer = u8(tsAttr.values[0].toBER(false));
        const ts = await checkTimestampToken(tokenDer);
        const imprint = await sha256(new Uint8Array(si.signature.valueBlock.valueHexView));
        info.timestampTime = ts.genTime.toISOString();
        info.timestampAuthority = ts.tsaCert ? nameInfo(ts.tsaCert.subject).text : null;
        if (!ts.signatureValid || ts.imprintAlg !== OID.sha256 || !equalBytes(ts.imprint, imprint)) {
          info.timestamp = "fail";
          p("timestamp", "The timestamp does not match this signature.");
        } else if (!trust) {
          info.timestamp = "not-provided";
        } else if (!ts.tsaCert || !hasExtKeyUsage(ts.tsaCert, OID.timeStamping)) {
          p("timestamp", "The timestamp was not issued by a timestamping certificate.");
        } else {
          const path = await validatePath(ts.tsaCert, ts.certs, trust.tsaAnchors, ts.genTime);
          if (path.ok) {
            info.timestamp = "pass";
            trustedTime = ts.genTime;
          } else p("timestamp", `The timestamp authority is not trusted (${path.message}).`);
        }
      } catch {
        info.timestamp = "fail";
        p("timestamp", "The timestamp is damaged.");
      }
    }

    // Certificate trust and revocation, evaluated at the trusted time when there is one.
    if (trust) {
      const at = trustedTime ?? new Date();
      const path = await validatePath(cert, certs, trust.signerAnchors, at);
      if (!path.ok) p("trust", `${info.signerName}'s certificate is not from a trusted authority (${path.message}).`);
      else {
        info.trust = "pass";
        const rv = await revocation(path.path, trust.crls, at);
        info.revocation = rv.status;
        if (rv.detail) p("revocation", rv.detail);
      }
    }
    info.valid = [info.integrity, info.consent, info.trust, info.revocation, info.timestamp].every((s) => s === "pass") && info.problems.every((x) => / revoked later /.test(x));
  }

  // Aggregate.
  const agg = (pick: (s: SignatureInfo) => Status): Status => {
    const st = sigs.map(pick);
    if (st.includes("fail")) return "fail";
    if (st.includes("inconclusive") || st.length === 0) return "inconclusive";
    if (st.includes("not-provided")) return "not-provided";
    return "pass";
  };
  add("sig-changes", changeProblems.length ? "fail" : "pass", changeProblems);
  add("sig-coverage", coverageProblems.length ? "fail" : "pass", coverageProblems);
  add("sig-integrity", agg((s) => s.integrity), byCat.integrity);
  add("sig-consent", agg((s) => s.consent), byCat.consent);
  add("sig-trust", trust ? agg((s) => s.trust) : "not-provided", trust ? byCat.trust : ["No trust file loaded, so PageLock cannot say who the signers are."]);
  add("sig-revocation", trust ? agg((s) => s.revocation) : "not-provided", byCat.revocation);
  add("sig-timestamp", agg((s) => s.timestamp), byCat.timestamp);

  // Distinct, fully valid signers.
  const distinct = new Set<string>();
  for (const s of sigs) if (s.valid && s.certificateSha256) distinct.add(s.signerName + "|" + s.certificateSha256);
  const keys = new Set<string>();
  const dupes: string[] = [];
  for (const s of sigs) {
    if (!s.certificateSha256) continue;
    if (keys.has(s.certificateSha256)) dupes.push(`${s.signerName} signed more than once; that counts as one signer.`);
    keys.add(s.certificateSha256);
  }
  const names = new Set(sigs.filter((s) => s.valid).map((s) => s.signerName.toLowerCase()));
  const trustedSigners = Math.min(distinct.size, names.size, new Set(sigs.filter((s) => s.valid).map((s) => s.certificateSha256)).size);
  add(
    "signatures",
    trustedSigners >= required ? "pass" : "inconclusive",
    [
      `${trustedSigners} of ${required} required signers have a fully valid, trusted signature.`,
      ...dupes,
      ...sigs.map((s) => `Signature ${s.index}: ${s.signerName}${s.timestampTime ? `, timestamped ${s.timestampTime}` : ""}${s.valid ? "" : " (not fully valid)"}.`),
    ],
  );
  const allPass = checks.every((c) => c.status === "pass");
  return { checks, signatures: sigs, trustedSigners, requiredSigners: required, allPass };
}
