"use client";
import { useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
import { baseName, download, readFile } from "@/lib/download";
import { makeSampleAgreement } from "@/lib/demo";
import {
  PrepareResult,
  UnsupportedPdfError,
  groupDocId,
  parseReference,
  preparePdf,
  serializeManifestFile,
  shortFingerprint,
  verifyPdf,
} from "@/lib/pagelock";

function receiptText(r: PrepareResult, name: string) {
  return [
    "PageLock reference receipt",
    "==========================",
    `Document:        ${name}`,
    `Document ID:     ${groupDocId(r.documentId)}`,
    `Pages:           ${r.manifest.body.pageCount}`,
    `Sealed on:       ${r.manifest.body.createdAt}`,
    "",
    "Manifest digest (your trusted reference):",
    r.manifest.manifestDigest,
    "",
    "Sealed PDF SHA-256 (exact file):",
    r.manifest.preparedPdfSha256,
    "",
    "Keep this somewhere the other party cannot change (for example, email it to both founders).",
    "To check a copy later, open PageLock > Verify and paste the manifest digest, or load the reference .json file.",
    "",
    "PageLock shows whether pages changed. It does not prove who signed and is not legal advice.",
    "",
  ].join("\n");
}

export default function CreatePage() {
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PrepareResult | null>(null);
  const [selfCheck, setSelfCheck] = useState<string | null>(null);

  async function seal() {
    if (!file) return;
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const r = await preparePdf(await readFile(file));
      const check = await verifyPdf(r.pdfBytes, { reference: await parseReference(serializeManifestFile(r.manifest)) });
      if (check.outcome !== "REFERENCE MATCH") throw new Error("Self-check failed: the sealed copy did not verify. Nothing was produced.");
      setSelfCheck(check.outcome);
      setResult(r);
    } catch (e) {
      setError(e instanceof UnsupportedPdfError || e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  const name = file ? baseName(file.name) : "document";

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Create a sealed copy</h1>
        <p className="mt-1 text-neutral-600">
          PageLock adds a 1.5-inch band below each page with a QR seal. Your original page content is not moved or covered.
        </p>
      </div>

      <FileDrop
        label="Choose or drop the agreement PDF"
        hint="Up to 25 MB and 300 pages. Plain PDFs only: no form fields, comments or scripts."
        accept="application/pdf,.pdf"
        file={file}
        onFile={(f) => {
          setFile(f);
          setResult(null);
          setError(null);
        }}
      />

      <p className="-mt-4 text-sm text-neutral-600">
        No PDF to hand?{" "}
        <button
          className="font-medium underline"
          onClick={async () => {
            const bytes = await makeSampleAgreement(3);
            setFile(new File([bytes as BlobPart], "sample-founders-agreement.pdf", { type: "application/pdf" }));
            setResult(null);
            setError(null);
          }}
        >
          Use a sample founders&apos; agreement
        </button>
      </p>

      <button
        onClick={seal}
        disabled={!file || busy}
        className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40"
      >
        {busy ? "Sealing…" : "Seal every page"}
      </button>

      {error && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">
          <strong>Could not seal this PDF.</strong> {error}
        </div>
      )}

      {result && (
        <div className="space-y-8">
          <section className="rounded-xl border border-emerald-200 bg-emerald-50 p-5">
            <div className="text-sm font-semibold text-emerald-900">
              Sealed {result.manifest.body.pageCount} page{result.manifest.body.pageCount === 1 ? "" : "s"} · self-check: {selfCheck}
            </div>
            <dl className="mt-3 grid gap-2 text-sm sm:grid-cols-[10rem_1fr]">
              <dt className="text-neutral-600">Document ID</dt>
              <dd className="font-mono">{groupDocId(result.documentId)}</dd>
              <dt className="text-neutral-600">Manifest digest</dt>
              <dd className="break-all font-mono text-xs">{result.manifest.manifestDigest}</dd>
            </dl>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Next steps</h2>
            <ol className="list-decimal space-y-2 pl-5 text-sm text-neutral-800">
              <li>
                <button className="font-medium underline" onClick={() => download(result.pdfBytes, `${name}.pagelock.pdf`, "application/pdf")}>
                  Download the sealed PDF
                </button>{" "}
                and share it with the other founder.
              </li>
              <li>
                <button
                  className="font-medium underline"
                  onClick={() => download(serializeManifestFile(result.manifest), `${name}.pagelock-reference.json`, "application/json")}
                >
                  Download the reference file
                </button>{" "}
                and keep it somewhere safe. This is what proves a copy is genuine later.
              </li>
              <li>
                <button className="font-medium underline" onClick={() => download(receiptText(result, name), `${name}.pagelock-receipt.txt`, "text/plain")}>
                  Download the receipt
                </button>{" "}
                and email it to both founders, so each of you holds an independent copy of the digest.
              </li>
            </ol>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Page fingerprints</h2>
            <table className="w-full text-left text-sm">
              <thead className="text-neutral-500">
                <tr>
                  <th className="py-1 pr-4 font-normal">Page</th>
                  <th className="py-1 pr-4 font-normal">Short fingerprint</th>
                  <th className="py-1 font-normal">Full SHA-256</th>
                </tr>
              </thead>
              <tbody>
                {result.pages.map((p) => (
                  <tr key={p.index} className="border-t border-neutral-200">
                    <td className="py-1.5 pr-4">{p.index}</td>
                    <td className="py-1.5 pr-4 font-mono">{shortFingerprint(p.hash)}</td>
                    <td className="break-all py-1.5 font-mono text-xs text-neutral-500">{p.hash}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <p className="text-xs text-neutral-500">The short fingerprint is for people to compare by eye. The checks always use the full one.</p>
          </section>

          <section className="space-y-3">
            <h2 className="text-lg font-semibold">Preview</h2>
            <PdfPreview bytes={result.pdfBytes} scanTest />
          </section>
        </div>
      )}
    </div>
  );
}
