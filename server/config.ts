/**
 * Builds the PageLock service from environment variables. Shared by the stand-alone server (server/main.ts)
 * and the Vercel function (api/pagelock.ts).
 */
import { Mailer, PageLockService, ServiceStore } from "../src/lib/pagelock/service/service";
import { VaultService, VaultStore } from "../src/lib/pagelock/vault/service";

export const consoleMailer: Mailer = {
  async send(to, subject, text) {
    console.log(`[mail] to=${to} subject="${subject}"\n       ${text}`);
  },
};

export function resendMailer(key: string, from: string): Mailer {
  return {
    async send(to, subject, text) {
      const r = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: [to], subject, text }),
      });
      if (!r.ok) throw new Error(`Email service answered ${r.status}`);
    },
  };
}

export async function serviceFromEnv(store: ServiceStore, env: NodeJS.ProcessEnv, mailer?: Mailer, vaultStore?: VaultStore): Promise<PageLockService> {
  mailer ??= env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, env.PAGELOCK_MAIL_FROM ?? "PageLock <onboarding@resend.dev>") : consoleMailer;
  const vault = vaultStore
    ? await VaultService.create({
        store: vaultStore,
        mailer,
        emailPepper: env.PAGELOCK_EMAIL_PEPPER || undefined,
        siteUrl: env.PAGELOCK_SITE_URL || env.PAGELOCK_ALLOWED_ORIGIN || undefined,
      })
    : undefined;
  return PageLockService.create({
    store,
    mailer,
    vault,
    adminToken: env.PAGELOCK_ADMIN_TOKEN || undefined,
    allowedOrigin: env.PAGELOCK_ALLOWED_ORIGIN || undefined,
  });
}
