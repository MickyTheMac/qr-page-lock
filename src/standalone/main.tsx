// Single-file build of PageLock (same screens and protocol code as the Next.js app).
import { createRoot } from "react-dom/client";
import { useEffect, useState } from "react";
import { SiteFooter, SiteHeader } from "@/components/SiteChrome";
import Home from "@/app/page";
import CreatePage from "@/app/create/page";
import VerifyPage from "@/app/verify/page";
import SignPage from "@/app/sign/page";
import VaultPage from "@/app/vault/page";

const workerText = document.getElementById("pdf-worker")?.textContent;
if (workerText) {
  (globalThis as Record<string, unknown>).__PAGELOCK_PDF_WORKER__ = URL.createObjectURL(
    new Blob([workerText], { type: "text/javascript" }),
  );
}

type View = "home" | "create" | "sign" | "verify" | "vault";
const viewFromHash = (): View => {
  const h = location.hash.replace("#", "");
  return h === "create" || h === "sign" || h === "verify" || h === "vault" ? h : "home";
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
  return (
    <div className="min-h-full flex flex-col font-sans">
      <SiteHeader active={view} />
      <main className="mx-auto w-full max-w-5xl flex-1 px-4 py-8 sm:py-10">
        {view === "home" && <Home />}
        {view === "create" && <CreatePage />}
        {view === "sign" && <SignPage />}
        {view === "verify" && <VerifyPage />}
        {view === "vault" && <VaultPage />}
      </main>
      <SiteFooter />
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
