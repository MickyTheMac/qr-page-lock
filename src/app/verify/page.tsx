"use client";
import { useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
import { readFile } from "@/lib/download";
import { DEMOS, DemoKind, makeDemo } from "@/lib/demo";
import { CheckStatus, Outcome, ParsedReference, VerifyReport, groupDocId, parseReference, shortFingerprint, verifyPdf } from "@/lib/pagelock";

const OUTCOME_STYLE: Record<Outcome, string> = {
  VERIFIED: "bg-emerald-600 text-white",
  "REFERENCE MATCH": "bg-emerald-500 text-white",
  "INTERNALLY CONSISTENT": "bg-sky-600 text-white",
  "ALTERED / INVALID": "bg-red-600 text-white",
  "UNABLE TO VERIFY": "bg-neutral-600 text-white",
};

const STATUS: Record<CheckStatus, [string, string]> = {
  pass: ["Pass", "text-emerald-700 bg-emerald-50 border-emerald-200"],
  fail: ["Fail", "text-red-700 bg-red-50 border-red-200"],
  inconclusive: ["Inconclusive", "text-amber-800 bg-amber-50 border-amber-200"],
  "not-provided": ["Not provided", "text-neutral-600 bg-neutral-50 border-neutral-200"],
  "not-available": ["Not yet available", "text-neutral-600 bg-neutral-50 border-neutral-200"],
};

export default function VerifyPage() {
  const [pdf, setPdf] = useState<File | null>(null);
  const [pdfBytes, setPdfBytes] = useState<Uint8Array | null>(null);
  const [refFile, setRefFile] = useState<File | null>(null);
  const [digest, setDigest] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);

  async function run() {
    if (!pdf) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      let reference: ParsedReference | null = null;
      if (refFile) reference = await parseReference(await refFile.text());
      else if (digest.trim()) reference = await parseReference(digest);
      const bytes = await readFile(pdf);
      setPdfBytes(bytes);
      setReport(await verifyPdf(bytes, { reference }));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-8">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Check a copy</h1>
        <p className="mt-1 text-neutral-600">Everything happens in this browser. Nothing is uploaded.</p>
      </div>

      <div className="rounded-xl border border-neutral-200 bg-white p-4">
        <div className="text-sm font-medium">Try a demo</div>
        <p className="mt-1 text-sm text-neutral-600">
          Loads a sample agreement and its genuine reference file, with or without tampering. Then press Check every page.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(DEMOS) as DemoKind[]).map((k) => (
            <button
              key={k}
              className="rounded-full border border-neutral-300 px-3 py-1 text-xs hover:border-neutral-900"
              onClick={async () => {
                const d = await makeDemo(k);
                setPdf(d.pdf);
                setRefFile(d.reference);
                setReport(null);
                setError(null);
              }}
            >
              {DEMOS[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 sm:grid-cols-2">
        <div className="space-y-2">
          <div className="text-sm font-medium">1. The PDF to check</div>
          <FileDrop
            label="Choose or drop the sealed PDF"
            hint="The copy you received or found"
            accept="application/pdf,.pdf"
            file={pdf}
            onFile={(f) => {
              setPdf(f);
              setReport(null);
            }}
          />
        </div>
        <div className="space-y-2">
          <div className="text-sm font-medium">2. Your trusted reference (recommended)</div>
          <FileDrop
            label="Choose the reference .json you kept"
            hint="Or paste the manifest digest below"
            accept="application/json,.json"
            file={refFile}
            onFile={(f) => {
              setRefFile(f);
              setReport(null);
            }}
          />
          <input
            value={digest}
            onChange={(e) => setDigest(e.target.value)}
            disabled={!!refFile}
            placeholder="…or paste the 64-character manifest digest from your receipt"
            className="w-full rounded-lg border border-neutral-300 bg-white px-3 py-2 font-mono text-xs disabled:opacity-40"
          />
          {refFile && (
            <button className="text-xs text-neutral-500 underline" onClick={() => setRefFile(null)}>
              Remove reference file
            </button>
          )}
        </div>
      </div>

      <button onClick={run} disabled={!pdf || busy} className="rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40">
        {busy ? "Checking…" : "Check every page"}
      </button>

      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div>}

      {report && (
        <div className="space-y-8">
          <section className="space-y-3" data-testid="outcome">
            <div className={`inline-block rounded-lg px-4 py-2 text-lg font-semibold tracking-wide ${OUTCOME_STYLE[report.outcome]}`}>
              {report.outcome}
            </div>
            <p className="max-w-3xl text-neutral-800">{report.summary}</p>
            {report.documentId && (
              <p className="text-sm text-neutral-500">
                Document ID <span className="font-mono">{groupDocId(report.documentId)}</span>
              </p>
            )}
          </section>

          <section className="space-y-2">
            <h2 className="text-lg font-semibold">Individual checks</h2>
            <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
              {report.checks.map((c) => (
                <li key={c.id} className="flex flex-col gap-1 px-4 py-3 sm:flex-row sm:items-start sm:gap-4">
                  <span className={`w-36 shrink-0 rounded border px-2 py-0.5 text-center text-xs font-semibold ${STATUS[c.status][1]}`}>
                    {STATUS[c.status][0]}
                  </span>
                  <div>
                    <div className="text-sm font-medium">{c.label}</div>
                    {c.details.map((d, i) => (
                      <div key={i} className="text-sm text-neutral-600">
                        {d}
                      </div>
                    ))}
                  </div>
                </li>
              ))}
            </ul>
          </section>

          {report.pages.length > 0 && (
            <section className="space-y-2">
              <h2 className="text-lg font-semibold">Pages</h2>
              <table className="w-full text-left text-sm">
                <thead className="text-neutral-500">
                  <tr>
                    <th className="py-1 pr-4 font-normal">In this file</th>
                    <th className="py-1 pr-4 font-normal">Sealed as</th>
                    <th className="py-1 pr-4 font-normal">Fingerprint (computed)</th>
                    <th className="py-1 font-normal">Notes</th>
                  </tr>
                </thead>
                <tbody>
                  {report.pages.map((p) => (
                    <tr key={p.position} className="border-t border-neutral-200 align-top">
                      <td className="py-1.5 pr-4">{p.position}</td>
                      <td className="py-1.5 pr-4">{p.payload ? `${p.payload.index} of ${p.payload.count}` : "—"}</td>
                      <td className="py-1.5 pr-4 font-mono">{p.computedHash ? shortFingerprint(p.computedHash) : "—"}</td>
                      <td className={`py-1.5 ${p.problems.length ? "text-red-700" : "text-emerald-700"}`}>
                        {p.problems.length ? p.problems.join(" ") : "OK"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          )}

          {pdfBytes && report.outcome !== "UNABLE TO VERIFY" && (
            <section className="space-y-3">
              <h2 className="text-lg font-semibold">Preview</h2>
              <PdfPreview bytes={pdfBytes} />
            </section>
          )}

          <p className="text-xs text-neutral-500">
            Printed copies: a QR code on paper identifies which page it should be, but cannot prove the ink around it
            was not changed. Compare a printed page against the verified original.
          </p>
        </div>
      )}
    </div>
  );
}
