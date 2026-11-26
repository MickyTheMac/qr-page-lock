import { MANIFEST_TYPE, PAGE_REPRESENTATION, PROTOCOL } from "./constants";
import { canonicalJson, utf8 } from "./encoding";
import { sha256Hex } from "./crypto";

export interface ManifestPage {
  index: number;
  hash: string;
  prev: string;
  next: string;
}

/** The ordered manifest body. Its digest is bound into every QR code. No document wording, no file names. */
export interface ManifestBody {
  type: typeof MANIFEST_TYPE;
  protocol: typeof PROTOCOL;
  pageRepresentation: typeof PAGE_REPRESENTATION;
  hashAlgorithm: "SHA-256";
  documentId: string;
  createdAt: string;
  pageCount: number;
  sourcePdfSha256: string;
  pages: ManifestPage[];
}

/** The exported .pagelock.json file. Only `body` is covered by the digest. */
export interface ManifestFile {
  pagelockManifest: 1;
  body: ManifestBody;
  manifestDigest: string;
  preparedPdfSha256: string;
  keepSafe: string;
}

export async function manifestDigest(body: ManifestBody): Promise<string> {
  return sha256Hex(utf8(canonicalJson(body)));
}

export function serializeManifestFile(m: ManifestFile): string {
  return JSON.stringify(m, null, 2) + "\n";
}

export type ParsedReference =
  | { kind: "manifest"; file: ManifestFile; digest: string }
  | { kind: "digest"; digest: string };

/** Accepts either a manifest file (JSON) or a bare 64-hex manifest digest. Throws on anything ambiguous. */
export async function parseReference(text: string): Promise<ParsedReference> {
  const t = text.trim();
  const bare = t.replace(/[\s-]/g, "").toUpperCase();
  if (/^[0-9A-F]{64}$/.test(bare)) return { kind: "digest", digest: bare };
  let json: unknown;
  try {
    json = JSON.parse(t);
  } catch {
    throw new Error("The reference is neither a PageLock manifest file nor a 64-character manifest digest.");
  }
  const f = json as ManifestFile;
  if (!f || f.pagelockManifest !== 1 || !f.body || f.body.type !== MANIFEST_TYPE || f.body.protocol !== PROTOCOL)
    throw new Error("This is not a PageLock v1 manifest file.");
  const digest = await manifestDigest(f.body);
  if (digest !== f.manifestDigest) throw new Error("The manifest file is damaged or was edited: its digest does not match its contents.");
  return { kind: "manifest", file: f, digest };
}
