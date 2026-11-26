"use client";
import { useEffect, useState } from "react";
import jsQR from "jsqr";
import { FOOTER_HEIGHT, parsePayload } from "@/lib/pagelock";

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
        pdfjs.GlobalWorkerOptions.workerSrc = "/pdf.worker.min.mjs";
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

  if (error) return <p className="text-sm text-neutral-500">{error}</p>;
  return (
    <div className="grid grid-cols-2 gap-4 sm:grid-cols-3">
      {pages.map((p, i) => (
        <figure key={i} className="space-y-1">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src={p.url} alt={`Page ${i + 1}`} className="w-full rounded border border-neutral-200 bg-white shadow-sm" />
          <figcaption className="flex justify-between text-xs text-neutral-500">
            <span>Page {i + 1}</span>
            {p.scan === "ok" && <span className="text-emerald-700">QR scan test: readable</span>}
            {p.scan === "unreadable" && <span className="text-amber-700">QR scan test: not readable</span>}
            {p.scan === "not-pagelock" && <span className="text-red-700">QR is not a PageLock code</span>}
          </figcaption>
        </figure>
      ))}
    </div>
  );
}
