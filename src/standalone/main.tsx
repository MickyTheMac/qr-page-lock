// Single-file build of PageLock (same screens and protocol code as the Next.js app).
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import Link from "./link-shim";
import Home from "@/app/page";
import CreatePage from "@/app/create/page";
import VerifyPage from "@/app/verify/page";

const workerText = document.getElementById("pdf-worker")?.textContent;
if (workerText) {
  (globalThis as Record<string, unknown>).__PAGELOCK_PDF_WORKER__ = URL.createObjectURL(
    new Blob([workerText], { type: "text/javascript" }),
  );
}

type View = "home" | "create" | "verify";
const viewFromHash = (): View => {
  const h = location.hash.replace("#", "");
  return h === "create" || h === "verify" ? h : "home";
};

function App() {
  const [view, setView] = useState<View>(viewFromHash);
  useEffect(() => {
    const on = () => {
      setView(viewFromHash());
      window.scrollTo(0, 0);
    };
    window.addEventListener("hashchange", on);
    return () => window.removeEventListener("hashchange", on);
  }, []);
  const tab = (v: View) => `text-sm ${view === v ? "font-medium text-neutral-900" : "text-neutral-600 hover:text-neutral-900"}`;
  return (
    <div className="min-h-full flex flex-col font-sans">
      <header className="border-b border-neutral-200 bg-white">
        <nav className="mx-auto flex max-w-5xl flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
          <Link href="/" className="flex items-center gap-2 font-semibold tracking-tight">
            <span className="inline-flex h-7 w-7 items-center justify-center rounded-md bg-neutral-900 text-xs text-white">PL</span>
            PageLock
          </Link>
          <Link href="/create/" className={tab("create")}>Create</Link>
          <Link href="/verify/" className={tab("verify")}>Verify</Link>
          <span className="ml-auto rounded-full bg-amber-100 px-2.5 py-0.5 text-xs font-medium text-amber-900">Prototype · Phase 1</span>
        </nav>
      </header>
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8">
        {view === "home" && <Home />}
        {view === "create" && <CreatePage />}
        {view === "verify" && <VerifyPage />}
      </main>
      <footer className="border-t border-neutral-200 bg-white">
        <div className="mx-auto max-w-5xl px-4 py-4 text-xs leading-relaxed text-neutral-500">
          Your documents are processed only in this browser tab. Nothing is uploaded, stored or tracked. PageLock is a
          prototype: it shows whether pages were changed, not who signed, and it is not legal advice or proof of
          enforceability.
        </div>
      </footer>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
