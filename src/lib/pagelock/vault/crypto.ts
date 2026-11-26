/**
 * PageLock vault: the locking and unlocking, all done on the signer's own device.
 *
 *  - Every person has one secret "root": 32 random bytes, shown once as 24 recovery words.
 *  - From the root we derive their padlock key pair: X-Wing, a hybrid of X25519 and ML-KEM-768 (the
 *    post-quantum standard), so a recording of today's uploads cannot be opened by a future quantum computer.
 *  - Every saved document gets its own random 256-bit key. The file and its details are locked with AES-256-GCM.
 *  - That document key is then locked ("wrapped") once for each signer's padlock.
 *
 * The server only ever receives: padlocks (public keys), locked files, locked details and wrapped keys.
 * Nothing here is ever sent to the server in readable form.
 */
import { ml_kem768_x25519 as xwing } from "@noble/post-quantum/hybrid.js";
import { entropyToMnemonic, mnemonicToEntropy, validateMnemonic } from "@scure/bip39";
import { wordlist } from "@scure/bip39/wordlists/english.js";
import { concatBytes, toHex as upperHex, utf8 } from "../encoding";

const toHex = (b: Uint8Array) => upperHex(b).toLowerCase();
import { ab, subtle } from "../sign/pki";

export const VAULT_VERSION = 1;
const NONCE = 12;

export interface VaultIdentity {
  publicKey: Uint8Array; // 1216 bytes
  secretKey: Uint8Array; // 32 bytes (X-Wing seed form)
  keyFp: string; // SHA-256 of the public key, hex
}

/** The details kept (locked) beside each document. Readable only by its signers. */
export interface VaultMeta {
  v: 1;
  name: string;
  size: number;
  documentId: string | null;
  manifestDigest: string | null;
  savedAt: string;
  /** Set for a sealed photo (a PNG), with its seal fingerprint. Absent for sealed PDFs. */
  kind?: "photo";
  photoSealDigest?: string;
}

function random(n: number): Uint8Array {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return b;
}

export async function sha256(data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await subtle().digest("SHA-256", ab(data)));
}

async function hkdf(secret: Uint8Array, info: string, length = 32): Promise<Uint8Array> {
  const k = await subtle().importKey("raw", ab(secret), "HKDF", false, ["deriveBits"]);
  const bits = await subtle().deriveBits({ name: "HKDF", hash: "SHA-256", salt: new Uint8Array(32), info: ab(utf8(info)) }, k, length * 8);
  return new Uint8Array(bits);
}

async function aesKey(raw: Uint8Array): Promise<CryptoKey> {
  if (raw.length !== 32) throw new Error("Expected a 256-bit key.");
  return subtle().importKey("raw", ab(raw), "AES-GCM", false, ["encrypt", "decrypt"]);
}

/** AES-256-GCM. Output = 12-byte nonce || ciphertext+tag. `aad` binds the box to where it belongs. */
export async function lockBytes(key: Uint8Array | CryptoKey, plain: Uint8Array, aad: string): Promise<Uint8Array> {
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  const iv = random(NONCE);
  const ct = new Uint8Array(await subtle().encrypt({ name: "AES-GCM", iv: ab(iv), additionalData: ab(utf8(aad)) }, k, ab(plain)));
  return concatBytes([iv, ct]);
}

export async function unlockBytes(key: Uint8Array | CryptoKey, boxed: Uint8Array, aad: string): Promise<Uint8Array> {
  if (boxed.length < NONCE + 16) throw new VaultCryptoError("This locked box is damaged.");
  const k = key instanceof Uint8Array ? await aesKey(key) : key;
  try {
    return new Uint8Array(
      await subtle().decrypt({ name: "AES-GCM", iv: ab(boxed.subarray(0, NONCE)), additionalData: ab(utf8(aad)) }, k, ab(boxed.subarray(NONCE))),
    );
  } catch {
    throw new VaultCryptoError("This could not be unlocked with your key. It may belong to someone else, or have been changed.");
  }
}

export class VaultCryptoError extends Error {}

// ------------------------------------------------------------------ root and recovery words

export function newRoot(): Uint8Array {
  return random(32);
}

export function rootToWords(root: Uint8Array): string[] {
  if (root.length !== 32) throw new Error("A root is 32 bytes.");
  return entropyToMnemonic(root, wordlist).split(" ");
}

/** Accepts the 24 words typed in any case, with any spacing. Throws if a word is wrong or missing. */
export function wordsToRoot(text: string): Uint8Array {
  const words = text.toLowerCase().trim().split(/[\s,.;]+/).filter(Boolean);
  if (words.length !== 24) throw new VaultCryptoError(`Please enter all 24 words (you entered ${words.length}).`);
  const unknown = words.find((w) => !wordlist.includes(w));
  if (unknown) throw new VaultCryptoError(`"${unknown}" is not one of the recovery words. Please check its spelling.`);
  const phrase = words.join(" ");
  if (!validateMnemonic(phrase, wordlist)) throw new VaultCryptoError("These words do not fit together. Please check their order and spelling.");
  return mnemonicToEntropy(phrase, wordlist);
}

export async function deriveIdentity(root: Uint8Array): Promise<VaultIdentity> {
  const seed = await hkdf(root, "PageLock vault identity v1 (X-Wing)");
  const { publicKey, secretKey } = xwing.keygen(seed);
  return { publicKey, secretKey, keyFp: toHex(await sha256(publicKey)) };
}

