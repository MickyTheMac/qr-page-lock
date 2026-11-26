"use client";
import { useEffect, useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
import { BookIcon, CheckCircleIcon, DownloadIcon, EyeIcon, FileIcon, HandshakeIcon, MailIcon, PenIcon, SparkIcon, SpinnerIcon, UserIcon, UsersIcon } from "@/components/icons";
import { Notice, PageHeader, Step, btnPrimary, btnSecondary, inputCls, linkBtn } from "@/components/ui";
import { baseName, download, readFile } from "@/lib/download";
import { makeDemo } from "@/lib/demo";
import { ActiveService, getService } from "@/lib/service-config";
import {
  Identity,
  VerifyReport,
  addSignature,
  certFingerprint,
  consentStatement,
  groupDocId,
  makeSubmission,
  nameInfo,
  sha256Hex,
  shortFingerprint,
  verifyPdf,
} from "@/lib/pagelock";
import { listIdentities, saveIdentity } from "@/lib/pagelock/service/keystore";

type Id = Identity & { id: string };


function who(i: Identity) {
  const n = nameInfo(i.certificate.subject);
  return { name: n.commonName ?? n.text, email: n.email ?? "" };
}

export default function SignPage() {
  const [svc, setSvc] = useState<ActiveService | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [bytes, setBytes] = useState<Uint8Array | null>(null);
  const [report, setReport] = useState<VerifyReport | null>(null);
  const [ids, setIds] = useState<Id[]>([]);
  const [chosen, setChosen] = useState<string | null>(null);
  const [enrol, setEnrol] = useState({ name: "", email: "", code: "", pending: null as null | { id: string; keys: CryptoKeyPair; demoCode?: string } });
  const [readAll, setReadAll] = useState(false);
  const [agree, setAgree] = useState(false);
  const [signed, setSigned] = useState<Uint8Array | null>(null);
  const [logMsg, setLogMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getService().then(async (s) => {
      setSvc(s);
      const l = await listIdentities(s.url);
      setIds(l);
      if (l.length === 1) setChosen(l[0].id);
    });
  }, []);

  const me = ids.find((i) => i.id === chosen) ?? null;
  const [alreadySigned, setAlreadySigned] = useState(false);
  useEffect(() => {
    (async () => {
      if (!me || !report) return setAlreadySigned(false);
      const fp = await certFingerprint(me.certificate);
      setAlreadySigned(report.signatures.some((s) => s.certificateSha256 === fp));
    })();
  }, [me, report]);

  async function run<T>(label: string, fn: () => Promise<T>) {
    setBusy(label);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setBusy(null);
    }
  }

  async function load(f: File) {
    setFile(f);
    setSigned(null);
    setLogMsg(null);
    setReadAll(false);
    setAgree(false);
    await run("Checking the document…", async () => {
      const b = await readFile(f);
      setBytes(b);
      const trust = await svc!.client.trust();
      setReport(await verifyPdf(b, { trust }));
    });
  }

  const usable = report && report.outcome !== "ALTERED / INVALID" && report.outcome !== "UNABLE TO VERIFY" && report.documentId && report.manifestDigest;
  const consent = usable ? { documentId: report!.documentId!, manifestDigest: report!.manifestDigest!, pageCount: report!.pageCount } : null;

  async function sign() {
    if (!me || !consent || !bytes || !svc) return;
    await run("Signing…", async () => {
      const out = await addSignature(bytes, { signer: me, consent: { ...consent, accepted: readAll && agree }, timestamp: svc.client.timestampSource() });
      const check = await verifyPdf(out, { trust: await svc.client.trust() });
      if (check.outcome === "ALTERED / INVALID" || check.outcome === "UNABLE TO VERIFY")
        throw new Error("Self-check failed after signing, so nothing was produced. Please report this.");
      setSigned(out);
    });
  }

  async function record() {
    if (!me || !consent || !signed || !svc) return;
    await run("Recording your sign-off…", async () => {
      const view = await svc.client.readSignOff(consent.manifestDigest, me);
      const counterSigns = view.pendingCountersign ?? view.entries[view.entries.length - 1]?.entryHash ?? null;
      const sub = await makeSubmission({ ...consent, signedPdfSha256: await sha256Hex(signed), counterSigns }, me, me.certificatePem);
      const r = await svc.client.recordSignOff(sub);
      setLogMsg(
        r.complete
          ? `Double signed. The sign-off is complete as of ${new Date(r.signedOffAt!).toLocaleString()}. The public record now shows only this document's fingerprint and that time.`
          : "Signed once. Your sign-off is in the private log. Send the signed PDF to the other founder: when they sign and record theirs, it countersigns yours.",
      );
    });
  }

  async function startEnrol() {
    if (!svc) return;
    await run("Sending your code…", async () => {
      const r = await svc.client.startEnrolment(enrol.name, enrol.email);
      setEnrol((e) => ({ ...e, code: r.demoCode ?? "", pending: { id: r.enrolmentId, keys: r.keys, demoCode: r.demoCode } }));
    });
  }

  async function finishEnrol() {
    if (!svc || !enrol.pending) return;
    await run("Issuing your certificate…", async () => {
      const ident = await svc.client.finishEnrolment(enrol.pending!.id, enrol.code, enrol.pending!.keys);
      const id = `${ident.serviceUrl}|${await certFingerprint(ident.certificate)}`;
      try {
        await saveIdentity(ident);
      } catch {
        /* storage unavailable: keep it for this visit only */
      }
      setIds((l) => [...l, { ...ident, id }]);
      setChosen(id);
      setEnrol({ name: "", email: "", code: "", pending: null });
    });
  }

  return (
    <div className="space-y-8">
      <PageHeader tone="violet" icon={<PenIcon size={24} />} title="Sign the agreement">
        Each founder signs the same sealed PDF, one after the other. Your signing key is made and kept in this browser; it
        never leaves your device.
      </PageHeader>
      {svc?.demo && (
        <Notice tone="warn" title="Demo mode">
          Certificates come from a demo authority that runs inside this browser, and email codes are shown on screen. Good
          for trying it out (you can play both founders); it proves nothing about who signed.
        </Notice>
      )}

      <Step n={1} icon={<FileIcon size={18} />} title="The sealed agreement" done={!!usable}>
        <FileDrop label="Choose or drop the sealed PDF" hint="Sealed with Create, or already signed by the other founder" accept="application/pdf,.pdf" file={file} onFile={(f) => f && load(f)} />
        <p className="flex items-center gap-1.5 text-sm text-slate-600">
          <SparkIcon size={16} className="text-indigo-500" />
          <button className={linkBtn} onClick={async () => load((await makeDemo("genuine")).pdf)} disabled={!svc}>
            Use the sample sealed agreement
          </button>
        </p>
        {report && (
          <div className="space-y-1 text-sm" data-testid="sign-doc">
            {usable ? (
              <div className="rounded-xl bg-slate-50 p-4 ring-1 ring-slate-200">
                <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-slate-700">
                  <span>
                    Document <span className="font-mono font-semibold text-slate-900">{groupDocId(report.documentId!)}</span>
                  </span>
                  <span className="text-slate-300">·</span>
                  <span>{report.pageCount} pages</span>
                  <span className="text-slate-300">·</span>
                  <span>
                    fingerprint <span className="rounded-md bg-indigo-50 px-1.5 py-0.5 font-mono text-indigo-800">{shortFingerprint(report.manifestDigest!)}</span>
                  </span>
                </div>
                <div className="mt-2 flex items-center gap-2 text-slate-600">
                  <UsersIcon size={16} className="shrink-0 text-slate-400" />
                  <span>
                    {report.signatures.length === 0
                      ? "Not signed yet: you will be the first founder."
                      : `Already signed by ${report.signatures.map((s) => `${s.signerName}${s.valid ? "" : " (not fully valid)"}`).join(", ")}.`}
                  </span>
                </div>
              </div>
            ) : (
              <Notice tone="error">
                This copy cannot be signed: {report.outcome}. {report.summary} Check it on the Verify page.
              </Notice>
            )}
          </div>
        )}
      </Step>

      {usable && bytes && (
        <Step n={2} icon={<EyeIcon size={18} />} title="Read every page" hint="Scroll through the whole document before you agree.">
          <div className="max-h-[32rem] overflow-y-auto rounded-xl border border-slate-200 bg-slate-100 p-3 sm:p-4">
            <PdfPreview bytes={bytes} />
          </div>
        </Step>
      )}

      {usable && (
        <Step n={3} icon={<UserIcon size={18} />} title="Who is signing?" done={!!me}>
          {ids.length > 0 && (
            <div className="grid gap-2 sm:grid-cols-2">
              {ids.map((i) => (
                <label
                  key={i.id}
                  className={`flex cursor-pointer items-center gap-3 rounded-xl border p-3 text-sm transition ${
                    chosen === i.id ? "border-indigo-400 bg-indigo-50/60 ring-1 ring-indigo-200" : "border-slate-200 hover:border-slate-300"
                  }`}
                >
                  <input type="radio" name="id" checked={chosen === i.id} onChange={() => setChosen(i.id)} />
                  <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-indigo-100 font-bold text-indigo-700">
                    {who(i).name.trim().charAt(0).toUpperCase()}
                  </span>
                  <span className="min-w-0">
                    <span className="block truncate font-semibold text-slate-900">{who(i).name}</span>
                    <span className="block truncate text-slate-500">{who(i).email}</span>
                  </span>
                </label>
              ))}
            </div>
          )}
          <details open={ids.length === 0} className="group rounded-xl border border-slate-200 bg-slate-50/60 p-4">
            <summary className="flex cursor-pointer items-center gap-2 text-sm font-semibold text-indigo-700">
              <MailIcon size={16} />
              Get a signing certificate{ids.length ? " for someone else" : ""}
            </summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input className={inputCls} placeholder="Your full name" value={enrol.name} onChange={(e) => setEnrol({ ...enrol, name: e.target.value })} disabled={!!enrol.pending} />
              <input className={inputCls} placeholder="Your email" type="email" value={enrol.email} onChange={(e) => setEnrol({ ...enrol, email: e.target.value })} disabled={!!enrol.pending} />
            </div>
            {!enrol.pending ? (
              <button className={btnSecondary + " mt-3"} onClick={startEnrol} disabled={!enrol.name.trim() || !enrol.email.trim() || !!busy}>
                <MailIcon size={16} />
                Email me a code
              </button>
            ) : (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-slate-600">
                  {enrol.pending.demoCode ? `Demo: your code is ${enrol.pending.demoCode} (a real service emails it).` : `We emailed a 6-digit code to ${enrol.email}.`}
                </p>
                <div className="flex gap-2">
                  <input
                    className={`${inputCls} !w-36 font-mono tracking-widest`}
                    placeholder="123456"
                    inputMode="numeric"
                    value={enrol.code}
                    onChange={(e) => setEnrol({ ...enrol, code: e.target.value })}
                  />
                  <button className={btnSecondary} onClick={finishEnrol} disabled={enrol.code.trim().length < 6 || !!busy}>
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </details>
          {alreadySigned && <Notice tone="warn">This person has already signed this copy.</Notice>}
        </Step>
      )}

      {usable && consent && me && !alreadySigned && (
        <Step n={4} icon={<HandshakeIcon size={18} />} title="Agree" done={!!signed}>
          <div className="space-y-2">
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm hover:border-slate-300">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={readAll} onChange={(e) => setReadAll(e.target.checked)} />
              <span>I, {who(me).name}, have read all {consent.pageCount} pages above.</span>
            </label>
            <label className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 p-3 text-sm hover:border-slate-300">
              <input type="checkbox" className="mt-0.5 h-4 w-4" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
              <span>I agree to this whole document and want my signature applied.</span>
            </label>
          </div>
          <p className="break-words rounded-xl bg-slate-50 p-3 font-mono text-xs leading-relaxed text-slate-700 ring-1 ring-slate-200 [overflow-wrap:anywhere]">{consentStatement(consent)}</p>
          <p className="text-xs text-slate-500">
            This exact statement goes into your signature. To timestamp it, only a hash of your signature is sent to the{" "}
            {svc?.demo ? "demo timestamp service in this browser" : "PageLock timestamp service"}; the document never leaves this device.
          </p>
          <button className={`${btnPrimary} w-full sm:w-auto`} onClick={sign} disabled={!readAll || !agree || !!busy || !!signed}>
            <PenIcon size={18} />
            Sign the agreement
          </button>
        </Step>
      )}

      {signed && me && consent && (
        <section className="space-y-4 rounded-2xl border border-emerald-200 bg-gradient-to-br from-emerald-50 to-white p-5 shadow-sm sm:p-6" data-testid="signed">
          <div className="flex items-center gap-3">
            <span className="flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500 text-white">
              <CheckCircleIcon size={22} />
            </span>
            <div className="text-lg font-bold text-emerald-950">Signed by {who(me).name}.</div>
          </div>
          <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
            <button className={btnPrimary} onClick={() => download(signed, `${baseName(file?.name ?? "agreement")} - signed by ${who(me).name}.pdf`, "application/pdf")}>
              <DownloadIcon size={16} />
              Download the signed PDF
            </button>
            <button className={btnSecondary} onClick={record} disabled={!!busy || !!logMsg}>
              <BookIcon size={16} />
              Record my sign-off in the log
            </button>
            <button className={btnSecondary} onClick={() => load(new File([signed as BlobPart], `${baseName(file?.name ?? "agreement")} - signed.pdf`, { type: "application/pdf" }))}>
              <UsersIcon size={16} />
              Continue with this signed copy (next founder)
            </button>
          </div>
          <p className="text-xs leading-relaxed text-emerald-900">
            Recording sends the log only the document ID, page count, fingerprint, a hash of the signed file and your
            certificate, signed by you. No wording, no file. The log is private to the founders.
          </p>
          {logMsg && (
            <p className="flex items-start gap-2 rounded-xl bg-white/80 p-3 text-sm text-emerald-950 ring-1 ring-emerald-200" data-testid="log-msg">
              <BookIcon size={16} className="mt-0.5 shrink-0 text-emerald-600" />
              <span>{logMsg}</span>
            </p>
          )}
        </section>
      )}

      {busy && (
        <div className="flex items-center gap-2 text-sm text-slate-600">
          <SpinnerIcon size={16} /> {busy}
        </div>
      )}
      {error && <Notice tone="error">{error}</Notice>}
    </div>
  );
}
