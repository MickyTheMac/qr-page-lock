/**
 * PageLock service: certificates, timestamps and the private sign-off log.
 *
 *   npm run server            # http://localhost:8787, data in ./server-data (keep this folder private)
 *
 * Environment:
 *   PORT                      default 8787
 *   PAGELOCK_DATABASE_URL     keep everything in this Postgres database (see server/pg-store.ts)
 *   PAGELOCK_DATA_DIR         otherwise, the folder where keys, certificates and the log are kept (default ./server-data)
 *   PAGELOCK_ALLOWED_ORIGIN   the web app's address, e.g. https://pagelock.example (default *)
 *   PAGELOCK_ADMIN_TOKEN      enables POST /api/admin/revoke
 *   RESEND_API_KEY, PAGELOCK_MAIL_FROM   send email codes through Resend; otherwise codes are printed here
 */
import { createServer } from "node:http";
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync, renameSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { ServiceStore } from "../src/lib/pagelock/service/service";
import { serviceFromEnv } from "./config";
import { PgStore } from "./pg-store";
import { LogEntry } from "../src/lib/pagelock/service/log";

class FileStore implements ServiceStore {
  constructor(private dir: string) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  private file(k: string) {
    return join(this.dir, k.replace(/[^a-z0-9_-]/gi, "_") + ".json");
  }
  async get<T>(k: string) {
    const f = this.file(k);
    return existsSync(f) ? (JSON.parse(readFileSync(f, "utf8")) as T) : null;
  }
  async put<T>(k: string, v: T) {
    const f = this.file(k);
    writeFileSync(f + ".tmp", JSON.stringify(v), { mode: 0o600 });
    renameSync(f + ".tmp", f);
  }
  async appendLog(e: LogEntry) {
    const f = join(this.dir, "signoff-log.jsonl");
    appendFileSync(f, JSON.stringify(e) + "\n", { mode: 0o600 });
    chmodSync(f, 0o600);
  }
  async readLog() {
    const f = join(this.dir, "signoff-log.jsonl");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as LogEntry);
  }
}

(async () => {
  const env = process.env;
  const store = env.PAGELOCK_DATABASE_URL
    ? await PgStore.connect(env.PAGELOCK_DATABASE_URL)
    : new FileStore(env.PAGELOCK_DATA_DIR ?? join(process.cwd(), "server-data"));
  const service = await serviceFromEnv(store, env);
  const port = Number(env.PORT ?? 8787);
  createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const c of req) {
      size += (c as Buffer).length;
      if (size > 128 * 1024) {
        res.writeHead(413).end();
        return;
      }
      chunks.push(c as Buffer);
    }
    const body = chunks.length ? Buffer.concat(chunks) : undefined;
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
    const r = await service.handle(
      new Request(`http://localhost${req.url}`, { method: req.method, headers, body: req.method === "GET" || req.method === "HEAD" ? undefined : body }),
    );
    res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
    res.end(Buffer.from(await r.arrayBuffer()));
  }).listen(port, () => console.log(`PageLock service on http://localhost:${port}`));
})();
