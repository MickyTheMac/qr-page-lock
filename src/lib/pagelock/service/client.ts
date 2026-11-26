/** Browser-side client for the PageLock service. The founder's private key never leaves this device. */
import { canonicalJson, utf8 } from "../encoding";
import { CmsSigner, TimestampSource, httpTimestampSource } from "../sign/cms";
import { allPem, b64encode, certFromDer, certFromPem, certPem, generateKeyPair, subtle, u8 } from "../sign/pki";
import { TrustProfile, parseTrustFile } from "../sign/trust";
import { LogEntry, SignOffSubmission, signBytes } from "./log";
import { readAuthInput } from "./service";

export interface Identity extends CmsSigner {
  certificatePem: string;
  chainPem: string[];
  serviceUrl: string;
}

export class ServiceError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class PageLockClient {
  constructor(
    public baseUrl: string,
    private fetchImpl: typeof fetch = (...a) => fetch(...a),
  ) {
    this.baseUrl = baseUrl.replace(/\/+$/, "");
  }

  private async call<T>(path: string, init?: RequestInit): Promise<T> {
    let r: Response;
    try {
      r = await this.fetchImpl(this.baseUrl + path, init);
    } catch {
      throw new ServiceError(0, "Could not reach the PageLock service. Check your connection and try again.");
    }
    const text = await r.text();
    let j: unknown = null;
    try {
      j = JSON.parse(text);
    } catch {
      /* not JSON */
    }
    if (!r.ok) throw new ServiceError(r.status, (j as { error?: string } | null)?.error ?? `The service answered ${r.status}.`);
    return j as T;
  }

  private post<T>(path: string, body: unknown, headers: Record<string, string> = {}) {
    return this.call<T>(path, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  }

  /** Step 1: make a key on this device and ask for an email code. */
  async startEnrolment(name: string, email: string, keyPair?: CryptoKeyPair) {
    const keys = keyPair ?? (await generateKeyPair(false));
    const publicKey = b64encode(u8(await subtle().exportKey("spki", keys.publicKey)));
    const n = name.trim();
    const e = email.trim().toLowerCase();
    const proof = await signBytes(keys.privateKey, utf8(canonicalJson({ purpose: "pagelock-enrol", name: n, email: e, publicKey })));
    const r = await this.post<{ enrolmentId: string; demoCode?: string }>("/api/enrol/start", { name: n, email: e, publicKey, proof });
    return { ...r, keys };
  }

  /** Step 2: send the code back and receive the certificate. */
  async finishEnrolment(enrolmentId: string, code: string, keys: CryptoKeyPair): Promise<Identity> {
    const r = await this.post<{ certificate: string; chain: string[] }>("/api/enrol/finish", { enrolmentId, code });
    const certificate = certFromPem(r.certificate);
    const chain = r.chain.flatMap((p) => allPem(p, "CERTIFICATE")).map(certFromDer);
    return { certificate, chain, privateKey: keys.privateKey, certificatePem: r.certificate, chainPem: r.chain, serviceUrl: this.baseUrl };
  }

  async trust(): Promise<TrustProfile> {
    const r = await this.call<unknown>("/api/trust");
    return parseTrustFile(JSON.stringify(r));
  }

  timestampSource(): TimestampSource {
    return httpTimestampSource(this.baseUrl + "/api/timestamp", this.fetchImpl);
  }

  async readSignOff(manifestDigest: string, id: { certificate: CmsSigner["certificate"]; privateKey: CryptoKey }) {
    const at = new Date().toISOString();
    const signature = await signBytes(id.privateKey, readAuthInput(manifestDigest, at));
    const auth = b64encode(utf8(JSON.stringify({ manifestDigest, at, certificate: certPem(id.certificate), signature })));
    return this.call<{ entries: LogEntry[]; logPublicKey: string; pendingCountersign: string | null }>(`/api/signoff/${manifestDigest}`, {
      headers: { Authorization: `PageLock-Sig ${auth}` },
    });
  }

  recordSignOff(sub: SignOffSubmission) {
    return this.post<{ entry: LogEntry; complete: boolean; signedOffAt: string | null }>("/api/signoff", sub);
  }

  async publicStatus(manifestDigest: string): Promise<{ signedOff: boolean; signedOffAt: string | null }> {
    try {
      const r = await this.call<{ signedOffAt: string }>(`/api/public/${manifestDigest}`);
      return { signedOff: true, signedOffAt: r.signedOffAt };
    } catch (e) {
      if (e instanceof ServiceError && e.status === 404) return { signedOff: false, signedOffAt: null };
      throw e;
    }
  }
}

/** A fetch that answers from an in-page service (offline try-out). */
export function inPageFetch(service: { handle(r: Request): Promise<Response> }): typeof fetch {
  return async (input, init) => service.handle(new Request(input instanceof Request ? input : String(input), init));
}
