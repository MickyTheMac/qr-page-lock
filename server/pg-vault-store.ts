/**
 * Keeps the vault in Postgres (PageLock's own Neon database). Everything here is either a keyed hash, a public
 * padlock, or a locked box that PageLock cannot open. Tables are created on first use.
 */
import { Pool } from "pg";
import type { VaultAccount, VaultDoc, VaultLogin, VaultMember, VaultSession, VaultStore } from "../src/lib/pagelock/vault/service";
import { HttpError } from "../src/lib/pagelock/service/service";

const LOCK_ID = 0x5661_756c; // "Vaul"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pagelock_vault_secrets (name text PRIMARY KEY, value text NOT NULL);
CREATE TABLE IF NOT EXISTS pagelock_vault_accounts (
  email_hash text PRIMARY KEY,
  public_key text,
  key_fp     text,
  passkeys   jsonb NOT NULL DEFAULT '[]',
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS pagelock_vault_logins (
  id         text PRIMARY KEY,
  email_hash text NOT NULL,
  code_hash  text NOT NULL,
  expires    bigint NOT NULL,
  attempts   integer NOT NULL DEFAULT 0,
  done       boolean NOT NULL DEFAULT false,
  created    bigint NOT NULL
);
CREATE INDEX IF NOT EXISTS pagelock_vault_logins_by_email ON pagelock_vault_logins (email_hash, created);
CREATE TABLE IF NOT EXISTS pagelock_vault_sessions (
  token_hash text PRIMARY KEY,
  email_hash text NOT NULL,
  expires    bigint NOT NULL
);
CREATE TABLE IF NOT EXISTS pagelock_vault_docs (
  id         text PRIMARY KEY,
  meta       text NOT NULL,
  size       integer NOT NULL,
  created_at text NOT NULL
);
CREATE TABLE IF NOT EXISTS pagelock_vault_files (
  doc_id text PRIMARY KEY REFERENCES pagelock_vault_docs (id) ON DELETE CASCADE,
  data   bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS pagelock_vault_members (
  id         text PRIMARY KEY,
  doc_id     text NOT NULL REFERENCES pagelock_vault_docs (id) ON DELETE CASCADE,
  email_hash text NOT NULL,
  wrap       text,
  wrap_for   text,
  label      text,
  added_at   text NOT NULL,
  UNIQUE (doc_id, email_hash)
);
CREATE INDEX IF NOT EXISTS pagelock_vault_members_by_email ON pagelock_vault_members (email_hash);
`;

type Row = Record<string, unknown>;
const account = (r: Row): VaultAccount => ({
  emailHash: r.email_hash as string,
  publicKey: (r.public_key as string) ?? null,
  keyFp: (r.key_fp as string) ?? null,
  passkeys: (r.passkeys as VaultAccount["passkeys"]) ?? [],
  createdAt: r.created_at as string,
});
const member = (r: Row): VaultMember => ({
  id: r.id as string,
  docId: r.doc_id as string,
  emailHash: r.email_hash as string,
  wrap: (r.wrap as string) ?? null,
  wrapFor: (r.wrap_for as string) ?? null,
  label: (r.label as string) ?? null,
  addedAt: r.added_at as string,
});
const doc = (r: Row): VaultDoc => ({ id: r.id as string, meta: r.meta as string, size: Number(r.size), createdAt: r.created_at as string });

export class PgVaultStore implements VaultStore {
  private constructor(private db: Pool) {}

  static async connect(connectionString: string, opts: { max?: number } = {}): Promise<PgVaultStore> {
    const pool = new Pool({
      connectionString,
      max: opts.max ?? 3,
      ssl: /localhost|127\.0\.0\.1|\/tmp|host=\//.test(connectionString) ? undefined : { rejectUnauthorized: true },
    });
    const c = await pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
      await c.query(SCHEMA);
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
    return new PgVaultStore(pool);
  }

  async close() {
    await this.db.end();
  }

  async secret(name: string, make: () => string) {
    await this.db.query("INSERT INTO pagelock_vault_secrets (name, value) VALUES ($1, $2) ON CONFLICT (name) DO NOTHING", [name, make()]);
    return (await this.db.query("SELECT value FROM pagelock_vault_secrets WHERE name = $1", [name])).rows[0].value as string;
  }
  async getAccount(h: string) {
    const r = await this.db.query("SELECT * FROM pagelock_vault_accounts WHERE email_hash = $1", [h]);
    return r.rows.length ? account(r.rows[0]) : null;
  }
  async putAccount(a: VaultAccount) {
    await this.db.query(
      `INSERT INTO pagelock_vault_accounts (email_hash, public_key, key_fp, passkeys, created_at) VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (email_hash) DO UPDATE SET public_key = EXCLUDED.public_key, key_fp = EXCLUDED.key_fp, passkeys = EXCLUDED.passkeys`,
      [a.emailHash, a.publicKey, a.keyFp, JSON.stringify(a.passkeys), a.createdAt],
    );
  }
  async putLogin(l: VaultLogin) {
    await this.db.query(
      "INSERT INTO pagelock_vault_logins (id, email_hash, code_hash, expires, attempts, done, created) VALUES ($1, $2, $3, $4, $5, $6, $7)",
      [l.id, l.emailHash, l.codeHash, l.expires, l.attempts, l.done, l.created],
    );
    // Old login attempts are of no further use: keep the table small.
    await this.db.query("DELETE FROM pagelock_vault_logins WHERE created < $1", [l.created - 86400_000]);
  }
  async getLogin(id: string) {
    const r = await this.db.query("SELECT * FROM pagelock_vault_logins WHERE id = $1", [id]);
    if (!r.rows.length) return null;
    const x = r.rows[0];
    return { id: x.id, emailHash: x.email_hash, codeHash: x.code_hash, expires: Number(x.expires), attempts: x.attempts, done: x.done, created: Number(x.created) };
  }
  async bumpLoginAttempts(id: string) {
    const r = await this.db.query("UPDATE pagelock_vault_logins SET attempts = attempts + 1 WHERE id = $1 RETURNING attempts", [id]);
    return r.rows[0]?.attempts ?? 99;
  }
  async finishLogin(id: string) {
    const r = await this.db.query("UPDATE pagelock_vault_logins SET done = true WHERE id = $1 AND done = false AND attempts < 5 RETURNING id", [id]);
    return r.rowCount === 1;
  }
  async countLoginsSince(h: string, since: number) {
    const r = await this.db.query("SELECT count(*)::int AS n FROM pagelock_vault_logins WHERE email_hash = $1 AND created >= $2", [h, since]);
    return r.rows[0].n as number;
  }
  async putSession(s: VaultSession) {
    await this.db.query("INSERT INTO pagelock_vault_sessions (token_hash, email_hash, expires) VALUES ($1, $2, $3)", [s.tokenHash, s.emailHash, s.expires]);
    await this.db.query("DELETE FROM pagelock_vault_sessions WHERE expires < $1", [Date.now()]);
  }
  async getSession(t: string) {
    const r = await this.db.query("SELECT * FROM pagelock_vault_sessions WHERE token_hash = $1", [t]);
    return r.rows.length ? { tokenHash: r.rows[0].token_hash, emailHash: r.rows[0].email_hash, expires: Number(r.rows[0].expires) } : null;
  }
  async deleteSession(t: string) {
    await this.db.query("DELETE FROM pagelock_vault_sessions WHERE token_hash = $1", [t]);
  }
  async createDoc(d: VaultDoc, file: Uint8Array, first: VaultMember) {
    const c = await this.db.connect();
    try {
      await c.query("BEGIN");
      const ins = await c.query("INSERT INTO pagelock_vault_docs (id, meta, size, created_at) VALUES ($1, $2, $3, $4) ON CONFLICT (id) DO NOTHING", [d.id, d.meta, d.size, d.createdAt]);
      if (ins.rowCount !== 1) throw new HttpError(409, "That document number is already used.");
      await c.query("INSERT INTO pagelock_vault_files (doc_id, data) VALUES ($1, $2)", [d.id, Buffer.from(file)]);
      await c.query(
        "INSERT INTO pagelock_vault_members (id, doc_id, email_hash, wrap, wrap_for, label, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7)",
        [first.id, first.docId, first.emailHash, first.wrap, first.wrapFor, first.label, first.addedAt],
      );
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK").catch(() => undefined);
      throw e;
    } finally {
      c.release();
    }
  }
  async getDoc(id: string) {
    const r = await this.db.query("SELECT * FROM pagelock_vault_docs WHERE id = $1", [id]);
    return r.rows.length ? doc(r.rows[0]) : null;
  }
  async getFile(id: string) {
    const r = await this.db.query("SELECT data FROM pagelock_vault_files WHERE doc_id = $1", [id]);
    return r.rows.length ? new Uint8Array(r.rows[0].data as Buffer) : null;
  }
  async deleteDoc(id: string) {
    await this.db.query("DELETE FROM pagelock_vault_docs WHERE id = $1", [id]);
  }
  async listMembers(docId: string) {
    const r = await this.db.query("SELECT * FROM pagelock_vault_members WHERE doc_id = $1 ORDER BY added_at, id", [docId]);
    return r.rows.map(member);
  }
  async docsFor(h: string) {
    const r = await this.db.query(
      "SELECT d.* FROM pagelock_vault_docs d JOIN pagelock_vault_members m ON m.doc_id = d.id WHERE m.email_hash = $1",
      [h],
    );
    return r.rows.map(doc);
  }
  async addMember(m: VaultMember) {
    await this.db.query(
      `INSERT INTO pagelock_vault_members (id, doc_id, email_hash, wrap, wrap_for, label, added_at) VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (doc_id, email_hash) DO NOTHING`,
      [m.id, m.docId, m.emailHash, m.wrap, m.wrapFor, m.label, m.addedAt],
    );
    const r = await this.db.query("SELECT * FROM pagelock_vault_members WHERE doc_id = $1 AND email_hash = $2", [m.docId, m.emailHash]);
    return member(r.rows[0]);
  }
  async setWrap(id: string, wrap: string, wrapFor: string) {
    await this.db.query("UPDATE pagelock_vault_members SET wrap = $2, wrap_for = $3 WHERE id = $1", [id, wrap, wrapFor]);
  }
  async clearWrapsFor(h: string) {
    await this.db.query("UPDATE pagelock_vault_members SET wrap = NULL, wrap_for = NULL WHERE email_hash = $1", [h]);
  }
  async removeMember(id: string) {
    await this.db.query("DELETE FROM pagelock_vault_members WHERE id = $1", [id]);
  }
}
