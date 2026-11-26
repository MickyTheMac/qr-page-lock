/**
 * Small certificate helpers on top of PKI.js (a maintained X.509 / CMS library).
 * Keys are ECDSA P-256 Web Crypto keys, so the same code runs in the browser and in Node.
 */
import * as asn1js from "asn1js";
import * as pkijs from "pkijs";
import { sha256Hex } from "../crypto";

export const OID = {
  data: "1.2.840.113549.1.7.1",
  signedData: "1.2.840.113549.1.7.2",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  signingCertificateV2: "1.2.840.113549.1.9.16.2.47",
  signatureTimeStampToken: "1.2.840.113549.1.9.16.2.14",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  sha256: "2.16.840.1.101.3.4.2.1",
  commonName: "2.5.4.3",
  organization: "2.5.4.10",
  email: "1.2.840.113549.1.9.1",
  basicConstraints: "2.5.29.19",
  keyUsage: "2.5.29.15",
  extKeyUsage: "2.5.29.37",
  subjectKeyId: "2.5.29.14",
  authorityKeyId: "2.5.29.35",
  timeStamping: "1.3.6.1.5.5.7.3.8",
  emailProtection: "1.3.6.1.5.5.7.3.4",
  /** Adobe "document signing" purpose; also accepted by most validators. */
  documentSigning: "1.3.6.1.4.1.311.10.3.12",
} as const;

export const EC_ALG: EcKeyGenParams & EcKeyImportParams = { name: "ECDSA", namedCurve: "P-256" };

export function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available in this environment.");
  return c.subtle;
}

export const ab = (u: Uint8Array): ArrayBuffer => u.buffer.slice(u.byteOffset, u.byteOffset + u.byteLength) as ArrayBuffer;
export const u8 = (b: ArrayBuffer | ArrayBufferView): Uint8Array =>
  b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength);

