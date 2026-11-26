/**
 * The PageLock service: a small server that
 *  1. issues each founder a PageLock signing certificate after an email check (their key never leaves their device),
 *  2. publishes the trust file (authority certificate + current revocation list),
 *  3. runs an RFC 3161 timestamp service (only hashes are sent to it),
 *  4. keeps the private, append-only sign-off log, with a public "fingerprint + sign-off time" lookup.
 *
 * It uses only standard Web APIs (Request/Response, Web Crypto), so the same code runs in Node (server/main.ts),
 * in serverless hosts, and inside the browser for the offline try-out.
 */
import * as pkijs from "pkijs";
import { canonicalJson, utf8 } from "../encoding";
import { sha256Hex } from "../crypto";
import { TsaIdentity, answerTimestampRequest, issueTimestampToken } from "../sign/cms";
import {
  EC_ALG,
  ab,
  b64decode,
  b64encode,
  certFingerprint,
  certFromPem,
  certPem,
  crlPem,
  exportPrivateKeyPem,
  fromPem,
  generateKeyPair,
  importPrivateKeyPkcs8,
  issueCertificate,
  issueCrl,
  serialHex,
  subtle,
  u8,
} from "../sign/pki";
import { TrustFile } from "../sign/trust";
import { GENESIS, LogEntry, SignOffSubmission, computeEntryHash, signBytes, verifyBytes } from "./log";

export interface ServiceStore {
  get<T>(key: string): Promise<T | null>;
  put<T>(key: string, value: T): Promise<void>;
  appendLog(entry: LogEntry): Promise<void>;
  readLog(): Promise<LogEntry[]>;
}

export class MemoryStore implements ServiceStore {
  private kv = new Map<string, string>();
  private log: LogEntry[] = [];
  async get<T>(k: string) {
    const v = this.kv.get(k);
    return v === undefined ? null : (JSON.parse(v) as T);
  }
  async put<T>(k: string, v: T) {
    this.kv.set(k, JSON.stringify(v));
  }
  async appendLog(e: LogEntry) {
    this.log.push(JSON.parse(JSON.stringify(e)));
  }
  async readLog() {
    return this.log.map((e) => JSON.parse(JSON.stringify(e)) as LogEntry);
  }
}

export interface Mailer {
  send(to: string, subject: string, text: string): Promise<void>;
}

export interface ServiceConfig {
  store: ServiceStore;
  mailer: Mailer;
  /** Name shown in certificates, e.g. "PageLock". */
  authorityName?: string;
  /** Token for admin actions (revoking a certificate). Unset = admin API disabled. */
  adminToken?: string;
  /** DEMO ONLY: return the email code in the API response (for the offline try-out). */
  exposeCodes?: boolean;
  allowedOrigin?: string;
  requiredSigners?: number;
  /** Marks the trust file as DEMO (for the in-browser try-out, whose keys live in the browser). */
  demo?: boolean;
  now?: () => Date;
}

interface StoredKeys {
  caCert: string;
  caKey: string;
  tsaCert: string;
  tsaKey: string;
  logKey: string; // PKCS#8
  logPublic: string; // SPKI base64
}

interface Enrolment {
  id: string;
  name: string;
  email: string;
  publicKey: string;
  codeHash: string;
  expires: number;
  attempts: number;
  done: boolean;
}

interface IssuedCert {
  serial: string;
  sha256: string;
  name: string;
  email: string;
  issuedAt: string;
  revokedAt?: string;
}

const NAME_RE = /^[\p{L}\p{M}' .-]{1,80}$/u;
const EMAIL_RE = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,190}\.[A-Za-z]{2,}$/;
const DIGEST_RE = /^[0-9A-F]{64}$/;

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

function randomId(bytes = 16): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");
}

function sixDigits(): string {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return String(b[0] % 1_000_000).padStart(6, "0");
}

export class PageLockService {
  private keys!: {
    ca: { cert: pkijs.Certificate; key: CryptoKey };
    tsa: TsaIdentity;
    log: CryptoKey;
    logPublic: string;
  };
  private lock: Promise<unknown> = Promise.resolve();
  private now: () => Date;

  private constructor(private cfg: ServiceConfig) {
    this.now = cfg.now ?? (() => new Date());
  }

