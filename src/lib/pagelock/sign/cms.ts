/**
 * CMS / CAdES detached signatures (ETSI EN 319 122, as used by PAdES) and RFC 3161 timestamps, using PKI.js.
 */
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { OID, ab, certDer, parseDer, randomSerial, subtle, u8 } from "./pki";

const sha256 = async (d: Uint8Array) => u8(await subtle().digest("SHA-256", ab(d)));

/** A signer: a private key that never leaves its owner, plus the certificate (and chain) that vouch for it. */
export interface CmsSigner {
  certificate: pkijs.Certificate;
  chain: pkijs.Certificate[]; // intermediates / issuer certificates to embed (not required to include the root)
  privateKey: CryptoKey;
}

/** ESS signing-certificate-v2 attribute value: binds the signature to exactly this certificate. */
async function signingCertificateV2(cert: pkijs.Certificate): Promise<asn1js.Sequence> {
  const certHash = await sha256(certDer(cert));
  const issuerSerial = new asn1js.Sequence({
    value: [
      new asn1js.Sequence({
        value: [new asn1js.Constructed({ idBlock: { tagClass: 3, tagNumber: 4 }, value: [cert.issuer.toSchema()] })],
      }),
      new asn1js.Integer({ valueHex: ab(new Uint8Array(cert.serialNumber.valueBlock.valueHexView)) }),
    ],
  });
  // hashAlgorithm is omitted because SHA-256 is the DER default.
  const essCertIdV2 = new asn1js.Sequence({ value: [new asn1js.OctetString({ valueHex: ab(certHash) }), issuerSerial] });
  return new asn1js.Sequence({ value: [new asn1js.Sequence({ value: [essCertIdV2] })] });
}

/** Reads the certificate hash out of a signing-certificate-v2 attribute. Null if absent or not SHA-256. */
export function readSigningCertificateV2Hash(attrs: pkijs.Attribute[] | undefined): Uint8Array | null {
  const a = attrs?.find((x) => x.type === OID.signingCertificateV2);
  if (!a) return null;
  try {
    const certs = (a.values[0] as asn1js.Sequence).valueBlock.value[0] as asn1js.Sequence;
    const id = certs.valueBlock.value[0] as asn1js.Sequence;
    const first = id.valueBlock.value[0];
    if (first instanceof asn1js.OctetString) return new Uint8Array(first.valueBlock.valueHexView);
    const alg = new pkijs.AlgorithmIdentifier({ schema: first });
    if (alg.algorithmId !== OID.sha256) return null;
    return new Uint8Array((id.valueBlock.value[1] as asn1js.OctetString).valueBlock.valueHexView);
  } catch {
    return null;
  }
}

/** Returns a DER TimeStampToken (a CMS ContentInfo) for the given SHA-256 imprint. */
export type TimestampSource = (sha256Imprint: Uint8Array) => Promise<Uint8Array>;

/**
 * Build a detached CAdES-BES signature over `digest` (SHA-256 of the signed data), optionally with an RFC 3161
 * signature timestamp (CAdES-T, i.e. PAdES B-T). Returns DER ContentInfo.
 */
export async function createCadesDetached(digest: Uint8Array, signer: CmsSigner, timestamp?: TimestampSource): Promise<Uint8Array> {
  const cert = signer.certificate;
  const signedAttrs = new pkijs.SignedAndUnsignedAttributes({
    type: 0,
    attributes: [
      new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.data })] }),
      new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: ab(digest) })] }),
      new pkijs.Attribute({ type: OID.signingCertificateV2, values: [await signingCertificateV2(cert)] }),
    ],
  });
  const sd = new pkijs.SignedData({
    version: 1,
    encapContentInfo: new pkijs.EncapsulatedContentInfo({ eContentType: OID.data }),
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
        signedAttrs,
      }),
    ],
    certificates: [cert, ...signer.chain],
  });
  await sd.sign(signer.privateKey, 0, "SHA-256");

  if (timestamp) {
    const si = sd.signerInfos[0];
    const imprint = await sha256(new Uint8Array(si.signature.valueBlock.valueHexView));
    const token = await timestamp(imprint);
    si.unsignedAttrs = new pkijs.SignedAndUnsignedAttributes({
      type: 1,
      attributes: [new pkijs.Attribute({ type: OID.signatureTimeStampToken, values: [parseDer(token)] })],
    });
  }
  const ci = new pkijs.ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) });
  return u8(ci.toSchema().toBER(false));
}

