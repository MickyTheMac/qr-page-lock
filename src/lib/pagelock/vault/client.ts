/**
 * Browser side of the vault: talks to the vault service and does all locking/unlocking locally.
 * Readable documents, document keys and the root never leave this device.
 */
import { b64decode, b64encode } from "../sign/pki";
import {
  VaultIdentity,
  VaultMeta,
  deriveIdentity,
  lockDocument,
  lockLabel,
  lockRootWithPasskey,
  newDocKey,
  newVaultDocId,
  safetyCode,
  unlockFile,
  unlockLabel,
  unlockMeta,
  unlockRootWithPasskey,
  unwrapDocKey,
  wrapDocKey,
} from "./crypto";

export interface AccountInfo {
  publicKey: string | null;
  keyFp: string | null;
  passkeys: { id: string; salt: string; lockedRoot: string; createdAt: string }[];
}

interface RawDoc {
  id: string;
  meta: string;
  size: number;
  createdAt: string;
  me: { memberId: string; wrap: string | null; label: string | null };
  hasAccess: boolean;
  others: { memberId: string; label: string | null; addedAt: string; status: "has-access" | "needs-access" | "invited"; publicKey: string | null }[];
}

export interface VaultPerson {
  memberId: string;
  label: string | null; // e.g. their email, as typed by whoever added them; null if unreadable
  status: "has-access" | "needs-access" | "invited";
  publicKey: Uint8Array | null; // set when you can give them access
  safetyCode: string | null;
}

export interface VaultDocument {
  id: string;
  createdAt: string;
  size: number;
  hasAccess: boolean;
  key: Uint8Array | null;
  meta: VaultMeta | null;
  others: VaultPerson[];
}

export class VaultApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export class VaultClient {
  token: string | null = null;
  constructor(
    private base: string,
    private fetcher: typeof fetch = (...a) => fetch(...a),
  ) {}

  private async call<T>(method: string, path: string, body?: unknown, raw = false): Promise<T> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["Content-Type"] = "application/json";
    if (this.token) headers.Authorization = `Bearer ${this.token}`;
    const r = await this.fetcher(this.base.replace(/\/+$/, "") + path, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (!r.ok) {
      let msg = `The vault service answered ${r.status}.`;
      try {
        msg = (await r.json()).error ?? msg;
      } catch {}
      throw new VaultApiError(r.status, msg);
    }
    return (raw ? new Uint8Array(await r.arrayBuffer()) : await r.json()) as T;
  }

  // ---------------------------------------------------------------- login and account

  startLogin(email: string) {
    return this.call<{ loginId: string; demoCode?: string }>("POST", "/api/auth/start", { email });
  }
  async finishLogin(loginId: string, code: string) {
    const r = await this.call<{ token: string; account: AccountInfo }>("POST", "/api/auth/finish", { loginId, code });
    this.token = r.token;
    return r;
  }
  async logout() {
    try {
      await this.call("POST", "/api/auth/logout", {});
    } finally {
      this.token = null;
    }
  }
  account() {
    return this.call<AccountInfo>("GET", "/api/vault/account");
  }
  setKey(me: VaultIdentity, replace = false) {
    return this.call<AccountInfo>("POST", "/api/vault/account/key", { publicKey: b64encode(me.publicKey), replace });
  }
  async addPasskey(me: VaultIdentity, root: Uint8Array, passkey: { id: string; salt: Uint8Array; prf: Uint8Array }) {
    const lockedRoot = await lockRootWithPasskey(root, passkey.prf, me.keyFp);
    return this.call<AccountInfo>("POST", "/api/vault/account/passkeys", { id: passkey.id, salt: b64encode(passkey.salt), lockedRoot: b64encode(lockedRoot), keyFp: me.keyFp });
  }
  removePasskey(id: string) {
    return this.call<AccountInfo>("POST", `/api/vault/account/passkeys/${id}/remove`, {});
  }

