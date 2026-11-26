export * from "../src/lib/demo/sample";

import { MemoryStore, ServiceStore } from "../src/lib/pagelock";

/**
 * The store the service tests run against: in memory by default, or a real Postgres database when
 * PAGELOCK_TEST_DATABASE_URL is set (its PageLock tables are wiped first, so use a throwaway database).
 */
export async function testStore(): Promise<ServiceStore> {
  const url = process.env.PAGELOCK_TEST_DATABASE_URL;
  if (!url) return new MemoryStore();
  await resetTestDatabase(url);
  const { PgStore } = await import("../server/pg-store");
  return PgStore.connect(url);
}

export async function resetTestDatabase(url: string) {
  const { Client } = await import("pg");
  const c = new Client({ connectionString: url });
  await c.connect();
  await c.query("DROP TABLE IF EXISTS pagelock_log, pagelock_kv");
  await c.end();
}
