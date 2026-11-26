"use client";
import { useEffect, useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
import {
  AlertIcon,
  BookIcon,
  CheckCircleIcon,
  ClockIcon,
  DownloadIcon,
  EyeIcon,
  FileIcon,
  InfoIcon,
  KeyIcon,
  LayersIcon,
  PenIcon,
  SearchCheckIcon,
  ShieldCheckIcon,
  SparkIcon,
  SpinnerIcon,
  UsersIcon,
  XCircleIcon,
} from "@/components/icons";
import { Notice, OUTCOME_LOOK, OutcomeBadge, PageHeader, Step, btnPrimary, btnSecondary, card, inputCls } from "@/components/ui";
import { baseName, download, readFile } from "@/lib/download";
import { ActiveService, getService } from "@/lib/service-config";
import { listIdentities } from "@/lib/pagelock/service/keystore";
import { DEMOS, DemoKind, makeDemo } from "@/lib/demo";
import {
  CheckStatus,
  EC_ALG,
  LogCheck,
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

const STATUS: Record<CheckStatus, [string, string, typeof CheckCircleIcon]> = {
  pass: ["Pass", "text-emerald-700 bg-emerald-50 ring-emerald-200", CheckCircleIcon],
  fail: ["Fail", "text-red-700 bg-red-50 ring-red-200", XCircleIcon],
  inconclusive: ["Inconclusive", "text-amber-800 bg-amber-50 ring-amber-200", AlertIcon],
  "not-provided": ["Not provided", "text-slate-600 bg-slate-50 ring-slate-200", InfoIcon],
  "not-available": ["Not yet available", "text-slate-600 bg-slate-50 ring-slate-200", ClockIcon],
};

const h2 = "flex items-center gap-2 text-lg font-bold text-slate-900";

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

  const trustOptions: { key: TrustChoice; Icon: typeof KeyIcon; title: string; text: string }[] = [
    {
      key: "service",
      Icon: ShieldCheckIcon,
      title: svc?.demo ? "PageLock demo authority" : "PageLock founders' certificates",
      text: svc?.demo ? "(this browser only) and the sign-off log" : "and the sign-off log",
    },
    { key: "file", Icon: FileIcon, title: "A trust file", text: "(.pagelock-trust.json)" },
    { key: "none", Icon: LayersIcon, title: "None", text: "(pages only; signatures cannot show who signed)" },
  ];

  return (
    <div className="space-y-8">
      <PageHeader icon={<SearchCheckIcon size={24} />} title="Check a copy">
        Everything happens in this browser. Nothing is uploaded.
      </PageHeader>

      <div className="rounded-2xl border border-indigo-200 bg-gradient-to-br from-indigo-50 to-white p-5 shadow-sm">
        <div className="flex items-center gap-2 font-semibold text-slate-900">
          <SparkIcon size={18} className="text-indigo-600" /> Try a demo
        </div>
        <p className="mt-1 text-sm text-slate-600">
          Loads a sample agreement and its genuine reference file, with or without tampering. Then press Check every page.
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          {(Object.keys(DEMOS) as DemoKind[]).map((k) => (
            <button
              key={k}
              className={`inline-flex items-center gap-1.5 rounded-full border bg-white px-3 py-1.5 text-xs font-medium shadow-sm transition ${
                k === "genuine"
                  ? "border-emerald-300 text-emerald-800 hover:border-emerald-500"
                  : "border-slate-300 text-slate-700 hover:border-red-400 hover:text-red-700"
              }`}
              onClick={async () => {
                const d = await makeDemo(k);
                setPdf(d.pdf);
                setRefFile(d.reference);
                setReport(null);
                setError(null);
              }}
            >
              {k === "genuine" ? <CheckCircleIcon size={14} /> : <AlertIcon size={14} />}
              {DEMOS[k]}
            </button>
          ))}
        </div>
      </div>

      <div className="grid gap-4 md:grid-cols-2">
        <Step n={1} icon={<FileIcon size={18} />} title="The PDF to check" done={!!pdf} className="!space-y-3">
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
        </Step>
        <Step n={2} icon={<KeyIcon size={18} />} title="Your trusted reference" hint="Recommended" done={!!refFile || digest.trim().length > 0} className="!space-y-3">
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
            className={`${inputCls} font-mono !text-xs`}
          />
          {refFile && (
            <button className="text-xs text-slate-500 underline hover:text-slate-800" onClick={() => setRefFile(null)}>
              Remove reference file
            </button>
          )}
        </Step>
      </div>

      <Step n={3} icon={<UsersIcon size={18} />} title="Whose signatures to trust" className="!space-y-3">
        <div className="grid gap-2 sm:grid-cols-3">
          {trustOptions.map(({ key, Icon, title, text }) => (
            <label
              key={key}
              className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 text-sm transition ${
                trustChoice === key ? "border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-200" : "border-slate-200 bg-white hover:border-slate-300"
              }`}
            >
              <input type="radio" className="mt-1" checked={trustChoice === key} onChange={() => setTrustChoice(key)} />
              <span className="min-w-0">
                <span className="flex items-center gap-1.5 font-semibold text-slate-900">
                  <Icon size={16} className="text-indigo-600" /> {title}
                </span>
                <span className="text-slate-500">{text}</span>
                {key === "file" && trustChoice === "file" && (
                  <input
                    type="file"
                    accept=".json,application/json"
                    className="mt-2 block w-full text-xs file:mr-2 file:rounded-lg file:border-0 file:bg-indigo-100 file:px-2.5 file:py-1.5 file:font-medium file:text-indigo-700"
                    onChange={(e) => setTrustFile(e.target.files?.[0] ?? null)}
                  />
                )}
              </span>
            </label>
          ))}
        </div>
      </Step>

      <button onClick={run} disabled={!pdf || busy} className={`${btnPrimary} w-full !py-3.5 !text-base sm:w-auto`}>
        {busy ? <SpinnerIcon size={20} /> : <SearchCheckIcon size={20} />}
        {busy ? "Checking…" : "Check every page"}
      </button>

      {error && <Notice tone="error">{error}</Notice>}

      {report && (
        <div className="space-y-8">
          <section className={`space-y-3 rounded-2xl border p-5 shadow-sm sm:p-6 ${OUTCOME_LOOK[report.outcome].panel}`} data-testid="outcome">
            <OutcomeBadge outcome={report.outcome} size="lg" />
            <div className="text-xl font-bold text-slate-900">{OUTCOME_LOOK[report.outcome].plain}</div>
            <p className="max-w-3xl leading-relaxed text-slate-700">{report.summary}</p>
            {report.documentId && (
              <p className="text-sm text-slate-500">
                Document ID <span className="font-mono font-medium text-slate-700">{groupDocId(report.documentId)}</span>
              </p>
            )}
          </section>

          {report.signatures.length > 0 && (
            <section className="space-y-3" data-testid="signatures">
              <h2 className={h2}>
                <PenIcon size={20} className="text-indigo-600" /> Signatures
              </h2>
              <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white shadow-sm">
                {report.signatures.map((s) => (
                  <li key={s.index} className="flex gap-3 px-5 py-4 text-sm">
                    <span
                      className={`flex h-9 w-9 shrink-0 items-center justify-center rounded-full font-bold ${
                        s.valid ? "bg-emerald-100 text-emerald-700" : "bg-amber-100 text-amber-800"
                      }`}
                    >
                      {s.signerName.trim().charAt(0).toUpperCase() || s.index}
                    </span>
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-semibold text-slate-900">
                          {s.index}. {s.signerName}
                        </span>
                        {s.signerEmail && <span className="text-slate-500">{s.signerEmail}</span>}
                        <span
                          className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-xs font-semibold ring-1 ${
                            s.valid ? "bg-emerald-50 text-emerald-800 ring-emerald-200" : "bg-amber-50 text-amber-900 ring-amber-200"
                          }`}
                        >
                          {s.valid ? <CheckCircleIcon size={12} /> : <AlertIcon size={12} />}
                          {s.valid ? "Valid and trusted" : "Not fully valid"}
                        </span>
                      </div>
                      <div className="flex items-center gap-1.5 text-slate-600">
                        <ClockIcon size={14} className="shrink-0 text-slate-400" />
                        <span>
                          {s.timestampTime ? `Timestamped ${new Date(s.timestampTime).toLocaleString()}` : "No trusted time"} · issued by {s.issuerName}
                        </span>
                      </div>
                      {s.problems.map((p, i) => (
                        <div key={i} className="text-slate-600">
                          {p}
                        </div>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {(log || logNote) && (
            <section className="space-y-3" data-testid="signoff-log">
              <h2 className={h2}>
                <BookIcon size={20} className="text-indigo-600" /> Sign-off log
              </h2>
              {log ? (
                <div className={`${card} space-y-3 text-sm`}>
                  <div className={`flex items-center gap-2 font-semibold ${log.ok ? "text-emerald-800" : "text-red-800"}`}>
                    {log.ok ? <CheckCircleIcon size={18} /> : <XCircleIcon size={18} />}
                    {log.ok ? "Log entries, countersignatures and hash chain are intact." : "Problems found in the log."}
                  </div>
                  {log.signers.length > 0 && (
                    <ol className="space-y-2 border-l-2 border-indigo-100 pl-4">
                      {log.signers.map((s, i) => (
                        <li key={i} className="relative">
                          <span className="absolute -left-[1.42rem] top-1 h-3 w-3 rounded-full bg-indigo-500 ring-4 ring-white" />
                          {i === 0 ? "Signed" : "Double signed"} by <strong>{s.name}</strong> on {new Date(s.at).toLocaleString()}
                        </li>
                      ))}
                    </ol>
                  )}
                  {log.problems.map((p, i) => (
                    <div key={i} className="text-red-800">
                      {p}
                    </div>
                  ))}
                  <div className="text-slate-500">
                    {log.publicSignedOffAt ? `Public record: fingerprint signed off ${new Date(log.publicSignedOffAt).toLocaleString()}.` : "Not yet signed off by everyone."}
                  </div>
                </div>
              ) : (
                <Notice tone="info">{logNote}</Notice>
              )}
            </section>
          )}

          <button
            className={btnSecondary}
            onClick={async () =>
              download(await evidenceReport(report, { fileName: pdf?.name, log }), `${baseName(pdf?.name ?? "document")} - evidence report.pdf`, "application/pdf")
            }
          >
            <DownloadIcon size={16} />
            Download the evidence report (PDF)
          </button>

          <section className="space-y-3">
            <h2 className={h2}>
              <ShieldCheckIcon size={20} className="text-indigo-600" /> Individual checks
            </h2>
            <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white shadow-sm">
              {report.checks.map((c) => {
                const [label, cls, Icon] = STATUS[c.status];
                return (
                  <li key={c.id} className="flex flex-col gap-2 px-5 py-4 sm:flex-row sm:items-start sm:gap-4">
                    <span className={`inline-flex w-fit shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ring-1 sm:w-40 ${cls}`}>
                      <Icon size={14} />
                      {label}
                    </span>
                    <div>
                      <div className="text-sm font-semibold text-slate-900">{c.label}</div>
                      {c.details.map((d, i) => (
                        <div key={i} className="text-sm text-slate-600">
                          {d}
                        </div>
                      ))}
                    </div>
                  </li>
                );
              })}
            </ul>
          </section>

          {report.pages.length > 0 && (
            <section className="space-y-3">
              <h2 className={h2}>
                <LayersIcon size={20} className="text-indigo-600" /> Pages
              </h2>
              <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white shadow-sm">
                <table className="w-full min-w-[32rem] text-left text-sm">
                  <thead className="bg-slate-50 text-xs uppercase tracking-wider text-slate-500">
                    <tr>
                      <th className="px-4 py-2.5 font-semibold">In this file</th>
                      <th className="px-4 py-2.5 font-semibold">Sealed as</th>
                      <th className="px-4 py-2.5 font-semibold">Fingerprint (computed)</th>
                      <th className="px-4 py-2.5 font-semibold">Notes</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.pages.map((p) => (
                      <tr key={p.position} className="border-t border-slate-100 align-top">
                        <td className="px-4 py-2.5 font-medium">{p.position}</td>
                        <td className="px-4 py-2.5">{p.payload ? `${p.payload.index} of ${p.payload.count}` : "—"}</td>
                        <td className="px-4 py-2.5 font-mono">{p.computedHash ? shortFingerprint(p.computedHash) : "—"}</td>
                        <td className={`px-4 py-2.5 ${p.problems.length ? "text-red-700" : "text-emerald-700"}`}>
                          <span className="inline-flex items-start gap-1.5">
                            {p.problems.length ? <XCircleIcon size={16} className="mt-0.5 shrink-0" /> : <CheckCircleIcon size={16} className="mt-0.5 shrink-0" />}
                            <span>{p.problems.length ? p.problems.join(" ") : "OK"}</span>
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </section>
          )}

          {pdfBytes && report.outcome !== "UNABLE TO VERIFY" && (
            <section className="space-y-4">
              <h2 className={h2}>
                <EyeIcon size={20} className="text-indigo-600" /> Preview
              </h2>
              <PdfPreview bytes={pdfBytes} />
            </section>
          )}

          <Notice tone="info">
            Printed copies: a QR code on paper identifies which page it should be, but cannot prove the ink around it was not
            changed. Compare a printed page against the verified original.
          </Notice>
        </div>
      )}
    </div>
  );
}