export async function keyFingerprint(publicKey: Uint8Array): Promise<string> {
  return toHex(await sha256(publicKey));
}

/**
 * A 20-digit code both people see for the pair of padlocks. If the codes on both screens match, nobody
 * (not even the PageLock server) swapped in a fake padlock between them.
 */
export async function safetyCode(pubA: Uint8Array, pubB: Uint8Array): Promise<string> {
  const [a, b] = [toHex(pubA), toHex(pubB)].sort();
  const h = await sha256(utf8(`PageLock safety code v1|${a}|${b}`));
  const groups: string[] = [];
  for (let i = 0; i < 5; i++) {
    const n = ((h[i * 4] << 24) | (h[i * 4 + 1] << 16) | (h[i * 4 + 2] << 8) | h[i * 4 + 3]) >>> 0;
    groups.push(String(n % 10000).padStart(4, "0"));
  }
  return groups.join(" ");
}

// ------------------------------------------------------------------ documents

export function newDocKey(): Uint8Array {
  return random(32);
}

export function newVaultDocId(): string {
  return toHex(random(16));
}

const fileAad = (docId: string) => `PageLock vault v1|file|${docId}`;
const metaAad = (docId: string) => `PageLock vault v1|meta|${docId}`;
const labelAad = (docId: string) => `PageLock vault v1|label|${docId}`;

export async function lockDocument(docId: string, key: Uint8Array, file: Uint8Array, meta: VaultMeta) {
  return {
    file: await lockBytes(key, file, fileAad(docId)),
    meta: await lockBytes(key, utf8(JSON.stringify(meta)), metaAad(docId)),
  };
}

export async function unlockFile(docId: string, key: Uint8Array, boxed: Uint8Array): Promise<Uint8Array> {
  return unlockBytes(key, boxed, fileAad(docId));
}

export async function unlockMeta(docId: string, key: Uint8Array, boxed: Uint8Array): Promise<VaultMeta> {
  const m = JSON.parse(new TextDecoder().decode(await unlockBytes(key, boxed, metaAad(docId))));
  if (m?.v !== 1 || typeof m.name !== "string") throw new VaultCryptoError("Unknown document details format.");
  return m as VaultMeta;
}

/** A short note about a member (e.g. the email it was shared with), readable only by the document's signers. */
export async function lockLabel(docId: string, key: Uint8Array, text: string): Promise<Uint8Array> {
  return lockBytes(key, utf8(text.slice(0, 200)), labelAad(docId));
}

export async function unlockLabel(docId: string, key: Uint8Array, boxed: Uint8Array): Promise<string> {
  return new TextDecoder().decode(await unlockBytes(key, boxed, labelAad(docId)));
}

// ------------------------------------------------------------------ wrapping a document key for a padlock

const wrapInfo = (docId: string, keyFp: string) => `PageLock vault v1|wrap|${docId}|${keyFp}`;

/** Locks the document key so only the holder of `recipientPub` can open it. Output = KEM ciphertext || AES-GCM box. */
export async function wrapDocKey(docId: string, docKey: Uint8Array, recipientPub: Uint8Array): Promise<{ wrap: Uint8Array; wrapFor: string }> {
  if (recipientPub.length !== xwing.lengths.publicKey) throw new VaultCryptoError("That padlock is not the right size.");
  const keyFp = await keyFingerprint(recipientPub);
  const { cipherText, sharedSecret } = xwing.encapsulate(recipientPub);
  const kek = await hkdf(sharedSecret, wrapInfo(docId, keyFp));
  return { wrap: concatBytes([cipherText, await lockBytes(kek, docKey, wrapInfo(docId, keyFp))]), wrapFor: keyFp };
}

export async function unwrapDocKey(docId: string, wrap: Uint8Array, me: VaultIdentity): Promise<Uint8Array> {
  const ctLen = xwing.lengths.cipherText!;
  if (wrap.length < ctLen + NONCE + 16) throw new VaultCryptoError("This document key is damaged.");
  const shared = xwing.decapsulate(wrap.subarray(0, ctLen), me.secretKey);
  const kek = await hkdf(shared, wrapInfo(docId, me.keyFp));
  const key = await unlockBytes(kek, wrap.subarray(ctLen), wrapInfo(docId, me.keyFp));
  if (key.length !== 32) throw new VaultCryptoError("This document key is damaged.");
  return key;
}

// ------------------------------------------------------------------ passkey backup of the root

/** Locks the root with the secret a passkey gives back (WebAuthn PRF). The server keeps this box but cannot open it. */
export async function lockRootWithPasskey(root: Uint8Array, prfOutput: Uint8Array, keyFp: string): Promise<Uint8Array> {
  return lockBytes(await hkdf(prfOutput, "PageLock vault passkey v1"), root, `PageLock vault v1|root|${keyFp}`);
}

export async function unlockRootWithPasskey(boxed: Uint8Array, prfOutput: Uint8Array, keyFp: string): Promise<Uint8Array> {
  return unlockBytes(await hkdf(prfOutput, "PageLock vault passkey v1"), boxed, `PageLock vault v1|root|${keyFp}`);
}

export const XWING_PUBLIC_KEY_BYTES = xwing.lengths.publicKey;
