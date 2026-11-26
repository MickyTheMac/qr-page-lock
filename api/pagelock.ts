/**
 * The PageLock service as one Vercel function. vercel.json sends every /api/... address here.
 *
 * Needs (Vercel project settings, Environment Variables):
 *   PAGELOCK_DATABASE_URL   PageLock's own Postgres database (e.g. a separate Neon database). Required.
 *   RESEND_API_KEY          sends the email codes. Required.
 *   PAGELOCK_MAIL_FROM      e.g. "PageLock <pagelock@yourdomain>" (a sender Resend has verified)
 *   PAGELOCK_ALLOWED_ORIGIN this site's own address, e.g. https://pagelock.vercel.app
 *   PAGELOCK_ADMIN_TOKEN    optional, enables revoking a certificate
 *   PAGELOCK_EMAIL_PEPPER   optional secret for scrambling vault email addresses (otherwise one is made and kept in the database)
 *   PAGELOCK_SITE_URL       optional, this site's address for vault invite emails (defaults to PAGELOCK_ALLOWED_ORIGIN)
 */
import type { PageLockService } from "../src/lib/pagelock/service/service";
import { serviceFromEnv } from "../server/config";
import { PgStore } from "../server/pg-store";
import { PgVaultStore } from "../server/pg-vault-store";

let ready: Promise<PageLockService> | null = null;

function service(): Promise<PageLockService> {
  ready ??= (async () => {
    const env = process.env;
    if (!env.PAGELOCK_DATABASE_URL || !env.RESEND_API_KEY) throw new Error("not configured");
    const [store, vault] = await Promise.all([
      PgStore.connect(env.PAGELOCK_DATABASE_URL, { max: 1 }),
      PgVaultStore.connect(env.PAGELOCK_DATABASE_URL, { max: 1 }),
    ]);
    return serviceFromEnv(store, env, undefined, vault);
  })();
  ready.catch(() => (ready = null)); // try again on the next request
  return ready;
}

/** Puts back the address the visitor asked for, if the rewrite passed it as ?__path=. */
export async function originalRequest(req: Request): Promise<Request> {
  const url = new URL(req.url);
  const p = url.searchParams.get("__path");
  if (p === null) return req;
  url.searchParams.delete("__path");
  url.pathname = "/api/" + p.replace(/^\/+/, "");
  const hasBody = req.method !== "GET" && req.method !== "HEAD";
  return new Request(url, { method: req.method, headers: req.headers, body: hasBody ? await req.arrayBuffer() : undefined });
}

async function handle(req: Request): Promise<Response> {
  let s: PageLockService;
  try {
    s = await service();
  } catch (e) {
    const notSetUp = e instanceof Error && e.message === "not configured";
    if (!notSetUp) console.error("PageLock service failed to start", e);
    return new Response(JSON.stringify({ error: notSetUp ? "The PageLock service is not set up yet." : "The PageLock service could not start." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Cache-Control": "no-store" },
    });
  }
  return s.handle(await originalRequest(req));
}

export const GET = handle;
export const POST = handle;
export const OPTIONS = handle;
