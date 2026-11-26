/**
 * Which PageLock service this app talks to.
 * - With NEXT_PUBLIC_PAGELOCK_SERVICE_URL set at build time: that server (real certificates, real log).
 * - Without it (local dev and the try-out link): a DEMO service that runs inside this browser tab, keeps its keys in
 *   this browser's storage, and shows email codes on screen. It is clearly marked as a demo everywhere.
 */
import { LogEntry, MemoryStore, MemoryVaultStore, PageLockClient, PageLockService, ServiceStore, VaultClient, VaultService, inPageFetch } from "@/lib/pagelock";

export interface ActiveService {
  client: PageLockClient;
  vault: VaultClient;
  demo: boolean;
  label: string;
  url: string;
}

const CONFIGURED: string | undefined = process.env.NEXT_PUBLIC_PAGELOCK_SERVICE_URL || undefined;
const PREFIX = "pagelock-demo-service:";

/** Keeps the demo service's state in localStorage so the try-out survives a reload. Falls back to memory. */
class LocalStore implements ServiceStore {
  private mem = new MemoryStore();
  private ok = (() => {
    try {
      localStorage.setItem(PREFIX + "probe", "1");
      localStorage.removeItem(PREFIX + "probe");
      return true;
    } catch {
      return false;
    }
  })();
  async get<T>(k: string) {
    if (!this.ok) return this.mem.get<T>(k);
    const v = localStorage.getItem(PREFIX + k);
    return v === null ? null : (JSON.parse(v) as T);
  }
  async put<T>(k: string, v: T) {
    if (!this.ok) return this.mem.put(k, v);
    localStorage.setItem(PREFIX + k, JSON.stringify(v));
  }
  async appendLog(e: LogEntry) {
    const log = await this.readLog();
    log.push(e);
    await this.put("log", log);
  }
  async readLog() {
    return (await this.get<LogEntry[]>("log")) ?? [];
  }
}

let active: Promise<ActiveService> | null = null;

export function getService(): Promise<ActiveService> {
  active ??= (async () => {
    if (CONFIGURED) return { client: new PageLockClient(CONFIGURED), vault: new VaultClient(CONFIGURED), demo: false, label: "PageLock service", url: CONFIGURED };
    const mailer = { send: async () => undefined };
    // DEMO vault: lives in this tab's memory only, so it empties when the page is reloaded.
    const vault = await VaultService.create({ store: new MemoryVaultStore(), mailer, exposeCodes: true });
    const service = await PageLockService.create({
      vault,
      store: new LocalStore(),
      mailer,
      exposeCodes: true,
      demo: true,
      authorityName: "PageLock DEMO",
    });
    const url = "https://demo.pagelock.invalid";
    return { client: new PageLockClient(url, inPageFetch(service)), vault: new VaultClient(url, inPageFetch(service)), demo: true, label: "Demo service (runs in this browser only)", url };
  })();
  return active;
}