export function b64encode(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
export function b64decode(s: string): Uint8Array {
  const bin = atob(s.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function toPem(label: string, der: Uint8Array): string {
  const b = b64encode(der).match(/.{1,64}/g)!.join("\n");
  return `-----BEGIN ${label}-----\n${b}\n-----END ${label}-----\n`;
}
export function fromPem(pem: string, label?: string): Uint8Array {
  const re = /-----BEGIN ([A-Z0-9 ]+)-----([\s\S]*?)-----END \1-----/;
  const m = pem.match(re);
  if (!m) throw new Error("Not a PEM block.");
  if (label && m[1] !== label) throw new Error(`Expected a ${label}, found a ${m[1]}.`);
  return b64decode(m[2]);
}
/** All PEM blocks of one kind in a text (e.g. a certificate chain file). */
export function allPem(text: string, label: string): Uint8Array[] {
  const out: Uint8Array[] = [];
  const re = new RegExp(`-----BEGIN ${label}-----([\\s\\S]*?)-----END ${label}-----`, "g");
  for (const m of text.matchAll(re)) out.push(b64decode(m[1]));
  return out;
}

export function parseDer(der: Uint8Array): asn1js.AsnType {
  const r = asn1js.fromBER(ab(der));
  if (r.offset === -1) throw new Error("Malformed ASN.1 data.");
  return r.result;
}

export function certFromDer(der: Uint8Array): pkijs.Certificate {
  return new pkijs.Certificate({ schema: parseDer(der) });
}
export function certFromPem(pem: string): pkijs.Certificate {
  return certFromDer(fromPem(pem, "CERTIFICATE"));
}
export function certDer(c: pkijs.Certificate): Uint8Array {
  return u8(c.toSchema(true).toBER(false));
}
export function certPem(c: pkijs.Certificate): string {
  return toPem("CERTIFICATE", certDer(c));
}
export function crlFromPem(pem: string): pkijs.CertificateRevocationList {
  return new pkijs.CertificateRevocationList({ schema: parseDer(fromPem(pem, "X509 CRL")) });
}
export function crlPem(c: pkijs.CertificateRevocationList): string {
  return toPem("X509 CRL", u8(c.toSchema(true).toBER(false)));
}

export async function certFingerprint(c: pkijs.Certificate): Promise<string> {
  return sha256Hex(certDer(c));
}

function rdnValue(name: pkijs.RelativeDistinguishedNames, oid: string): string | undefined {
  const tv = name.typesAndValues.find((t) => t.type === oid);
  return tv ? String((tv.value as asn1js.BaseStringBlock).valueBlock.value) : undefined;
}

export interface NameInfo {
  commonName?: string;
  organization?: string;
  email?: string;
  text: string;
}
export function nameInfo(name: pkijs.RelativeDistinguishedNames): NameInfo {
  const commonName = rdnValue(name, OID.commonName);
  const organization = rdnValue(name, OID.organization);
  const email = rdnValue(name, OID.email);
  const text = [commonName, email && `<${email}>`, organization && `(${organization})`].filter(Boolean).join(" ") || "(no name)";
  return { commonName, organization, email, text };
}

export function sameName(a: pkijs.RelativeDistinguishedNames, b: pkijs.RelativeDistinguishedNames): boolean {
  return a.isEqual(b);
}

export function serialHex(c: { serialNumber: asn1js.Integer }): string {
  return Array.from(c.serialNumber.valueBlock.valueHexView, (x) => x.toString(16).padStart(2, "0")).join("").toUpperCase();
}

export async function generateKeyPair(extractable = false): Promise<CryptoKeyPair> {
  return (await subtle().generateKey(EC_ALG, extractable, ["sign", "verify"])) as CryptoKeyPair;
}

export async function importPrivateKeyPkcs8(der: Uint8Array): Promise<CryptoKey> {
  return subtle().importKey("pkcs8", ab(der), EC_ALG, false, ["sign"]);
}
export async function exportPrivateKeyPem(k: CryptoKey): Promise<string> {
  return toPem("PRIVATE KEY", u8(await subtle().exportKey("pkcs8", k)));
}

export function randomSerial(): Uint8Array {
  const s = new Uint8Array(16);
  globalThis.crypto.getRandomValues(s);
  s[0] &= 0x7f; // positive
  s[0] |= 0x01; // no leading zero byte
  return s;
}

function rdn(fields: { cn: string; o?: string; email?: string }): pkijs.RelativeDistinguishedNames {
  const r = new pkijs.RelativeDistinguishedNames();
  if (fields.o) r.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.organization, value: new asn1js.Utf8String({ value: fields.o }) }));
  r.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.commonName, value: new asn1js.Utf8String({ value: fields.cn }) }));
  if (fields.email) r.typesAndValues.push(new pkijs.AttributeTypeAndValue({ type: OID.email, value: new asn1js.IA5String({ value: fields.email }) }));
  return r;
}

async function keyId(c: pkijs.Certificate): Promise<Uint8Array> {
  const spk = c.subjectPublicKeyInfo.subjectPublicKey.valueBlock.valueHexView;
  return u8(await subtle().digest("SHA-1", ab(new Uint8Array(spk)))).subarray(0, 20);
}

export type CertKind = "ca" | "signer" | "tsa";

export interface IssueOptions {
  kind: CertKind;
  subject: { cn: string; o?: string; email?: string };
  publicKey: CryptoKey;
  issuer?: { cert: pkijs.Certificate; key: CryptoKey }; // omitted = self-signed (root)
  selfKey?: CryptoKey; // private key for self-signed roots
  notBefore?: Date;
  notAfter?: Date;
  serial?: Uint8Array;
}