  static async create(cfg: ServiceConfig): Promise<PageLockService> {
    const s = new PageLockService(cfg);
    await s.loadOrCreateKeys();
    return s;
  }

  private async loadOrCreateKeys() {
    let k = await this.cfg.store.get<StoredKeys>("keys");
    if (!k) {
      const name = this.cfg.authorityName ?? "PageLock";
      const ca = await generateKeyPair(true);
      const caCert = await issueCertificate({
        kind: "ca",
        subject: { cn: `${name} Founders Authority`, o: name },
        publicKey: ca.publicKey,
        selfKey: ca.privateKey,
        notAfter: new Date(Date.now() + 10 * 365 * 86400_000),
      });
      const tsa = await generateKeyPair(true);
      const tsaCert = await issueCertificate({
        kind: "tsa",
        subject: { cn: `${name} Timestamp Service`, o: name },
        publicKey: tsa.publicKey,
        issuer: { cert: caCert, key: ca.privateKey },
        notAfter: new Date(Date.now() + 10 * 365 * 86400_000),
      });
      const log = await generateKeyPair(true);
      k = {
        caCert: certPem(caCert),
        caKey: await exportPrivateKeyPem(ca.privateKey),
        tsaCert: certPem(tsaCert),
        tsaKey: await exportPrivateKeyPem(tsa.privateKey),
        logKey: await exportPrivateKeyPem(log.privateKey),
        logPublic: b64encode(u8(await subtle().exportKey("spki", log.publicKey))),
      };
      await this.cfg.store.put("keys", k);
    }
    const caCert = certFromPem(k.caCert);
    this.keys = {
      ca: { cert: caCert, key: await importPrivateKeyPkcs8(fromPem(k.caKey)) },
      tsa: { certificate: certFromPem(k.tsaCert), chain: [caCert], privateKey: await importPrivateKeyPkcs8(fromPem(k.tsaKey)) },
      log: await importPrivateKeyPkcs8(fromPem(k.logKey)),
      logPublic: k.logPublic,
    };
  }

