import type { Metadata } from "next";
import Link from "next/link";
import "./globals.css";

export const metadata: Metadata = {
  title: "PageLock — every page accounted for",
  description: "Make multi-page agreements tamper-evident. Runs entirely in your browser.",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className="h-full antialiased">
      <body className="min-h-full flex flex-col font-sans">
        <header className="border-b border-neutral-200 bg-white">
          <nav className="mx-auto flex max-w-5xl items-center gap-6 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-xs text-white">PL</span>
              PageLock
            </Link>
            <Link href="/create/" className="text-sm text-neutral-600 hover:text-neutral-900">Create</Link>
            <Link href="/sign/" className="text-sm text-neutral-600 hover:text-neutral-900">Sign</Link>
            <Link href="/verify/" className="text-sm text-neutral-600 hover:text-neutral-900">Verify</Link>
            <span className="ml-auto rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900">Prototype · Phase 2</span>
          </nav>
        </header>
        <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">{children}</main>
        <footer className="border-t border-neutral-200 bg-white">
          <div className="mx-auto max-w-5xl px-4 py-4 text-xs leading-relaxed text-neutral-500">
            Your documents are processed only in this browser tab and are never uploaded. Signing sends only hashes to the
            timestamp service, and the sign-off log receives only fingerprints, never wording. PageLock is a prototype:
            it is not legal advice or proof of enforceability.
          </div>
        </footer>
      </body>
    </html>
  );
}
