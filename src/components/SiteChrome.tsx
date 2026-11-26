// Header and footer shared by the Next.js app and the single-file build.
import Link from "next/link";
import { FileSealIcon, LockIcon, PenIcon, SearchCheckIcon, ShieldCheckIcon } from "./icons";

export type Section = "home" | "create" | "sign" | "verify" | "vault";

const NAV: { key: Exclude<Section, "home">; href: string; label: string; Icon: typeof LockIcon }[] = [
  { key: "create", href: "/create/", label: "Create", Icon: FileSealIcon },
  { key: "sign", href: "/sign/", label: "Sign", Icon: PenIcon },
  { key: "verify", href: "/verify/", label: "Verify", Icon: SearchCheckIcon },
  { key: "vault", href: "/vault/", label: "Vault", Icon: LockIcon },
];

export function SiteHeader({ active }: { active: Section }) {
  return (
    <header className="sticky top-0 z-20 border-b border-indigo-900 bg-slate-900 shadow-lg shadow-slate-900/20">
      <nav className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-2.5 sm:gap-2">
        <Link href="/" className="mr-2 flex items-center gap-2 font-bold tracking-tight text-white sm:mr-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-400 to-indigo-600 text-white shadow-sm shadow-indigo-900/40">
            <LockIcon size={18} />
          </span>
          <span className="hidden text-lg min-[400px]:inline">PageLock</span>
        </Link>
        {NAV.map(({ key, href, label, Icon }) => (
          <Link
            key={key}
            href={href}
            aria-current={active === key ? "page" : undefined}
            className={`flex items-center gap-1 rounded-lg px-2 py-2 text-sm font-medium transition sm:gap-1.5 sm:px-2.5 ${
              active === key ? "bg-white text-indigo-700 shadow-sm" : "text-slate-300 hover:bg-white/10 hover:text-white"
            }`}
          >
            <Icon size={17} />
            {label}
          </Link>
        ))}
        <span className="ml-auto hidden rounded-full bg-amber-300 px-2.5 py-1 text-xs font-semibold text-amber-950 sm:inline">
          Prototype · Phase 2
        </span>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-12 border-t-4 border-indigo-500 bg-slate-900">
      <div className="mx-auto flex max-w-5xl gap-3 px-4 py-6 text-xs leading-relaxed text-slate-300">
        <ShieldCheckIcon size={18} className="mt-0.5 shrink-0 text-emerald-400" />
        <p>
          Your documents are processed only in this browser tab. They are uploaded only if you save them to your vault, and
          then only after being locked on your device, so PageLock cannot read them. Signing sends only hashes to the
          timestamp service, and the sign-off log receives only fingerprints, never wording. PageLock is a prototype: it
          is not legal advice or proof of enforceability.
        </p>
      </div>
    </footer>
  );
}
