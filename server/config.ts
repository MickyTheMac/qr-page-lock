/**
 * Builds the PageLock service from environment variables. Shared by the stand-alone server (server/main.ts)
 * and the Vercel function (api/pagelock.ts).
 */
import { Mailer, PageLockService, ServiceStore } from "../src/lib/pagelock/service/service";

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

export function serviceFromEnv(store: ServiceStore, env: NodeJS.ProcessEnv, mailer?: Mailer): Promise<PageLockService> {
  return PageLockService.create({
    store,
    mailer: mailer ?? (env.RESEND_API_KEY ? resendMailer(env.RESEND_API_KEY, env.PAGELOCK_MAIL_FROM ?? "PageLock <onboarding@resend.dev>") : consoleMailer),
    adminToken: env.PAGELOCK_ADMIN_TOKEN || undefined,
    allowedOrigin: env.PAGELOCK_ALLOWED_ORIGIN || undefined,
  });
}
