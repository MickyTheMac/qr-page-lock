"use client";
import { useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
import { DownloadIcon, EyeIcon, FileSealIcon, KeyIcon, QrIcon, ReceiptIcon, SparkIcon, SpinnerIcon, UploadIcon } from "@/components/icons";
import { Notice, PageHeader, Step, btnPrimary, card, linkBtn } from "@/components/ui";
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

  const downloads = result
    ? [
        {
          Icon: FileSealIcon,
          label: "Download the sealed PDF",
          text: "Share this with the other founder.",
          go: () => download(result.pdfBytes, `${name}.pagelock.pdf`, "application/pdf"),
          primary: true,
        },
        {
          Icon: KeyIcon,
          label: "Download the reference file",
          text: "Keep it somewhere safe. This is what proves a copy is genuine later.",
          go: () => download(serializeManifestFile(result.manifest), `${name}.pagelock-reference.json`, "application/json"),
        },
        {
          Icon: ReceiptIcon,
          label: "Download the receipt",
          text: "Email it to both founders, so each of you holds an independent copy of the digest.",
          go: () => download(receiptText(result, name), `${name}.pagelock-receipt.txt`, "text/plain"),
        },
      ]
    : [];

  return (
    <div className="space-y-8">
      <PageHeader icon={<FileSealIcon size={24} />} title="Create a sealed copy">
        PageLock adds a slim (about 1.14-inch) band below each page with a QR seal. Your original page content is not moved or covered.
      </PageHeader>

      <Step n={1} icon={<UploadIcon size={18} />} title="Choose the agreement" hint="A PDF on this device. It is never uploaded." done={!!file}>
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
        <p className="flex items-center gap-1.5 text-sm text-slate-600">
          <SparkIcon size={16} className="text-indigo-500" />
          No PDF to hand?{" "}
          <button
            className={linkBtn}
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
      </Step>

      <Step n={2} icon={<QrIcon size={18} />} title="Seal every page" hint="Adds a QR seal to each page and checks the result straight away." done={!!result}>
        <button onClick={seal} disabled={!file || busy} className={`${btnPrimary} w-full sm:w-auto`}>
          {busy ? <SpinnerIcon size={18} /> : <QrIcon size={18} />}
          {busy ? "Sealing…" : "Seal every page"}
        </button>
        {error && (
          <Notice tone="error" title="Could not seal this PDF.">
            {error}
          </Notice>
        )}
      </Step>

      {result && (
        <div className="space-y-8">
          <section className="rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm sm:p-6">
            <div className="flex items-start gap-3">
              <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-emerald-500 text-white">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                  <path d="M5 12l5 5 9-10" />
                </svg>
              </span>
              <div className="min-w-0">
                <div className="text-lg font-bold text-emerald-950">All sealed</div>
                <div className="text-sm font-medium text-emerald-800">
                  Sealed {result.manifest.body.pageCount} page{result.manifest.body.pageCount === 1 ? "" : "s"} · self-check: {selfCheck}
                </div>
              </div>
            </div>
            <dl className="mt-4 grid gap-x-4 gap-y-2 rounded-xl bg-white/70 p-4 text-sm ring-1 ring-emerald-100 sm:grid-cols-[10rem_1fr]">
              <dt className="text-slate-500">Document ID</dt>
              <dd className="font-mono font-semibold text-slate-900">{groupDocId(result.documentId)}</dd>
              <dt className="text-slate-500">Manifest digest</dt>
              <dd className="break-all font-mono text-xs text-slate-700">{result.manifest.manifestDigest}</dd>
            </dl>
          </section>

          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <DownloadIcon size={20} className="text-indigo-600" /> Next steps
            </h2>
            <ol className="grid gap-3 sm:grid-cols-3">
              {downloads.map(({ Icon, label, text, go, primary }, i) => (
                <li key={label} className={`${card} flex flex-col gap-3 !p-5`}>
                  <div className="flex items-center gap-3">
                    <span className={`flex h-10 w-10 items-center justify-center rounded-xl ${primary ? "bg-indigo-600 text-white" : "bg-indigo-50 text-indigo-600"}`}>
                      <Icon size={20} />
                    </span>
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">Step {i + 1}</span>
                  </div>
                  <p className="flex-1 text-sm text-slate-600">{text}</p>
                  <button
                    className={
                      primary
                        ? `${btnPrimary} !py-2.5`
                        : "inline-flex items-center justify-center gap-2 rounded-xl border border-slate-300 bg-white px-4 py-2.5 text-sm font-semibold text-slate-800 transition hover:border-indigo-400 hover:text-indigo-700"
                    }
                    onClick={go}
                  >
                    <DownloadIcon size={16} />
                    {label}
                  </button>
                </li>
              ))}
            </ol>
          </section>

          <section className={`${card} space-y-3`}>
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <KeyIcon size={20} className="text-indigo-600" /> Page fingerprints
            </h2>
            <div className="-mx-1 overflow-x-auto px-1">
              <table className="w-full text-left text-sm">
                <thead className="text-xs uppercase tracking-wider text-slate-400">
                  <tr>
                    <th className="py-2 pr-4 font-semibold">Page</th>
                    <th className="py-2 pr-4 font-semibold">Short fingerprint</th>
                    <th className="hidden py-2 font-semibold sm:table-cell">Full SHA-256</th>
                  </tr>
                </thead>
                <tbody>
                  {result.pages.map((p) => (
                    <tr key={p.index} className="border-t border-slate-100">
                      <td className="py-2 pr-4 font-medium">{p.index}</td>
                      <td className="py-2 pr-4">
                        <span className="rounded-md bg-indigo-50 px-2 py-0.5 font-mono text-indigo-800">{shortFingerprint(p.hash)}</span>
                      </td>
                      <td className="hidden break-all py-2 font-mono text-xs text-slate-500 sm:table-cell">{p.hash}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="text-xs text-slate-500">The short fingerprint is for people to compare by eye. The checks always use the full one.</p>
          </section>

          <section className="space-y-4">
            <h2 className="flex items-center gap-2 text-lg font-bold text-slate-900">
              <EyeIcon size={20} className="text-indigo-600" /> Preview
            </h2>
            <PdfPreview bytes={result.pdfBytes} scanTest />
          </section>
        </div>
      )}
    </div>
  );
}