export function parseSignedData(der: Uint8Array): pkijs.SignedData {
  const ci = new pkijs.ContentInfo({ schema: parseDer(der) });
  if (ci.contentType !== OID.signedData) throw new Error("Not a CMS SignedData structure.");
  return new pkijs.SignedData({ schema: ci.content });
}

/** Finds the certificate a SignerInfo points to (issuer + serial, or subject key identifier). */
export function findSignerCert(sd: pkijs.SignedData, index = 0): pkijs.Certificate | null {
  const sid = sd.signerInfos[index].sid;
  const certs = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  if (sid instanceof pkijs.IssuerAndSerialNumber)
    return certs.find((c) => c.issuer.isEqual(sid.issuer) && c.serialNumber.isEqual(sid.serialNumber)) ?? null;
  return null;
}

// ---------------------------------------------------------------- RFC 3161 timestamps

export function timestampRequest(imprint: Uint8Array): Uint8Array {
  const nonce = randomSerial().subarray(0, 8);
  const req = new pkijs.TimeStampReq({
    version: 1,
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: ab(imprint) }),
    }),
    nonce: new asn1js.Integer({ valueHex: ab(nonce) }),
    certReq: true,
  });
  return u8(req.toSchema().toBER(false));
}

/** Parses a TimeStampResp, returning the DER TimeStampToken. Throws if the TSA refused. */
export function tokenFromResponse(respDer: Uint8Array): Uint8Array {
  const resp = new pkijs.TimeStampResp({ schema: parseDer(respDer) });
  if (resp.status.status > 1 || !resp.timeStampToken)
    throw new Error(`The timestamp service refused the request (status ${resp.status.status}).`);
  return u8(resp.timeStampToken.toSchema().toBER(false));
}

/** Timestamp source that calls an RFC 3161 service over HTTP. Only a hash is ever sent. */
export function httpTimestampSource(url: string, fetchImpl: typeof fetch = fetch): TimestampSource {
  return async (imprint) => {
    const r = await fetchImpl(url, {
      method: "POST",
      headers: { "Content-Type": "application/timestamp-query" },
      body: ab(timestampRequest(imprint)),
    });
    if (!r.ok) throw new Error(`The timestamp service answered ${r.status}.`);
    return tokenFromResponse(new Uint8Array(await r.arrayBuffer()));
  };
}

export interface TsaIdentity {
  certificate: pkijs.Certificate;
  chain: pkijs.Certificate[];
  privateKey: CryptoKey;
  policy?: string;
}

/** Issue a TimeStampToken (RFC 3161 / RFC 5816) for an imprint. Used by the PageLock demo TSA and the log server. */
export async function issueTimestampToken(imprint: Uint8Array, tsa: TsaIdentity, genTime = new Date()): Promise<Uint8Array> {
  const serial = new Uint8Array(12);
  globalThis.crypto.getRandomValues(serial);
  serial[0] = (serial[0] & 0x7f) | 0x01;
  const tst = new pkijs.TSTInfo({
    version: 1,
    policy: tsa.policy ?? "1.3.6.1.4.1.32473.1.1",
    messageImprint: new pkijs.MessageImprint({
      hashAlgorithm: new pkijs.AlgorithmIdentifier({ algorithmId: OID.sha256 }),
      hashedMessage: new asn1js.OctetString({ valueHex: ab(imprint) }),
    }),
    serialNumber: new asn1js.Integer({ valueHex: ab(serial) }),
    genTime: new Date(Math.floor(genTime.getTime() / 1000) * 1000),
    ordering: false,
  });
  const tstDer = u8(tst.toSchema().toBER(false));
  const cert = tsa.certificate;
  // PKI.js splits eContent into a constructed OCTET STRING; DER (and strict validators) need it primitive.
  const encap = new pkijs.EncapsulatedContentInfo({ eContentType: OID.tstInfo });
  encap.eContent = new asn1js.OctetString({ valueHex: ab(tstDer) });
  const sd = new pkijs.SignedData({
    version: 3,
    encapContentInfo: encap,
    signerInfos: [
      new pkijs.SignerInfo({
        version: 1,
        sid: new pkijs.IssuerAndSerialNumber({ issuer: cert.issuer, serialNumber: cert.serialNumber }),
        signedAttrs: new pkijs.SignedAndUnsignedAttributes({
          type: 0,
          attributes: [
            new pkijs.Attribute({ type: OID.contentType, values: [new asn1js.ObjectIdentifier({ value: OID.tstInfo })] }),
            new pkijs.Attribute({ type: OID.messageDigest, values: [new asn1js.OctetString({ valueHex: ab(await sha256(tstDer)) })] }),
            new pkijs.Attribute({ type: OID.signingCertificateV2, values: [await signingCertificateV2(cert)] }),
          ],
        }),
      }),
    ],
    certificates: [cert, ...tsa.chain],
  });
  await sd.sign(tsa.privateKey, 0, "SHA-256");
  return u8(new pkijs.ContentInfo({ contentType: OID.signedData, content: sd.toSchema(true) }).toSchema().toBER(false));
}

