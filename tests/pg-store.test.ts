/**
 * Postgres storage for the hosted PageLock service (serverless: many copies of the service, one database).
 * Runs only when PAGELOCK_TEST_DATABASE_URL points at a throwaway Postgres database.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Client } from "pg";
import { PgStore } from "../server/pg-store";
import { originalRequest } from "../api/pagelock";
import { LogEntry, PageLockClient, PageLockService, inPageFetch } from "../src/lib/pagelock";
import { resetTestDatabase } from "./helpers";

const URL_ = process.env.PAGELOCK_TEST_DATABASE_URL;

describe("Vercel rewrite", () => {
  it("restores the address the visitor asked for, body included", async () => {
    const r = await originalRequest(
      new Request("https://x.test/api/pagelock?__path=enrol%2Fstart&a=1", { method: "POST", body: '{"n":1}', headers: { "Content-Type": "application/json" } }),
    );
    expect(new URL(r.url).pathname).toBe("/api/enrol/start");
    expect(new URL(r.url).search).toBe("?a=1");
    expect(r.method).toBe("POST");
    expect(await r.text()).toBe('{"n":1}');
    expect(r.headers.get("content-type")).toBe("application/json");
  });
  it("leaves a request without the marker alone", async () => {
    const req = new Request("https://x.test/api/trust");
    expect(await originalRequest(req)).toBe(req);
  });
});

describe.skipIf(!URL_)("Postgres store", () => {
  let a: PgStore;
  let b: PgStore;
  const mail: { to: string; text: string }[] = [];
  const mailer = { send: async (to: string, _s: string, text: string) => void mail.push({ to, text }) };

  beforeAll(async () => {
    await resetTestDatabase(URL_!);
    [a, b] = await Promise.all([PgStore.connect(URL_!), PgStore.connect(URL_!)]);
  });
  afterAll(async () => {
    await a?.close();
    await b?.close();
  });

  it("two copies of the service starting together end up with the same authority", async () => {
    const [s1, s2] = await Promise.all([PageLockService.create({ store: a, mailer }), PageLockService.create({ store: b, mailer })]);
    expect(s1.logPublicKeyB64).toBe(s2.logPublicKeyB64);
    expect((await s1.trustFile()).signerAuthorities).toEqual((await s2.trustFile()).signerAuthorities);
  });

  it("the lock serialises writes across copies, so the log never forks", async () => {
    const append = (store: PgStore) =>
      store.withLock(async (s) => {
        const n = (await s.readLog()).length;
        await new Promise((r) => setTimeout(r, 5));
        await s.appendLog({ seq: n + 1 } as LogEntry);
      });
    await Promise.all(Array.from({ length: 12 }, (_, i) => append(i % 2 ? a : b)));
    expect((await a.readLog()).map((e) => e.seq)).toEqual(Array.from({ length: 12 }, (_, i) => i + 1));
  });

  it("the database refuses edits, deletes and wiping of the log", async () => {
    const c = new Client({ connectionString: URL_ });
    await c.connect();
    try {
      await expect(c.query("UPDATE pagelock_log SET entry = '{}' WHERE seq = 1")).rejects.toThrow(/append-only/);
      await expect(c.query("DELETE FROM pagelock_log WHERE seq = 1")).rejects.toThrow(/append-only/);
      await expect(c.query("TRUNCATE pagelock_log")).rejects.toThrow(/append-only/);
      await expect(a.appendLog({ seq: 3 } as LogEntry)).rejects.toThrow(/duplicate key/);
    } finally {
      await c.end();
    }
    expect((await b.readLog()).length).toBe(12);
  });

  it("a refused request still keeps what it counted (wrong email codes add up across copies)", async () => {
    await resetTestDatabase(URL_!);
    await a.close();
    await b.close();
    [a, b] = await Promise.all([PgStore.connect(URL_!), PgStore.connect(URL_!)]);
    const s1 = await PageLockService.create({ store: a, mailer });
    const s2 = await PageLockService.create({ store: b, mailer });
    const c1 = new PageLockClient("https://service.test", inPageFetch(s1));
    const c2 = new PageLockClient("https://service.test", inPageFetch(s2));
    const st = await c1.startEnrolment("Mallory", "mallory@example.com");
    for (let i = 0; i < 5; i++) await expect((i % 2 ? c1 : c2).finishEnrolment(st.enrolmentId, "000000x", st.keys)).rejects.toThrow(/not right/);
    const code = mail.filter((m) => m.to === "mallory@example.com").pop()!.text.match(/\d{6}/)![0];
    await expect(c2.finishEnrolment(st.enrolmentId, code, st.keys)).rejects.toThrow(/Too many/);
  });

  it("an email code works on whichever copy of the service receives it", async () => {
    const s1 = await PageLockService.create({ store: a, mailer });
    const s2 = await PageLockService.create({ store: b, mailer });
    const st = await new PageLockClient("https://service.test", inPageFetch(s1)).startEnrolment("Alice Founder", "alice@example.com");
    const code = mail.filter((m) => m.to === "alice@example.com").pop()!.text.match(/\d{6}/)![0];
    const id = await new PageLockClient("https://service.test", inPageFetch(s2)).finishEnrolment(st.enrolmentId, code, st.keys);
    expect(id.certificatePem).toMatch(/BEGIN CERTIFICATE/);
  });
});

describe("Vercel function build", () => {
  it("compiles to CommonJS that Node can load (regression: ES module output crashed the live function)", async () => {
    const { execFileSync } = await import("node:child_process");
    const { mkdtempSync, symlinkSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { join, resolve } = await import("node:path");
    const out = mkdtempSync(join(tmpdir(), "pagelock-fn-"));
    const root = resolve(__dirname, "..");
    execFileSync(process.execPath, [join(root, "node_modules/typescript/bin/tsc"), "-p", join(root, "api/tsconfig.json"), "--outDir", out, "--rootDir", root]);
    symlinkSync(join(root, "node_modules"), join(out, "node_modules"));
    const fn = execFileSync(process.execPath, ["-e", `const m=require(${JSON.stringify(join(out, "api/pagelock.js"))});console.log(typeof m.GET, typeof m.POST, typeof m.OPTIONS)`]);
    expect(fn.toString().trim()).toBe("function function function");
  }, 60_000);
});
