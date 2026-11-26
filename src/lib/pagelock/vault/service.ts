/**
 * The PageLock vault service: email-code login, and a store of LOCKED documents.
 *
 * What it holds, and nothing more:
 *  - accounts, named only by a keyed hash of the email address (the readable address is used to send a code,
 *    then forgotten),
 *  - each account's padlock (public key) and, optionally, its root locked by a passkey,
 *  - locked files, locked details and wrapped document keys, which it has no way to open.
 *
 * It never receives a readable document, a document key, a root or recovery words.
 * Uses only standard Web APIs, so it runs in Node, in serverless hosts and inside the browser (demo).
 */
import { toHex as upperHex, utf8 } from "../encoding";

const toHex = (b: Uint8Array) => upperHex(b).toLowerCase();
import { ab, b64decode, b64encode, subtle } from "../sign/pki";
import { HttpError, Mailer } from "../service/service";

// Kept free of the browser-side crypto libraries so the server bundle stays small and CommonJS-friendly.
const XWING_PUBLIC_KEY_BYTES = 1216;
async function keyFingerprint(pub: Uint8Array): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest("SHA-256", ab(pub))));
}

// ------------------------------------------------------------------ storage

export interface VaultPasskey {
  id: string; // credential id, base64url
  salt: string; // base64
  lockedRoot: string; // base64
  createdAt: string;
}

export interface VaultAccount {
  emailHash: string;
  publicKey: string | null; // base64
  keyFp: string | null;
  passkeys: VaultPasskey[];
  createdAt: string;
}

export interface VaultLogin {
  id: string;
  emailHash: string;
  codeHash: string;
  expires: number;
  attempts: number;
  done: boolean;
  created: number;
}

export interface VaultSession {
  tokenHash: string;
  emailHash: string;
  expires: number;
}

export interface VaultDoc {
  id: string;
  meta: string; // base64, locked
  size: number; // bytes of the locked file
  createdAt: string;
}

export interface VaultMember {
  id: string;
  docId: string;
  emailHash: string;
  wrap: string | null; // base64
  wrapFor: string | null; // keyFp the wrap was made for
  label: string | null; // base64, locked with the document key
  addedAt: string;
}

export interface VaultStore {
  secret(name: string, make: () => string): Promise<string>;
  getAccount(emailHash: string): Promise<VaultAccount | null>;
  putAccount(a: VaultAccount): Promise<void>;
  putLogin(l: VaultLogin): Promise<void>;
  getLogin(id: string): Promise<VaultLogin | null>;
  /** Adds one wrong try; returns the new count. */
  bumpLoginAttempts(id: string): Promise<number>;
  /** Marks the login used. Returns false if it was already used (so a code works only once). */
  finishLogin(id: string): Promise<boolean>;
  countLoginsSince(emailHash: string, since: number): Promise<number>;
  putSession(s: VaultSession): Promise<void>;
  getSession(tokenHash: string): Promise<VaultSession | null>;
  deleteSession(tokenHash: string): Promise<void>;
  createDoc(doc: VaultDoc, file: Uint8Array, first: VaultMember): Promise<void>;
  getDoc(id: string): Promise<VaultDoc | null>;
  getFile(id: string): Promise<Uint8Array | null>;
  deleteDoc(id: string): Promise<void>;
  listMembers(docId: string): Promise<VaultMember[]>;
  /** Documents this email hash is a member of. */
  docsFor(emailHash: string): Promise<VaultDoc[]>;
  addMember(m: VaultMember): Promise<VaultMember>; // returns the existing member if (docId, emailHash) is taken
  setWrap(memberId: string, wrap: string, wrapFor: string): Promise<void>;
  clearWrapsFor(emailHash: string): Promise<void>;
  removeMember(memberId: string): Promise<void>;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

export class MemoryVaultStore implements VaultStore {
  private secrets = new Map<string, string>();
  private accounts = new Map<string, VaultAccount>();
  private logins = new Map<string, VaultLogin>();
  private sessions = new Map<string, VaultSession>();
  private docs = new Map<string, VaultDoc>();
  private files = new Map<string, Uint8Array>();
  private members = new Map<string, VaultMember>();

