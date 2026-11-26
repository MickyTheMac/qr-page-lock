/**
 * What this browser remembers about the vault, and passkeys.
 *
 * "Keep unlocked on this device" stores the root locked by a device key that is NON-EXTRACTABLE: scripts can use it
 * to unlock, but nobody can copy it off the device, and PageLock never sees it. Logging out or "Lock" forgets both.
 */
import { ab, b64decode, b64encode } from "../sign/pki";
import { lockBytes, unlockBytes } from "./crypto";

const DB = "pagelock-vault";
const STORE = "kv";
const TOKEN = "pagelock-vault-token";

function idb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const r = indexedDB.open(DB, 1);
    r.onupgradeneeded = () => r.result.createObjectStore(STORE);
    r.onsuccess = () => resolve(r.result);
    r.onerror = () => reject(r.error);
  });
}

async function tx<T>(mode: IDBTransactionMode, fn: (s: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const db = await idb();
  try {
    return await new Promise<T>((resolve, reject) => {
      const t = db.transaction(STORE, mode);
      const req = fn(t.objectStore(STORE));
      t.oncomplete = () => resolve(req.result);
      t.onerror = () => reject(t.error);
    });
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------- login token

export function savedToken(): string | null {
  try {
    return localStorage.getItem(TOKEN);
  } catch {
    return null;
  }
}

export function saveToken(t: string | null) {
  try {
    if (t) localStorage.setItem(TOKEN, t);
    else localStorage.removeItem(TOKEN);
  } catch {}
}

// ---------------------------------------------------------------- keep unlocked on this device

export async function rememberRoot(root: Uint8Array, keyFp: string): Promise<void> {
  const deviceKey = await crypto.subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt", "decrypt"]);
  const boxed = await lockBytes(deviceKey, root, `PageLock vault device|${keyFp}`);
  await tx("readwrite", (s) => s.put({ deviceKey, boxed, keyFp }, "root"));
}

export async function recallRoot(keyFp: string): Promise<Uint8Array | null> {
  try {
    const v = (await tx("readonly", (s) => s.get("root"))) as { deviceKey: CryptoKey; boxed: Uint8Array; keyFp: string } | undefined;
    if (!v || v.keyFp !== keyFp) return null;
    return await unlockBytes(v.deviceKey, v.boxed, `PageLock vault device|${keyFp}`);
  } catch {
    return null;
  }
}

export async function forgetRoot(): Promise<void> {
  try {
    await tx("readwrite", (s) => s.delete("root"));
  } catch {}
}

// ---------------------------------------------------------------- passkeys (WebAuthn with the PRF extension)

const b64url = (b: Uint8Array) => b64encode(b).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const fromB64url = (s: string) => b64decode(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
const rnd = (n: number) => crypto.getRandomValues(new Uint8Array(n));

export function passkeysAvailable(): boolean {
  return typeof window !== "undefined" && !!window.PublicKeyCredential && !!navigator.credentials;
}

type PrfResults = { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };

/**
 * Makes a new passkey and gets its secret. Returns null if this device's passkeys cannot give a secret (no PRF
 * support), in which case recovery words remain the way to unlock on other devices.
 */
export async function createPasskey(): Promise<{ id: string; salt: Uint8Array; prf: Uint8Array } | null> {
  const salt = rnd(32);
  const cred = (await navigator.credentials.create({
    publicKey: {
      rp: { name: "PageLock", id: location.hostname },
      user: { id: ab(rnd(16)), name: "PageLock vault", displayName: "PageLock vault" },
      challenge: ab(rnd(32)),
      pubKeyCredParams: [
        { type: "public-key", alg: -7 },
        { type: "public-key", alg: -257 },
      ],
      authenticatorSelection: { residentKey: "required", userVerification: "required" },
      extensions: { prf: { eval: { first: ab(salt) } } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const id = b64url(new Uint8Array(cred.rawId));
  const ext = cred.getClientExtensionResults() as PrfResults;
  if (ext.prf?.results?.first) return { id, salt, prf: new Uint8Array(ext.prf.results.first) };
  if (ext.prf?.enabled === false) return null;
  // Some browsers only give the secret when the passkey is used, not when it is made.
  const got = await askPasskey([{ id, salt: b64encode(salt) }]);
  return got ? { id, salt, prf: got.prf } : null;
}

/** Asks for one of these passkeys and returns which one was used and its secret. */
export async function askPasskey(passkeys: { id: string; salt: string }[]): Promise<{ id: string; prf: Uint8Array } | null> {
  const evalByCredential: Record<string, { first: ArrayBuffer }> = {};
  for (const p of passkeys) evalByCredential[p.id] = { first: ab(b64decode(p.salt)) };
  const cred = (await navigator.credentials.get({
    publicKey: {
      challenge: ab(rnd(32)),
      rpId: location.hostname,
      allowCredentials: passkeys.map((p) => ({ type: "public-key" as const, id: ab(fromB64url(p.id)) })),
      userVerification: "required",
      extensions: { prf: { evalByCredential } } as AuthenticationExtensionsClientInputs,
    },
  })) as PublicKeyCredential | null;
  if (!cred) return null;
  const first = (cred.getClientExtensionResults() as PrfResults).prf?.results?.first;
  if (!first) return null;
  return { id: b64url(new Uint8Array(cred.rawId)), prf: new Uint8Array(first) };
}
