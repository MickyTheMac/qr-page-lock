"use client";
import { useEffect, useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
import { baseName, download, readFile } from "@/lib/download";
import { ActiveService, getService } from "@/lib/service-config";
import { listIdentities } from "@/lib/pagelock/service/keystore";
import { DEMOS, DemoKind, makeDemo } from "@/lib/demo";
import {
  CheckStatus,
  EC_ALG,
  LogCheck,
  Outcome,
  ParsedReference,
  TrustProfile,
  VerifyReport,
  b64decode,
  checkDocumentLog,
  evidenceReport,
  groupDocId,
  parseReference,
  parseTrustFile,
  shortFingerprint,
  subtle,
  verifyPdf,
} from "@/lib/pagelock";

type TrustChoice = "service" | "file" | "none";
type LogView = (LogCheck & { publicSignedOffAt?: string | null }) | null;

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
  const [svc, setSvc] = useState<ActiveService | null>(null);
  const [trustChoice, setTrustChoice] = useState<TrustChoice>("service");
  const [trustFile, setTrustFile] = useState<File | null>(null);
  const [log, setLog] = useState<LogView>(null);
  const [logNote, setLogNote] = useState<string | null>(null);
  useEffect(() => {
    getService().then(setSvc);
  }, []);

  async function loadLog(r: VerifyReport) {
    setLog(null);
    setLogNote(null);
    if (!svc || !r.manifestDigest) return;
    try {
      const pub = await svc.client.publicStatus(r.manifestDigest);
      const mine = await listIdentities(svc.url);
      let view: LogView = null;
      for (const id of mine) {
        try {
          const res = await svc.client.readSignOff(r.manifestDigest, id);
          if (!res.entries.length) continue;
          const key = await subtle().importKey("spki", b64decode(res.logPublicKey) as BufferSource, EC_ALG, false, ["verify"]);
          view = await checkDocumentLog(res.entries, key, r.manifestDigest, r.requiredSigners);
          break;
        } catch {
          /* this identity cannot read it */
        }
      }
      if (view) setLog({ ...view, publicSignedOffAt: pub.signedOffAt });
      else
        setLogNote(
          pub.signedOff
            ? `Public record: this document's fingerprint was signed off on ${new Date(pub.signedOffAt!).toLocaleString()}. (Only the founders can see who signed.)`
            : "No completed sign-off is recorded for this fingerprint.",
        );
    } catch (e) {
      setLogNote(e instanceof Error ? `Sign-off log not checked: ${e.message}` : "Sign-off log not checked.");
    }
  }

  async function run() {
    if (!pdf) return;
    setBusy(true);
    setError(null);
    setReport(null);
    try {
      let reference: ParsedReference | null = null;
      if (refFile) reference = await parseReference(await refFile.text());
      else if (digest.trim()) reference = await parseReference(digest);
      let trust: TrustProfile | null = null;
      if (trustChoice === "service" && svc) trust = await svc.client.trust();
      if (trustChoice === "file") {
        if (!trustFile) throw new Error("Choose a trust file, or pick another option.");
        trust = parseTrustFile(await trustFile.text());
      }
      const bytes = await readFile(pdf);
      setPdfBytes(bytes);
      const r = await verifyPdf(bytes, { reference, trust });
      setReport(r);
      if (trustChoice === "service") await loadLog(r);
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

      <div className="space-y-2">
        <div className="text-sm font-medium">3. Whose signatures to trust</div>
        <div className="flex flex-col gap-1.5 text-sm">
          <label className="flex items-center gap-2">
            <input type="radio" checked={trustChoice === "service"} onChange={() => setTrustChoice("service")} />
            {svc?.demo ? "PageLock demo authority (this browser only)" : "PageLock founders' certificates"} and the sign-off log
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={trustChoice === "file"} onChange={() => setTrustChoice("file")} />
            A trust file (.pagelock-trust.json)
            {trustChoice === "file" && <input type="file" accept=".json,application/json" className="text-xs" onChange={(e) => setTrustFile(e.target.files?.[0] ?? null)} />}
          </label>
          <label className="flex items-center gap-2">
            <input type="radio" checked={trustChoice === "none"} onChange={() => setTrustChoice("none")} />
            None (pages only; signatures cannot show who signed)
          </label>
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

          {report.signatures.length > 0 && (
            <section className="space-y-2" data-testid="signatures">
              <h2 className="text-lg font-semibold">Signatures</h2>
              <ul className="divide-y divide-neutral-200 rounded-xl border border-neutral-200 bg-white">
                {report.signatures.map((s) => (
                  <li key={s.index} className="px-4 py-3 text-sm">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="font-medium">
                        {s.index}. {s.signerName}
                      </span>
                      {s.signerEmail && <span className="text-neutral-500">{s.signerEmail}</span>}
                      <span className={`rounded px-2 py-0.5 text-xs font-semibold ${s.valid ? "bg-emerald-100 text-emerald-800" : "bg-amber-100 text-amber-900"}`}>
                        {s.valid ? "Valid and trusted" : "Not fully valid"}
                      </span>
                    </div>
                    <div className="text-neutral-600">
                      {s.timestampTime ? `Timestamped ${new Date(s.timestampTime).toLocaleString()}` : "No trusted time"} · issued by {s.issuerName}
                    </div>
                    {s.problems.map((p, i) => (
                      <div key={i} className="text-neutral-600">
                        {p}
                      </div>
                    ))}
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(log || logNote) && (
            <section className="space-y-2" data-testid="signoff-log">
              <h2 className="text-lg font-semibold">Sign-off log</h2>
              {log ? (
                <div className="rounded-xl border border-neutral-200 bg-white p-4 text-sm">
                  <div className={log.ok ? "text-emerald-800" : "text-red-800"}>
                    {log.ok ? "Log entries, countersignatures and hash chain are intact." : "Problems found in the log."}
                  </div>
                  {log.signers.map((s, i) => (
                    <div key={i}>
                      {i === 0 ? "Signed" : "Double signed"} by {s.name} on {new Date(s.at).toLocaleString()}
                    </div>
                  ))}
                  {log.problems.map((p, i) => (
                    <div key={i} className="text-red-800">
                      {p}
                    </div>
                  ))}
                  <div className="mt-1 text-neutral-500">
                    {log.publicSignedOffAt ? `Public record: fingerprint signed off ${new Date(log.publicSignedOffAt).toLocaleString()}.` : "Not yet signed off by everyone."}
                  </div>
                </div>
              ) : (
                <p className="text-sm text-neutral-700">{logNote}</p>
              )}
            </section>
          )}

          <button
            className="rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:border-neutral-900"
            onClick={async () =>
              download(await evidenceReport(report, { fileName: pdf?.name, log }), `${baseName(pdf?.name ?? "document")} - evidence report.pdf`, "application/pdf")
            }
          >
            Download the evidence report (PDF)
          </button>

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