  async secret(name: string, make: () => string) {
    if (!this.secrets.has(name)) this.secrets.set(name, make());
    return this.secrets.get(name)!;
  }
  async getAccount(h: string) {
    const a = this.accounts.get(h);
    return a ? clone(a) : null;
  }
  async putAccount(a: VaultAccount) {
    this.accounts.set(a.emailHash, clone(a));
  }
  async putLogin(l: VaultLogin) {
    this.logins.set(l.id, clone(l));
  }
  async getLogin(id: string) {
    const l = this.logins.get(id);
    return l ? clone(l) : null;
  }
  async bumpLoginAttempts(id: string) {
    const l = this.logins.get(id)!;
    return ++l.attempts;
  }
  async finishLogin(id: string) {
    const l = this.logins.get(id);
    if (!l || l.done) return false;
    l.done = true;
    return true;
  }
  async countLoginsSince(h: string, since: number) {
    return [...this.logins.values()].filter((l) => l.emailHash === h && l.created >= since).length;
  }
  async putSession(s: VaultSession) {
    this.sessions.set(s.tokenHash, clone(s));
  }
  async getSession(t: string) {
    const s = this.sessions.get(t);
    return s ? clone(s) : null;
  }
  async deleteSession(t: string) {
    this.sessions.delete(t);
  }
  async createDoc(doc: VaultDoc, file: Uint8Array, first: VaultMember) {
    if (this.docs.has(doc.id)) throw new HttpError(409, "That document number is already used.");
    this.docs.set(doc.id, clone(doc));
    this.files.set(doc.id, file.slice());
    this.members.set(first.id, clone(first));
  }
  async getDoc(id: string) {
    const d = this.docs.get(id);
    return d ? clone(d) : null;
  }
  async getFile(id: string) {
    return this.files.get(id)?.slice() ?? null;
  }
  async deleteDoc(id: string) {
    this.docs.delete(id);
    this.files.delete(id);
    for (const [k, m] of this.members) if (m.docId === id) this.members.delete(k);
  }
  async listMembers(docId: string) {
    return [...this.members.values()].filter((m) => m.docId === docId).map(clone);
  }
  async docsFor(h: string) {
    const ids = new Set([...this.members.values()].filter((m) => m.emailHash === h).map((m) => m.docId));
    return [...ids].map((id) => clone(this.docs.get(id)!)).filter(Boolean);
  }
  async addMember(m: VaultMember) {
    const existing = [...this.members.values()].find((x) => x.docId === m.docId && x.emailHash === m.emailHash);
    if (existing) return clone(existing);
    this.members.set(m.id, clone(m));
    return clone(m);
  }
  async setWrap(id: string, wrap: string, wrapFor: string) {
    const m = this.members.get(id);
    if (m) Object.assign(m, { wrap, wrapFor });
  }
  async clearWrapsFor(h: string) {
    for (const m of this.members.values()) if (m.emailHash === h) Object.assign(m, { wrap: null, wrapFor: null });
  }
  async removeMember(id: string) {
    this.members.delete(id);
  }
}

// ------------------------------------------------------------------ service

export interface VaultConfig {
  store: VaultStore;
  mailer: Mailer;
  /** Keyed-hash secret for email addresses. If unset, one is made and kept in the store. */
  emailPepper?: string;
  /** This site's address, used in invite emails, e.g. https://pagelock.example */
  siteUrl?: string;
  /** DEMO ONLY: return the email code in the API response. */
  exposeCodes?: boolean;
  now?: () => Date;
}

export const VAULT_LIMITS = {
  maxFileBytes: 3 * 1024 * 1024, // locked file; keeps each upload under the 4.5 MB serverless request limit
  maxMembers: 10,
  maxDocsPerAccount: 500,
  codesPer15Min: 5,
  sessionDays: 30,
};

const EMAIL_RE = /^[^\s@<>()]{1,64}@[^\s@<>()]{1,190}\.[A-Za-z]{2,}$/;
const HEX32 = /^[0-9a-f]{32}$/;
const B64 = /^[A-Za-z0-9+/]*={0,2}$/;
const B64URL = /^[A-Za-z0-9_-]{16,400}$/;

function randomHex(bytes: number): string {
  const b = new Uint8Array(bytes);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

function sixDigits(): string {
  const b = new Uint32Array(1);
  globalThis.crypto.getRandomValues(b);
  return String(b[0] % 1_000_000).padStart(6, "0");
}

async function sha256Hex(s: string): Promise<string> {
  return toHex(new Uint8Array(await subtle().digest("SHA-256", ab(utf8(s)))));
}

function b64field(v: unknown, what: string, maxBytes: number): Uint8Array {
  if (typeof v !== "string" || !B64.test(v) || v.length > Math.ceil(maxBytes / 3) * 4 + 4) throw new HttpError(400, `Missing or oversized ${what}.`);
  const b = b64decode(v);
  if (!b.length || b.length > maxBytes) throw new HttpError(400, `Missing or oversized ${what}.`);
  return b;
}

interface Me {
  account: VaultAccount;
  tokenHash: string;
}

export class VaultService {
  private now: () => Date;
  private pepper!: CryptoKey;

  private constructor(private cfg: VaultConfig) {
    this.now = cfg.now ?? (() => new Date());
  }

  static async create(cfg: VaultConfig): Promise<VaultService> {
    const s = new VaultService(cfg);
    const raw = cfg.emailPepper || (await cfg.store.secret("email-pepper", () => randomHex(32)));
    s.pepper = await subtle().importKey("raw", ab(utf8(raw)), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    return s;
  }

  /** A keyed hash, so a stolen database alone cannot be checked against a list of email addresses. */
  async emailHash(email: string): Promise<string> {
    const norm = email.trim().toLowerCase();
    return toHex(new Uint8Array(await subtle().sign("HMAC", this.pepper, ab(utf8(`pagelock-email|${norm}`)))));
  }

  private cleanEmail(v: unknown): string {
    const email = String(v ?? "").trim().toLowerCase();
    if (!EMAIL_RE.test(email)) throw new HttpError(400, "Please give a valid email address.");
    return email;
  }

  // ---------------------------------------------------------------- login

  async startLogin(body: { email?: string }) {
    const email = this.cleanEmail(body?.email);
    const emailHash = await this.emailHash(email);
    const t = this.now().getTime();
    if ((await this.cfg.store.countLoginsSince(emailHash, t - 15 * 60_000)) >= VAULT_LIMITS.codesPer15Min)
      throw new HttpError(429, "Too many codes asked for. Please wait 15 minutes and try again.");
    const code = sixDigits();
    const login: VaultLogin = { id: randomHex(16), emailHash, codeHash: await sha256Hex(`${emailHash}|${code}`), expires: t + 15 * 60_000, attempts: 0, done: false, created: t };
    await this.cfg.store.putLogin(login);
    await this.cfg.mailer.send(email, "Your PageLock login code", `Your PageLock login code is ${code}. It expires in 15 minutes.\n\nIf you did not try to log in to PageLock, you can ignore this email.`);
    return { loginId: login.id, ...(this.cfg.exposeCodes ? { demoCode: code } : {}) };
  }

  async finishLogin(body: { loginId?: string; code?: string }) {
    const id = String(body?.loginId ?? "");
    if (!HEX32.test(id)) throw new HttpError(400, "Unknown login. Please start again.");
    const l = await this.cfg.store.getLogin(id);
    if (!l || l.done) throw new HttpError(400, "Unknown or finished login. Please start again.");
    if (l.expires < this.now().getTime()) throw new HttpError(400, "The code has expired. Please start again.");
    if (l.attempts >= 5) throw new HttpError(429, "Too many wrong codes. Please start again.");
    const code = String(body?.code ?? "").replace(/\s+/g, "");
    if ((await sha256Hex(`${l.emailHash}|${code}`)) !== l.codeHash) {
      const n = await this.cfg.store.bumpLoginAttempts(id);
      throw new HttpError(n >= 5 ? 429 : 400, n >= 5 ? "Too many wrong codes. Please start again." : "That code is not right.");
    }
    if (!(await this.cfg.store.finishLogin(id))) throw new HttpError(400, "This code has already been used. Please start again.");
    let account = await this.cfg.store.getAccount(l.emailHash);
    if (!account) {
      account = { emailHash: l.emailHash, publicKey: null, keyFp: null, passkeys: [], createdAt: this.now().toISOString() };
      await this.cfg.store.putAccount(account);
    }
    const token = randomHex(32);
    await this.cfg.store.putSession({ tokenHash: await sha256Hex(token), emailHash: l.emailHash, expires: this.now().getTime() + VAULT_LIMITS.sessionDays * 86400_000 });
    return { token, account: this.accountView(account) };
  }

  private async me(auth: string | null): Promise<Me> {
    const token = auth?.startsWith("Bearer ") ? auth.slice(7).trim() : "";
    if (!/^[0-9a-f]{64}$/.test(token)) throw new HttpError(401, "Please log in.");
    const tokenHash = await sha256Hex(token);
    const s = await this.cfg.store.getSession(tokenHash);
    if (!s || s.expires < this.now().getTime()) throw new HttpError(401, "Your login has expired. Please log in again.");
    const account = await this.cfg.store.getAccount(s.emailHash);
    if (!account) throw new HttpError(401, "Please log in.");
    return { account, tokenHash };
  }

  async logout(auth: string | null) {
    const { tokenHash } = await this.me(auth);
    await this.cfg.store.deleteSession(tokenHash);
    return { ok: true };
  }

  private accountView(a: VaultAccount) {
    return { publicKey: a.publicKey, keyFp: a.keyFp, passkeys: a.passkeys.map((p) => ({ id: p.id, salt: p.salt, lockedRoot: p.lockedRoot, createdAt: p.createdAt })) };
  }

  async account(auth: string | null) {
    return this.accountView((await this.me(auth)).account);
  }

  /**
   * Sets this account's padlock. Replacing an existing one (lost recovery words) needs `replace: true` and
   * makes every document key wrapped for the old padlock useless, so those are cleared; the other signer
   * can then give access again.
   */
  async setKey(auth: string | null, body: { publicKey?: string; replace?: boolean }) {
    const { account } = await this.me(auth);
    const pub = b64field(body?.publicKey, "padlock", 4096);
    if (pub.length !== XWING_PUBLIC_KEY_BYTES) throw new HttpError(400, "That padlock is not the right size.");
    const keyFp = await keyFingerprint(pub);
    if (account.keyFp === keyFp) return this.accountView(account);
    if (account.keyFp && body?.replace !== true) throw new HttpError(409, "This account already has keys. Unlock with your recovery words, or choose to start again with new keys.");
    if (account.keyFp) await this.cfg.store.clearWrapsFor(account.emailHash);
    account.publicKey = b64encode(pub);
    account.keyFp = keyFp;
    account.passkeys = [];
    await this.cfg.store.putAccount(account);
    return this.accountView(account);
  }

  async addPasskey(auth: string | null, body: { id?: string; salt?: string; lockedRoot?: string; keyFp?: string }) {
    const { account } = await this.me(auth);
    if (!account.keyFp || body?.keyFp !== account.keyFp) throw new HttpError(409, "Your keys have changed. Please reload the page.");
    if (typeof body.id !== "string" || !B64URL.test(body.id)) throw new HttpError(400, "Bad passkey id.");
    const salt = b64field(body.salt, "salt", 64);
    const locked = b64field(body.lockedRoot, "locked root", 256);
    if (account.passkeys.length >= 10) throw new HttpError(400, "You already have 10 passkeys. Remove one first.");
    account.passkeys = account.passkeys.filter((p) => p.id !== body.id);
    account.passkeys.push({ id: body.id, salt: b64encode(salt), lockedRoot: b64encode(locked), createdAt: this.now().toISOString() });
    await this.cfg.store.putAccount(account);
    return this.accountView(account);
  }

  async removePasskey(auth: string | null, id: string) {
    const { account } = await this.me(auth);
    account.passkeys = account.passkeys.filter((p) => p.id !== id);
    await this.cfg.store.putAccount(account);
    return this.accountView(account);
  }

  // ---------------------------------------------------------------- documents

  private async membership(docId: string, me: VaultAccount) {
    if (!HEX32.test(docId)) throw new HttpError(400, "Unknown document.");
    const doc = await this.cfg.store.getDoc(docId);
    const members = doc ? await this.cfg.store.listMembers(docId) : [];
    const mine = members.find((m) => m.emailHash === me.emailHash);
    if (!doc || !mine) throw new HttpError(404, "No such document in your vault.");
    return { doc, members, mine, hasAccess: !!me.keyFp && mine.wrapFor === me.keyFp && !!mine.wrap };
  }

  private requireAccess(x: { hasAccess: boolean }) {
    if (!x.hasAccess) throw new HttpError(403, "You do not have the key for this document yet. Ask the other signer to give you access.");
  }

  async listDocs(auth: string | null) {
    const { account } = await this.me(auth);
    const docs = await this.cfg.store.docsFor(account.emailHash);
    const out = [];
    for (const doc of docs) {
      const members = await this.cfg.store.listMembers(doc.id);
      const mine = members.find((m) => m.emailHash === account.emailHash)!;
      const hasAccess = !!account.keyFp && mine.wrapFor === account.keyFp && !!mine.wrap;
      const others = [];
      for (const m of members) {
        if (m.id === mine.id) continue;
        const a = await this.cfg.store.getAccount(m.emailHash);
        const current = !!a?.keyFp && m.wrapFor === a.keyFp && !!m.wrap;
        others.push({
          memberId: m.id,
          label: m.label,
          addedAt: m.addedAt,
          status: current ? "has-access" : a?.keyFp ? "needs-access" : "invited",
          // Padlocks are public: shown so both people can compare the safety code, and to give access.
          publicKey: a?.publicKey ?? null,
        });
      }
      out.push({
        id: doc.id,
        meta: doc.meta,
        size: doc.size,
        createdAt: doc.createdAt,
        me: { memberId: mine.id, wrap: hasAccess ? mine.wrap : null, label: mine.label },
        hasAccess,
        others,
      });
    }
    out.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
    return { documents: out };
  }

  async saveDoc(auth: string | null, body: { id?: string; meta?: string; file?: string; wrap?: string; wrapFor?: string; label?: string }) {
    const { account } = await this.me(auth);
    if (!account.keyFp) throw new HttpError(409, "Set up your keys first.");
    const id = String(body?.id ?? "");
    if (!HEX32.test(id)) throw new HttpError(400, "Bad document number.");
    if (body.wrapFor !== account.keyFp) throw new HttpError(409, "Your keys have changed. Please reload the page.");
    const file = b64field(body.file, "file", VAULT_LIMITS.maxFileBytes);
    const meta = b64field(body.meta, "details", 16 * 1024);
    const wrap = b64field(body.wrap, "key", 4096);
    const label = body.label ? b64encode(b64field(body.label, "label", 512)) : null;
    if ((await this.cfg.store.docsFor(account.emailHash)).length >= VAULT_LIMITS.maxDocsPerAccount) throw new HttpError(400, "Your vault is full.");
    const at = this.now().toISOString();
    await this.cfg.store.createDoc(
      { id, meta: b64encode(meta), size: file.length, createdAt: at },
      file,
      { id: randomHex(16), docId: id, emailHash: account.emailHash, wrap: b64encode(wrap), wrapFor: account.keyFp, label, addedAt: at },
    );
    return { id };
  }

  async getFile(auth: string | null, docId: string): Promise<Uint8Array> {
    const { account } = await this.me(auth);
    this.requireAccess(await this.membership(docId, account));
    const f = await this.cfg.store.getFile(docId);
    if (!f) throw new HttpError(404, "No such document in your vault.");
    return f;
  }

  /** Adds the other signer by email. Their padlock comes back if they already have one; otherwise they are invited. */
  async addMember(auth: string | null, docId: string, body: { email?: string; label?: string }) {
    const { account } = await this.me(auth);
    const x = await this.membership(docId, account);
    this.requireAccess(x);
    const email = this.cleanEmail(body?.email);
    const emailHash = await this.emailHash(email);
    if (emailHash === account.emailHash) throw new HttpError(400, "That is your own email address.");
    if (!x.members.some((m) => m.emailHash === emailHash) && x.members.length >= VAULT_LIMITS.maxMembers) throw new HttpError(400, "This document already has the most people allowed.");
    const label = body.label ? b64encode(b64field(body.label, "label", 512)) : null;
    const m = await this.cfg.store.addMember({ id: randomHex(16), docId, emailHash, wrap: null, wrapFor: null, label, addedAt: this.now().toISOString() });
    const other = await this.cfg.store.getAccount(emailHash);
    if (other?.publicKey) return { memberId: m.id, publicKey: other.publicKey, keyFp: other.keyFp, invited: false };
    const site = this.cfg.siteUrl?.replace(/\/+$/, "") ?? "";
    await this.cfg.mailer.send(
      email,
      "A PageLock document is waiting for you",
      `Someone has saved a signed PageLock document for you in their PageLock vault.\n\nTo open it, log in with this email address at ${site}/vault/ and set up your vault. Then ask them to give you access: you will both see a short safety code to compare.\n\nPageLock cannot read the document. It is locked so only the people it is shared with can open it.`,
    );
    return { memberId: m.id, publicKey: null, keyFp: null, invited: true };
  }

  /** Any signer who holds the document key can give it to another member, wrapped for that member's CURRENT padlock. */
  async giveAccess(auth: string | null, docId: string, memberId: string, body: { wrap?: string; wrapFor?: string }) {
    const { account } = await this.me(auth);
    const x = await this.membership(docId, account);
    this.requireAccess(x);
    const m = x.members.find((y) => y.id === memberId);
    if (!m) throw new HttpError(404, "No such person on this document.");
    const target = await this.cfg.store.getAccount(m.emailHash);
    if (!target?.keyFp) throw new HttpError(409, "They have not set up their vault yet.");
    if (body?.wrapFor !== target.keyFp) throw new HttpError(409, "Their keys have changed. Please reload and check the new safety code.");
    await this.cfg.store.setWrap(m.id, b64encode(b64field(body.wrap, "key", 4096)), target.keyFp);
    return { ok: true };
  }

  /** Removes this document from MY vault only. The other signer keeps theirs. The locked file goes when nobody is left. */
  async removeDoc(auth: string | null, docId: string) {
    const { account } = await this.me(auth);
    const x = await this.membership(docId, account);
    await this.cfg.store.removeMember(x.mine.id);
    if (!x.members.some((m) => m.id !== x.mine.id && m.wrap)) await this.cfg.store.deleteDoc(docId);
    return { ok: true };
  }

  // ---------------------------------------------------------------- HTTP

  /** Handles /api/auth/* and /api/vault/*. Returns null for any other path. */
  async handle(req: Request, cors: Record<string, string>): Promise<Response | null> {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, "");
    if (!path.startsWith("/api/auth/") && !path.startsWith("/api/vault/") && path !== "/api/vault") return null;
    const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { ...cors, "Content-Type": "application/json" } });
    const auth = req.headers.get("Authorization");
    const body = async (limit = 64 * 1024) => {
      const t = await req.text();
      if (t.length > limit) throw new HttpError(413, "Request too large.");
      try {
        return JSON.parse(t);
      } catch {
        throw new HttpError(400, "Expected JSON.");
      }
    };
    const M = req.method;
    try {
      if (M === "POST" && path === "/api/auth/start") return json(200, await this.startLogin(await body()));
      if (M === "POST" && path === "/api/auth/finish") return json(200, await this.finishLogin(await body()));
      if (M === "POST" && path === "/api/auth/logout") return json(200, await this.logout(auth));
      if (M === "GET" && path === "/api/vault/account") return json(200, await this.account(auth));
      if (M === "POST" && path === "/api/vault/account/key") return json(200, await this.setKey(auth, await body()));
      if (M === "POST" && path === "/api/vault/account/passkeys") return json(200, await this.addPasskey(auth, await body()));
      let m = path.match(/^\/api\/vault\/account\/passkeys\/([A-Za-z0-9_-]+)\/remove$/);
      if (M === "POST" && m) return json(200, await this.removePasskey(auth, m[1]));
      if (M === "GET" && path === "/api/vault/docs") return json(200, await this.listDocs(auth));
      if (M === "POST" && path === "/api/vault/docs") return json(200, await this.saveDoc(auth, await body(Math.ceil(VAULT_LIMITS.maxFileBytes / 3) * 4 + 64 * 1024)));
      m = path.match(/^\/api\/vault\/docs\/([0-9a-f]{32})\/file$/);
      if (M === "GET" && m)
        return new Response(ab(await this.getFile(auth, m[1])), { headers: { ...cors, "Content-Type": "application/octet-stream" } });
      m = path.match(/^\/api\/vault\/docs\/([0-9a-f]{32})\/members$/);
      if (M === "POST" && m) return json(200, await this.addMember(auth, m[1], await body()));
      m = path.match(/^\/api\/vault\/docs\/([0-9a-f]{32})\/members\/([0-9a-f]{32})\/access$/);
      if (M === "POST" && m) return json(200, await this.giveAccess(auth, m[1], m[2], await body()));
      m = path.match(/^\/api\/vault\/docs\/([0-9a-f]{32})\/remove$/);
      if (M === "POST" && m) return json(200, await this.removeDoc(auth, m[1]));
      return json(404, { error: "Not found." });
    } catch (e) {
      if (e instanceof HttpError) return json(e.status, { error: e.message });
      console.error("vault error", e);
      return json(500, { error: "Something went wrong." });
    }
  }
}