  /** Opens the root with a passkey's secret, and checks it really is this account's root. */
  async rootFromPasskey(account: AccountInfo, passkeyId: string, prf: Uint8Array): Promise<Uint8Array> {
    const p = account.passkeys.find((x) => x.id === passkeyId);
    if (!p || !account.keyFp) throw new Error("That passkey is not set up for this vault.");
    const root = await unlockRootWithPasskey(b64decode(p.lockedRoot), prf, account.keyFp);
    if ((await deriveIdentity(root)).keyFp !== account.keyFp) throw new Error("That passkey belongs to older keys.");
    return root;
  }

  // ---------------------------------------------------------------- documents

  async list(me: VaultIdentity): Promise<VaultDocument[]> {
    const { documents } = await this.call<{ documents: RawDoc[] }>("GET", "/api/vault/docs");
    const out: VaultDocument[] = [];
    for (const d of documents) {
      let key: Uint8Array | null = null;
      let meta: VaultMeta | null = null;
      if (d.hasAccess && d.me.wrap) {
        try {
          key = await unwrapDocKey(d.id, b64decode(d.me.wrap), me);
          meta = await unlockMeta(d.id, key, b64decode(d.meta));
        } catch {
          key = null;
        }
      }
      const others: VaultPerson[] = [];
      for (const o of d.others) {
        let label: string | null = null;
        if (key && o.label) label = await unlockLabel(d.id, key, b64decode(o.label)).catch(() => null);
        const pub = o.publicKey ? b64decode(o.publicKey) : null;
        others.push({ memberId: o.memberId, label, status: o.status, publicKey: pub, safetyCode: pub ? await safetyCode(me.publicKey, pub) : null });
      }
      out.push({ id: d.id, createdAt: d.createdAt, size: d.size, hasAccess: !!key, key, meta, others });
    }
    return out;
  }

  /** Locks the file on this device, then uploads only the locked box and a key wrapped for my own padlock. */
  async save(me: VaultIdentity, file: Uint8Array, meta: Omit<VaultMeta, "v" | "savedAt" | "size">): Promise<string> {
    const id = newVaultDocId();
    const key = newDocKey();
    const full: VaultMeta = { v: 1, savedAt: new Date().toISOString(), size: file.length, ...meta };
    const locked = await lockDocument(id, key, file, full);
    const { wrap, wrapFor } = await wrapDocKey(id, key, me.publicKey);
    await this.call("POST", "/api/vault/docs", { id, meta: b64encode(locked.meta), file: b64encode(locked.file), wrap: b64encode(wrap), wrapFor });
    return id;
  }

  /** Downloads the locked box and opens it here. */
  async open(doc: VaultDocument): Promise<Uint8Array> {
    if (!doc.key) throw new Error("You do not have the key for this document yet.");
    const boxed = await this.call<Uint8Array>("GET", `/api/vault/docs/${doc.id}/file`, undefined, true);
    return unlockFile(doc.id, doc.key, boxed);
  }

  /**
   * Adds the other signer by email. If they already have a vault, returns their padlock and the safety code to
   * compare BEFORE calling giveAccess. If not, they are emailed an invite.
   */
  async addPerson(me: VaultIdentity, doc: VaultDocument, email: string) {
    if (!doc.key) throw new Error("You do not have the key for this document yet.");
    const label = await lockLabel(doc.id, doc.key, email.trim());
    const r = await this.call<{ memberId: string; publicKey: string | null; invited: boolean }>("POST", `/api/vault/docs/${doc.id}/members`, { email, label: b64encode(label) });
    const pub = r.publicKey ? b64decode(r.publicKey) : null;
    return { memberId: r.memberId, invited: r.invited, publicKey: pub, safetyCode: pub ? await safetyCode(me.publicKey, pub) : null };
  }

  /** Wraps the document key for that person's padlock. Only call after the safety codes have been compared. */
  async giveAccess(doc: VaultDocument, memberId: string, theirPublicKey: Uint8Array) {
    if (!doc.key) throw new Error("You do not have the key for this document yet.");
    const { wrap, wrapFor } = await wrapDocKey(doc.id, doc.key, theirPublicKey);
    await this.call("POST", `/api/vault/docs/${doc.id}/members/${memberId}/access`, { wrap: b64encode(wrap), wrapFor });
  }

  remove(docId: string) {
    return this.call("POST", `/api/vault/docs/${docId}/remove`, {});
  }
}
