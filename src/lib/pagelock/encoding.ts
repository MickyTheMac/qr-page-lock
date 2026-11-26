const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

export function toHex(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += b.toString(16).padStart(2, "0");
  return s.toUpperCase();
}

export function utf8(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

export function concatBytes(chunks: Uint8Array[]): Uint8Array {
  let len = 0;
  for (const c of chunks) len += c.length;
  const out = new Uint8Array(len);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

/** Crockford base32 (no padding). 15 bytes -> 24 characters. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5) {
      out += CROCKFORD[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += CROCKFORD[(value << (5 - bits)) & 31];
  return out;
}

/** "ABCD1234..." -> "ABCD-1234-..." for display only. */
export function groupDocId(id: string): string {
  return id.match(/.{1,4}/g)?.join("-") ?? id;
}

/** Short human-readable fingerprint: first 12 hex chars in groups of 4. Human reference only. */
export function shortFingerprint(hashHex: string): string {
  return hashHex.slice(0, 12).match(/.{4}/g)!.join(" ");
}

/**
 * Deterministic JSON: object keys sorted by UTF-16 code unit order, no whitespace.
 * Only strings, safe integers, booleans, null, arrays and plain objects are allowed.
 */
export function canonicalJson(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value)) throw new Error("canonicalJson: only safe integers are allowed");
    return String(value);
  }
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  if (typeof value === "object") {
    const keys = Object.keys(value as object).sort();
    return (
      "{" +
      keys
        .filter((k) => (value as Record<string, unknown>)[k] !== undefined)
        .map((k) => JSON.stringify(k) + ":" + canonicalJson((value as Record<string, unknown>)[k]))
        .join(",") +
      "}"
    );
  }
  throw new Error("canonicalJson: unsupported type " + typeof value);
}

/** Deterministic number formatting for PDF content streams. */
export function fmtNum(n: number): string {
  if (!Number.isFinite(n)) throw new Error("non-finite number");
  if (Number.isInteger(n)) return String(n);
  return n.toFixed(4).replace(/0+$/, "").replace(/\.$/, "");
}
