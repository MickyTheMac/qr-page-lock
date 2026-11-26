/**
 * Keeps a founder's signing identity in this browser (IndexedDB). The private key is a non-extractable Web Crypto
 * key: pages can use it to sign, but nobody (not even PageLock) can copy it out.
 */
import { allPem, certFingerprint, certFromDer, certFromPem } from "../sign/pki";
import { Identity } from "./client";

const DB = "pagelock";
const STORE = "identities";

interface Stored {
  id: string;
  privateKey: CryptoKey;
  certificatePem: string;
  chainPem: string[];
  serviceUrl: string;
  savedAt: string;
}

function open(): Promise<IDBDatabase> {
  return new Promise((res, rej) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE, { keyPath: "id" });
    r.onsuccess = () => res(r.result);
    r.onerror = () => rej(r.error);
  });
}

function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  return open().then(
    (db) =>
      new Promise<T>((res, rej) => {
        const t = db.transaction(STORE, mode);
        const q = fn(t.objectStore(STORE));
        q.onsuccess = () => res(q.result);
        q.onerror = () => rej(q.error);
      }),
  );
}

export async function saveIdentity(i: Identity): Promise<void> {
  const s: Stored = {
    id: `${i.serviceUrl}|${await certFingerprint(i.certificate)}`,
    privateKey: i.privateKey,
    certificatePem: i.certificatePem,
    chainPem: i.chainPem,
    serviceUrl: i.serviceUrl,
    savedAt: new Date().toISOString(),
  };
  await tx("readwrite", (st) => st.put(s));
}

function revive(s: Stored): Identity & { id: string } {
  return {
    id: s.id,
    certificate: certFromPem(s.certificatePem),
    chain: s.chainPem.flatMap((p) => allPem(p, "CERTIFICATE")).map(certFromDer),
    privateKey: s.privateKey,
    certificatePem: s.certificatePem,
    chainPem: s.chainPem,
    serviceUrl: s.serviceUrl,
  };
}

/** Signing identities saved in this browser for a given service. */
export async function listIdentities(serviceUrl: string): Promise<(Identity & { id: string })[]> {
  try {
    const all = await tx<Stored[]>("readonly", (st) => st.getAll());
    return all.filter((s) => s.serviceUrl === serviceUrl).map(revive);
  } catch {
    return [];
  }
}

export async function forgetIdentity(id: string): Promise<void> {
  await tx("readwrite", (st) => st.delete(id));
}
