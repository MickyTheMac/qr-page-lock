/**
 * Keeps the PageLock service's data in Postgres (e.g. a free Neon database), so the service can run as
 * serverless functions: many short-lived copies of the service share one database safely.
 *
 * Two tables, created on first use:
 *   pagelock_kv   authority keys, issued-certificate register, pending email checks
 *   pagelock_log  the private sign-off log, append-only (the database itself refuses edits and deletes)
 *
 * Give PageLock a database of its own. Never point it at another app's database.
 */
import { Pool, PoolClient } from "pg";
import type { LogEntry } from "../src/lib/pagelock/service/log";
import type { ServiceStore } from "../src/lib/pagelock/service/service";

/** Any number shared by all copies of the service: the advisory lock that serialises writes. */
const LOCK_ID = 0x5061_6765; // "Page"

const SCHEMA = `
CREATE TABLE IF NOT EXISTS pagelock_kv (
  key   text PRIMARY KEY,
  value text NOT NULL
);
CREATE TABLE IF NOT EXISTS pagelock_log (
  seq   integer PRIMARY KEY CHECK (seq > 0),
  entry text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now()
);
CREATE OR REPLACE FUNCTION pagelock_log_is_append_only() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'The PageLock sign-off log is append-only';
END $$;
DROP TRIGGER IF EXISTS pagelock_log_append_only ON pagelock_log;
CREATE TRIGGER pagelock_log_append_only BEFORE UPDATE OR DELETE ON pagelock_log
  FOR EACH ROW EXECUTE FUNCTION pagelock_log_is_append_only();
DROP TRIGGER IF EXISTS pagelock_log_no_truncate ON pagelock_log;
CREATE TRIGGER pagelock_log_no_truncate BEFORE TRUNCATE ON pagelock_log
  FOR EACH STATEMENT EXECUTE FUNCTION pagelock_log_is_append_only();
`;

type Queryable = Pool | PoolClient;

class Ops implements ServiceStore {
  constructor(protected db: Queryable) {}
  async get<T>(key: string): Promise<T | null> {
    const r = await this.db.query<{ value: string }>("SELECT value FROM pagelock_kv WHERE key = $1", [key]);
    return r.rows.length ? (JSON.parse(r.rows[0].value) as T) : null;
  }
  async put<T>(key: string, value: T): Promise<void> {
    await this.db.query(
      "INSERT INTO pagelock_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value",
      [key, JSON.stringify(value)],
    );
  }
  async putIfAbsent<T>(key: string, value: T): Promise<T> {
    await this.db.query("INSERT INTO pagelock_kv (key, value) VALUES ($1, $2) ON CONFLICT (key) DO NOTHING", [key, JSON.stringify(value)]);
    return (await this.get<T>(key))!;
  }
  async appendLog(e: LogEntry): Promise<void> {
    await this.db.query("INSERT INTO pagelock_log (seq, entry) VALUES ($1, $2)", [e.seq, JSON.stringify(e)]);
  }
  async readLog(): Promise<LogEntry[]> {
    const r = await this.db.query<{ entry: string }>("SELECT entry FROM pagelock_log ORDER BY seq");
    return r.rows.map((x) => JSON.parse(x.entry) as LogEntry);
  }
}

export class PgStore extends Ops {
  private constructor(private pool: Pool) {
    super(pool);
  }

  /** Connects and creates the tables if they are missing. */
  static async connect(connectionString: string, opts: { max?: number } = {}): Promise<PgStore> {
    const pool = new Pool({
      connectionString,
      max: opts.max ?? 3,
      // Neon and most hosted Postgres require TLS; a local database does not.
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
    return new PgStore(pool);
  }

  /**
   * Runs fn in one transaction holding a database-wide lock, so two copies of the service can never fork the
   * hash chain or lose an update. Writes fn made are kept even when fn then refuses the request (for example,
   * counting a wrong email code before saying "That code is not right"), like the file and memory stores.
   */
  async withLock<T>(fn: (store: ServiceStore) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    let healthy = false;
    let outcome: { ok: true; value: T } | { ok: false; error: unknown };
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock($1)", [LOCK_ID]);
      try {
        outcome = { ok: true, value: await fn(new Ops(c)) };
      } catch (error) {
        outcome = { ok: false, error };
      }
      // If a database error aborted the transaction, COMMIT rolls it back instead.
      await c.query("COMMIT");
      healthy = true;
    } finally {
      c.release(healthy ? undefined : true);
    }
    if (!outcome.ok) throw outcome.error;
    return outcome.value;
  }

  async close() {
    await this.pool.end();
  }
}
