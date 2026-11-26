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
    <header className="sticky top-0 z-20 border-b border-slate-200/80 bg-white/85 backdrop-blur">
      <nav className="mx-auto flex max-w-5xl items-center gap-1 px-4 py-2.5 sm:gap-2">
        <Link href="/" className="mr-2 flex items-center gap-2 font-bold tracking-tight text-slate-900 sm:mr-4">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br from-indigo-500 to-indigo-700 text-white shadow-sm shadow-indigo-600/30">
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
              active === key ? "bg-indigo-50 text-indigo-700" : "text-slate-600 hover:bg-slate-100 hover:text-slate-900"
            }`}
          >
            <Icon size={17} />
            {label}
          </Link>
        ))}
        <span className="ml-auto hidden rounded-full bg-amber-100 px-2.5 py-1 text-xs font-semibold text-amber-900 ring-1 ring-amber-200 sm:inline">
          Prototype · Phase 2
        </span>
      </nav>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-8 border-t border-slate-200 bg-white">
      <div className="mx-auto flex max-w-5xl gap-3 px-4 py-6 text-xs leading-relaxed text-slate-500">
        <ShieldCheckIcon size={18} className="mt-0.5 shrink-0 text-slate-400" />
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