/** Issue an X.509 v3 certificate (root CA, founder signing certificate or timestamp authority). */
export async function issueCertificate(o: IssueOptions): Promise<pkijs.Certificate> {
  const c = new pkijs.Certificate();
  c.version = 2;
  c.serialNumber = new asn1js.Integer({ valueHex: ab(o.serial ?? randomSerial()) });
  c.subject = rdn(o.subject);
  c.issuer = o.issuer ? o.issuer.cert.subject : rdn(o.subject);
  const nb = o.notBefore ?? new Date(Date.now() - 60_000);
  c.notBefore.value = nb;
  c.notAfter.value = o.notAfter ?? new Date(nb.getTime() + 2 * 365 * 86400_000);
  await c.subjectPublicKeyInfo.importKey(o.publicKey);

  const ext: pkijs.Extension[] = [];
  const ca = o.kind === "ca";
  ext.push(
    new pkijs.Extension({
      extnID: OID.basicConstraints,
      critical: true,
      extnValue: new pkijs.BasicConstraints({ cA: ca }).toSchema().toBER(false),
    }),
  );
  // keyUsage bits: digitalSignature(0)=0x80, nonRepudiation(1)=0x40, keyCertSign(5)=0x04, cRLSign(6)=0x02
  const ku = ca ? 0x06 : o.kind === "signer" ? 0xc0 : 0x80;
  ext.push(
    new pkijs.Extension({
      extnID: OID.keyUsage,
      critical: true,
      extnValue: new asn1js.BitString({ valueHex: new Uint8Array([ku]).buffer, unusedBits: ca ? 1 : o.kind === "signer" ? 6 : 7 }).toBER(false),
    }),
  );
  if (o.kind === "tsa")
    ext.push(
      new pkijs.Extension({
        extnID: OID.extKeyUsage,
        critical: true,
        extnValue: new pkijs.ExtKeyUsage({ keyPurposes: [OID.timeStamping] }).toSchema().toBER(false),
      }),
    );
  if (o.kind === "signer")
    ext.push(
      new pkijs.Extension({
        extnID: OID.extKeyUsage,
        critical: false,
        extnValue: new pkijs.ExtKeyUsage({ keyPurposes: [OID.documentSigning, OID.emailProtection] }).toSchema().toBER(false),
      }),
    );
  ext.push(new pkijs.Extension({ extnID: OID.subjectKeyId, critical: false, extnValue: new asn1js.OctetString({ valueHex: ab(await keyId(c)) }).toBER(false) }));
  const issuerKeyId = o.issuer ? await keyId(o.issuer.cert) : await keyId(c);
  ext.push(
    new pkijs.Extension({
      extnID: OID.authorityKeyId,
      critical: false,
      extnValue: new pkijs.AuthorityKeyIdentifier({ keyIdentifier: new asn1js.OctetString({ valueHex: ab(issuerKeyId) }) }).toSchema().toBER(false),
    }),
  );
  c.extensions = ext;
  const signingKey = o.issuer ? o.issuer.key : o.selfKey;
  if (!signingKey) throw new Error("A self-signed certificate needs selfKey.");
  await c.sign(signingKey, "SHA-256");
  return certFromDer(certDer(c)); // round-trip so every field is in parsed form
}

export interface RevokedEntry {
  serial: Uint8Array | string; // bytes or hex
  date: Date;
}

/** Issue a CRL (certificate revocation list) signed by a CA. */
export async function issueCrl(o: {
  issuer: { cert: pkijs.Certificate; key: CryptoKey };
  thisUpdate?: Date;
  nextUpdate: Date;
  revoked?: RevokedEntry[];
}): Promise<pkijs.CertificateRevocationList> {
  const crl = new pkijs.CertificateRevocationList();
  crl.version = 1;
  crl.issuer = o.issuer.cert.subject;
  crl.thisUpdate = new pkijs.Time({ type: 0, value: o.thisUpdate ?? new Date(Date.now() - 60_000) });
  crl.nextUpdate = new pkijs.Time({ type: 0, value: o.nextUpdate });
  if (o.revoked?.length)
    crl.revokedCertificates = o.revoked.map((r) => {
      const bytes = typeof r.serial === "string" ? new Uint8Array(r.serial.match(/../g)!.map((h) => parseInt(h, 16))) : r.serial;
      return new pkijs.RevokedCertificate({
        userCertificate: new asn1js.Integer({ valueHex: ab(bytes) }),
        revocationDate: new pkijs.Time({ type: 0, value: r.date }),
      });
    });
  await crl.sign(o.issuer.key, "SHA-256");
  return new pkijs.CertificateRevocationList({ schema: parseDer(u8(crl.toSchema(true).toBER(false))) });
}

export function hasExtKeyUsage(c: pkijs.Certificate, oid: string): boolean {
  const e = c.extensions?.find((x) => x.extnID === OID.extKeyUsage);
  const p = e?.parsedValue as pkijs.ExtKeyUsage | undefined;
  return !!p?.keyPurposes?.includes(oid);
}

export function isCa(c: pkijs.Certificate): boolean {
  const e = c.extensions?.find((x) => x.extnID === OID.basicConstraints);
  return !!(e?.parsedValue as pkijs.BasicConstraints | undefined)?.cA;
}