/** Wraps a token in a granted TimeStampResp (what an RFC 3161 HTTP service returns). */
export function timestampResponse(token: Uint8Array): Uint8Array {
  const resp = new pkijs.TimeStampResp({
    status: new pkijs.PKIStatusInfo({ status: 0 }),
    timeStampToken: new pkijs.ContentInfo({ schema: parseDer(token) }),
  });
  return u8(resp.toSchema().toBER(false));
}

/** Answers a DER TimeStampReq (for a local RFC 3161 service). */
export async function answerTimestampRequest(reqDer: Uint8Array, tsa: TsaIdentity): Promise<Uint8Array> {
  const req = new pkijs.TimeStampReq({ schema: parseDer(reqDer) });
  if (req.messageImprint.hashAlgorithm.algorithmId !== OID.sha256) throw new Error("Only SHA-256 imprints are supported.");
  const imprint = new Uint8Array(req.messageImprint.hashedMessage.valueBlock.valueHexView);
  if (imprint.length !== 32) throw new Error("Bad imprint length.");
  return timestampResponse(await issueTimestampToken(imprint, tsa));
}

export function localTimestampSource(tsa: TsaIdentity): TimestampSource {
  return (imprint) => issueTimestampToken(imprint, tsa);
}

export interface ParsedTimestamp {
  genTime: Date;
  imprint: Uint8Array;
  imprintAlg: string;
  tsaCert: pkijs.Certificate | null;
  certs: pkijs.Certificate[];
  signatureValid: boolean;
  problem?: string;
}

/** Cryptographically checks a TimeStampToken's own signature and reads its time and imprint. */
export async function checkTimestampToken(tokenDer: Uint8Array): Promise<ParsedTimestamp> {
  const sd = parseSignedData(tokenDer);
  if (sd.encapContentInfo.eContentType !== OID.tstInfo || !sd.encapContentInfo.eContent) throw new Error("Not a timestamp token.");
  const content = u8(sd.encapContentInfo.eContent.getValue());
  const tst = new pkijs.TSTInfo({ schema: parseDer(content) });
  const tsaCert = findSignerCert(sd);
  const certs = (sd.certificates ?? []).filter((c): c is pkijs.Certificate => c instanceof pkijs.Certificate);
  let signatureValid = false;
  let problem: string | undefined;
  try {
    // PKI.js would also try to match the imprint against original data we do not have; check the CMS signature
    // over the TSTInfo bytes instead (the imprint is compared by the caller).
    sd.encapContentInfo.eContentType = OID.data;
    const r = await sd.verify({ signer: 0, data: ab(content), checkChain: false, extendedMode: true });
    sd.encapContentInfo.eContentType = OID.tstInfo;
    signatureValid = !!r.signatureVerified;
    if (!signatureValid) problem = r.message;
  } catch (e) {
    problem = (e as { message?: string }).message ?? "signature check failed";
  }
  if (signatureValid && tsaCert) {
    const h = readSigningCertificateV2Hash(sd.signerInfos[0].signedAttrs?.attributes);
    const actual = await sha256(certDer(tsaCert));
    if (h && !equalBytes(h, actual)) {
      signatureValid = false;
      problem = "The timestamp names a different certificate than the one that signed it.";
    }
  }
  return {
    genTime: tst.genTime,
    imprint: new Uint8Array(tst.messageImprint.hashedMessage.valueBlock.valueHexView),
    imprintAlg: tst.messageImprint.hashAlgorithm.algorithmId,
    tsaCert,
    certs,
    signatureValid,
    problem,
  };
}

export function equalBytes(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a[i] ^ b[i];
  return d === 0;
}