  /** Serialises writes so the hash chain never forks. */
  private exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.lock.then(fn, fn);
    this.lock = run.catch(() => undefined);
    return run;
  }

  get authorityCertificate() {
    return this.keys.ca.cert;
  }
  get logPublicKeyB64() {
    return this.keys.logPublic;
  }
  async logPublicKey(): Promise<CryptoKey> {
    return subtle().importKey("spki", ab(b64decode(this.keys.logPublic)), EC_ALG, false, ["verify"]);
  }

  // ------------------------------------------------------------------ certificates

  async startEnrolment(body: { name?: string; email?: string; publicKey?: string; proof?: string }) {
    const name = String(body.name ?? "").trim();
    const email = String(body.email ?? "").trim().toLowerCase();
    if (!NAME_RE.test(name)) throw new HttpError(400, "Please give your name (letters, spaces, apostrophes and hyphens only).");
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Please give a valid email address.");
    let pub: CryptoKey;
    try {
      pub = await subtle().importKey("spki", ab(b64decode(String(body.publicKey))), EC_ALG, true, ["verify"]);
    } catch {
      throw new HttpError(400, "The signing key is not a P-256 public key.");
    }
    const proofInput = utf8(canonicalJson({ purpose: "pagelock-enrol", name, email, publicKey: body.publicKey }));
    if (!(await verifyBytes(pub, proofInput, String(body.proof ?? "")))) throw new HttpError(400, "Proof of key possession failed.");
    const code = sixDigits();
    const e: Enrolment = {
      id: randomId(),
      name,
      email,
      publicKey: String(body.publicKey),
      codeHash: await sha256Hex(utf8(code)),
      expires: this.now().getTime() + 15 * 60_000,
      attempts: 0,
      done: false,
    };
    await this.cfg.store.put(`enrol:${e.id}`, e);
    await this.cfg.mailer.send(
      email,
      "Your PageLock signing code",
      `Your PageLock code is ${code}. It expires in 15 minutes. If you did not ask for a PageLock signing certificate, ignore this email.`,
    );
    return { enrolmentId: e.id, ...(this.cfg.exposeCodes ? { demoCode: code } : {}) };
  }

  async finishEnrolment(body: { enrolmentId?: string; code?: string }) {
    const id = String(body.enrolmentId ?? "");
    if (!/^[0-9a-f]{32}$/.test(id)) throw new HttpError(400, "Unknown request.");
    return this.exclusive(async () => {
      const e = await this.cfg.store.get<Enrolment>(`enrol:${id}`);
      if (!e || e.done) throw new HttpError(400, "Unknown or finished request. Start again.");
      if (e.expires < this.now().getTime()) throw new HttpError(400, "The code has expired. Start again.");
      if (e.attempts >= 5) throw new HttpError(429, "Too many wrong codes. Start again.");
      if ((await sha256Hex(utf8(String(body.code ?? "").trim()))) !== e.codeHash) {
        e.attempts++;
        await this.cfg.store.put(`enrol:${id}`, e);
        throw new HttpError(400, "That code is not right.");
      }
      e.done = true;
      await this.cfg.store.put(`enrol:${id}`, e);
      const pub = await subtle().importKey("spki", ab(b64decode(e.publicKey)), EC_ALG, true, ["verify"]);
      const cert = await issueCertificate({
        kind: "signer",
        subject: { cn: e.name, email: e.email, o: this.cfg.authorityName ?? "PageLock" },
        publicKey: pub,
        issuer: this.keys.ca,
      });
      const issued: IssuedCert = { serial: serialHex(cert), sha256: await certFingerprint(cert), name: e.name, email: e.email, issuedAt: this.now().toISOString() };
      const reg = (await this.cfg.store.get<IssuedCert[]>("certs")) ?? [];
      reg.push(issued);
      await this.cfg.store.put("certs", reg);
      return { certificate: certPem(cert), chain: [certPem(this.keys.ca.cert)] };
    });
  }

  async revoke(serial: string) {
    return this.exclusive(async () => {
      const reg = (await this.cfg.store.get<IssuedCert[]>("certs")) ?? [];
      const c = reg.find((x) => x.serial === serial.toUpperCase());
      if (!c) throw new HttpError(404, "No such certificate.");
      c.revokedAt ??= this.now().toISOString();
      await this.cfg.store.put("certs", reg);
      return { revoked: c.serial, at: c.revokedAt };
    });
  }

  async currentCrl(): Promise<pkijs.CertificateRevocationList> {
    const reg = (await this.cfg.store.get<IssuedCert[]>("certs")) ?? [];
    const now = this.now();
    return issueCrl({
      issuer: this.keys.ca,
      thisUpdate: new Date(now.getTime() - 60_000),
      nextUpdate: new Date(now.getTime() + 7 * 86400_000),
      revoked: reg.filter((c) => c.revokedAt).map((c) => ({ serial: c.serial, date: new Date(c.revokedAt!) })),
    });
  }

  async trustFile(): Promise<TrustFile> {
    return {
      pagelockTrust: 1,
      name: `${this.cfg.authorityName ?? "PageLock"} Founders Authority`,
      demo: this.cfg.demo || undefined,
      signerAuthorities: [certPem(this.keys.ca.cert)],
      timestampAuthorities: [certPem(this.keys.ca.cert)],
      revocationLists: [crlPem(await this.currentCrl())],
      requiredSigners: this.cfg.requiredSigners ?? 2,
      requireTimestamp: true,
    };
  }

  private async registered(cert: pkijs.Certificate): Promise<IssuedCert> {
    const fp = await certFingerprint(cert);
    const reg = (await this.cfg.store.get<IssuedCert[]>("certs")) ?? [];
    const c = reg.find((x) => x.sha256 === fp);
    if (!c) throw new HttpError(403, "This certificate was not issued by this PageLock service.");
    if (c.revokedAt) throw new HttpError(403, "This certificate has been revoked.");
    const now = this.now();
    if (cert.notBefore.value > now || cert.notAfter.value < now) throw new HttpError(403, "This certificate is not currently valid.");
    return c;
  }

  // ------------------------------------------------------------------ sign-off log

  async timestamp(reqDer: Uint8Array): Promise<Uint8Array> {
    try {
      return await answerTimestampRequest(reqDer, this.keys.tsa);
    } catch (e) {
      throw new HttpError(400, e instanceof Error ? e.message : "Bad timestamp request.");
    }
  }

  async recordSignOff(sub: SignOffSubmission): Promise<{ entry: LogEntry; complete: boolean; signedOffAt: string | null }> {
    const st = sub?.statement;
    if (!st || st.type !== "pagelock-signoff" || st.version !== 1) throw new HttpError(400, "Not a PageLock sign-off.");
    if (!DIGEST_RE.test(st.manifestDigest) || !DIGEST_RE.test(st.signedPdfSha256) || !/^[0-9A-Z]{24}$/.test(st.documentId))
      throw new HttpError(400, "Malformed document details.");
    if (!Number.isSafeInteger(st.pageCount) || st.pageCount < 1) throw new HttpError(400, "Malformed page count.");
    let cert: pkijs.Certificate;
    try {
      cert = certFromPem(sub.certificate);
    } catch {
      throw new HttpError(400, "Damaged certificate.");
    }
    if (!(await cert.verify(this.keys.ca.cert))) throw new HttpError(403, "This certificate was not issued by this PageLock service.");
    await this.registered(cert);
    if ((await certFingerprint(cert)) !== st.signerCertSha256) throw new HttpError(400, "The statement names a different certificate.");
    if (!(await verifyBytes(cert, utf8(canonicalJson(st)), sub.signature))) throw new HttpError(400, "The founder's signature on the sign-off is invalid.");
    const skew = Math.abs(new Date(st.statedAt).getTime() - this.now().getTime());
    if (!(skew < 10 * 60_000)) throw new HttpError(400, "The sign-off time is too far from the server's clock.");

    return this.exclusive(async () => {
      const log = await this.cfg.store.readLog();
      const mine = log.filter((e) => e.submission.statement.manifestDigest === st.manifestDigest);
      const required = this.cfg.requiredSigners ?? 2;
      if (mine.length >= required) throw new HttpError(409, "This document has already been signed off by all founders.");
      if (mine.some((e) => e.submission.statement.signerCertSha256 === st.signerCertSha256)) throw new HttpError(409, "You have already signed off this document.");
      const last = mine[mine.length - 1];
      if ((last?.entryHash ?? null) !== st.counterSigns)
        throw new HttpError(409, last ? "Your sign-off must countersign the other founder's entry." : "There is no earlier sign-off to countersign.");
      if (last && (last.submission.statement.documentId !== st.documentId || last.submission.statement.pageCount !== st.pageCount))
        throw new HttpError(409, "The document details differ from the earlier sign-off.");
      const prev = log[log.length - 1];
      const base = { seq: log.length + 1, prevEntryHash: prev?.entryHash ?? GENESIS, receivedAt: this.now().toISOString(), submission: sub };
      const entryHash = await computeEntryHash(base);
      const hashBytes = new Uint8Array(entryHash.match(/../g)!.map((h) => parseInt(h, 16)));
      const entry: LogEntry = {
        ...base,
        entryHash,
        serverSignature: await signBytes(this.keys.log, utf8(entryHash)),
        timestampToken: b64encode(await issueTimestampToken(hashBytes, this.keys.tsa)),
      };
      await this.cfg.store.appendLog(entry);
      const complete = mine.length + 1 >= required;
      return { entry, complete, signedOffAt: complete ? entry.receivedAt : null };
    });
  }

  /** Private view: only a founder who has an entry for this document may read its log. */
  async readSignOff(manifestDigest: string, auth: string | null) {
    if (!DIGEST_RE.test(manifestDigest)) throw new HttpError(400, "Malformed fingerprint.");
    if (!auth?.startsWith("PageLock-Sig ")) throw new HttpError(401, "Sign in with your PageLock certificate to read this log.");
    let a: { manifestDigest: string; at: string; certificate: string; signature: string };
    try {
      a = JSON.parse(new TextDecoder().decode(b64decode(auth.slice(13))));
    } catch {
      throw new HttpError(401, "Malformed credentials.");
    }
    const cert = certFromPem(a.certificate);
    if (!(await cert.verify(this.keys.ca.cert))) throw new HttpError(403, "Unknown certificate.");
    await this.registered(cert);
    const fresh = Math.abs(new Date(a.at).getTime() - this.now().getTime()) < 5 * 60_000;
    const ok = fresh && a.manifestDigest === manifestDigest && (await verifyBytes(cert, readAuthInput(manifestDigest, a.at), a.signature));
    if (!ok) throw new HttpError(401, "Credentials are invalid or expired.");
    const fp = await certFingerprint(cert);
    const log = await this.cfg.store.readLog();
    const mine = log.filter((e) => e.submission.statement.manifestDigest === manifestDigest);
    if (mine.some((e) => e.submission.statement.signerCertSha256 === fp)) return { entries: mine, logPublicKey: this.keys.logPublic, pendingCountersign: null };
    // Not (yet) a participant: reveal only what is needed to countersign, never who signed.
    if (mine.length && mine.length < (this.cfg.requiredSigners ?? 2))
      return { entries: [], logPublicKey: this.keys.logPublic, pendingCountersign: mine[mine.length - 1].entryHash };
    if (!mine.length) return { entries: [], logPublicKey: this.keys.logPublic, pendingCountersign: null };
    throw new HttpError(403, "Only the founders who signed off can read this log.");
  }

  async publicStatus(manifestDigest: string) {
    if (!DIGEST_RE.test(manifestDigest)) throw new HttpError(400, "Malformed fingerprint.");
    const log = await this.cfg.store.readLog();
    const mine = log.filter((e) => e.submission.statement.manifestDigest === manifestDigest);
    const required = this.cfg.requiredSigners ?? 2;
    if (mine.length < required) throw new HttpError(404, "No completed sign-off for this fingerprint.");
    return { manifestDigest, signedOff: true, signedOffAt: mine[required - 1].receivedAt };
  }

  async head() {
    const log = await this.cfg.store.readLog();
    const last = log[log.length - 1];
    return { size: log.length, headHash: last?.entryHash ?? GENESIS, serverSignature: last?.serverSignature ?? null };
  }

  // ------------------------------------------------------------------ HTTP

  async handle(req: Request): Promise<Response> {
    const origin = this.cfg.allowedOrigin ?? "*";
    const cors = {
      "Access-Control-Allow-Origin": origin,
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type, Authorization",
      "Access-Control-Max-Age": "600",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    };
    const json = (status: number, body: unknown) =>
      new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    const body = async () => {
      const t = await req.text();
      if (t.length > 64 * 1024) throw new HttpError(413, "Request too large.");
      try {
        return JSON.parse(t);
      } catch {
        throw new HttpError(400, "Expected JSON.");
      }
    };
    try {
      if (req.method === "GET" && path === "/api/health") return json(200, { ok: true });
      if (req.method === "GET" && path === "/api/trust") return json(200, await this.trustFile());
      if (req.method === "GET" && path === "/api/crl")
        return new Response(crlPem(await this.currentCrl()), { headers: { ...cors, "Content-Type": "application/x-pem-file" } });
      if (req.method === "GET" && path === "/api/log-key") return json(200, { logPublicKey: this.keys.logPublic });
      if (req.method === "GET" && path === "/api/head") return json(200, await this.head());
      if (req.method === "POST" && path === "/api/enrol/start") return json(200, await this.startEnrolment(await body()));
      if (req.method === "POST" && path === "/api/enrol/finish") return json(200, await this.finishEnrolment(await body()));
      if (req.method === "POST" && path === "/api/timestamp") {
        const der = new Uint8Array(await req.arrayBuffer());
        if (der.length > 4096) throw new HttpError(413, "Request too large.");
        return new Response(ab(await this.timestamp(der)), { headers: { ...cors, "Content-Type": "application/timestamp-reply" } });
      }
      if (req.method === "POST" && path === "/api/signoff") return json(200, await this.recordSignOff(await body()));
      let m = path.match(/^\/api\/signoff\/([0-9A-F]{64})$/);
      if (req.method === "GET" && m) return json(200, await this.readSignOff(m[1], req.headers.get("Authorization")));
      m = path.match(/^\/api\/public\/([0-9A-F]{64})$/);
      if (req.method === "GET" && m) return json(200, await this.publicStatus(m[1]));
      if (req.method === "POST" && path === "/api/admin/revoke") {
        if (!this.cfg.adminToken || req.headers.get("Authorization") !== `Bearer ${this.cfg.adminToken}`) throw new HttpError(401, "Not allowed.");
        return json(200, await this.revoke(String((await body()).serial ?? "")));
      }
      return json(404, { error: "Not found." });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      return json(500, { error: "Something went wrong." });
    }
  }
}

export function readAuthInput(manifestDigest: string, at: string): Uint8Array {
  return utf8(canonicalJson({ purpose: "pagelock-read-log", manifestDigest, at }));
}
