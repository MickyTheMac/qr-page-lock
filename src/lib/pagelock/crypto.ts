import { base32, toHex } from "./encoding";

function subtle(): SubtleCrypto {
  const c = globalThis.crypto;
  if (!c?.subtle) throw new Error("Web Crypto is not available in this environment (needs a secure context).");
  return c.subtle;
}

export async function sha256Hex(data: Uint8Array): Promise<string> {
  const digest = await subtle().digest("SHA-256", data as BufferSource);
  return toHex(new Uint8Array(digest));
}

/** 120-bit cryptographically random document ID, Crockford base32 (24 chars). */
export function newDocumentId(): string {
  const bytes = new Uint8Array(15);
  globalThis.crypto.getRandomValues(bytes);
  return base32(bytes);
}
