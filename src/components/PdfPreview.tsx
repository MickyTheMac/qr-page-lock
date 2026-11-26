"use client";
import { useEffect, useState } from "react";
import jsQR from "jsqr";
import { FOOTER_HEIGHT, parsePayload } from "@/lib/pagelock";
import { AlertIcon, CheckCircleIcon, SpinnerIcon, XCircleIcon } from "./icons";

interface Rendered {
  url: string;
  scan?: "ok" | "unreadable" | "not-pagelock";
}

const SCALE = 2; // ~144 dpi: roughly what a phone camera sees on a printed page

/**
 * Renders pages with the pinned PDF.js build (scripting and XFA off), and optionally runs a
 * "scan test": reads the QR code from the rendered pixels, the way a camera would.
 */
export function PdfPreview({ bytes, scanTest = false }: { bytes: Uint8Array; scanTest?: boolean }) {
  const [pages, setPages] = useState<Rendered[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const pdfjs = await import("pdfjs-dist");
        pdfjs.GlobalWorkerOptions.workerSrc =
          ((globalThis as Record<string, unknown>).__PAGELOCK_PDF_WORKER__ as string | undefined) ?? "/pdf.worker.min.mjs";
        const task = pdfjs.getDocument({ data: bytes.slice(), enableXfa: false, stopAtErrors: true });
        const pdf = await task.promise;
        const out: Rendered[] = [];
        for (let i = 1; i <= pdf.numPages && !cancelled; i++) {
          const page = await pdf.getPage(i);
          const viewport = page.getViewport({ scale: SCALE });
          const canvas = document.createElement("canvas");
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          await page.render({ canvas, viewport }).promise;
          const r: Rendered = { url: canvas.toDataURL("image/png") };
          if (scanTest) {
            const ctx = canvas.getContext("2d")!;
            const h = Math.ceil(FOOTER_HEIGHT * SCALE);
            const img = ctx.getImageData(0, canvas.height - h, canvas.width, h);
            const code = jsQR(img.data, img.width, img.height);
            r.scan = !code ? "unreadable" : parsePayload(code.data) ? "ok" : "not-pagelock";
          }
          out.push(r);
          if (!cancelled) setPages([...out]);
        }
        await task.destroy();
      } catch {
        if (!cancelled) setError("The preview could not be drawn. The check results above do not depend on it.");
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [bytes, scanTest]);

  if (error) return <p className="text-sm text-slate-500">{error}</p>;
  if (!pages.length)
    return (
      <p className="flex items-center gap-2 text-sm text-slate-500">
        <SpinnerIcon size={16} /> Drawing the pages…
      </p>
    );
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {pages.map((p, i) => (
        <figure key={i} className="space-y-2">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.url} alt={`Page ${i + 1}`} className="w-full rounded-lg border border-slate-200 bg-white shadow-md" />
          <figcaption className="flex flex-wrap items-center justify-between gap-1 text-xs text-slate-500">
            <span className="font-medium text-slate-700">Page {i + 1}</span>
            {p.scan === "ok" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 px-2 py-0.5 text-emerald-700 ring-1 ring-emerald-200">
                <CheckCircleIcon size={12} />
                QR scan test: readable
              </span>
            )}
            {p.scan === "unreadable" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-amber-50 px-2 py-0.5 text-amber-800 ring-1 ring-amber-200">
                <AlertIcon size={12} />
                QR scan test: not readable
              </span>
            )}
            {p.scan === "not-pagelock" && (
              <span className="inline-flex items-center gap-1 rounded-full bg-red-50 px-2 py-0.5 text-red-700 ring-1 ring-red-200">
                <XCircleIcon size={12} />
                QR is not a PageLock code
              </span>
            )}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
