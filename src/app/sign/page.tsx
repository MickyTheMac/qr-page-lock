"use client";
import { useEffect, useState } from "react";
import { FileDrop } from "@/components/FileDrop";
import { PdfPreview } from "@/components/PdfPreview";
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

const card = "rounded-xl border border-neutral-200 bg-white p-5";
const btn = "rounded-lg bg-neutral-900 px-5 py-2.5 text-sm font-medium text-white disabled:opacity-40";
const btn2 = "rounded-lg border border-neutral-300 px-4 py-2 text-sm hover:border-neutral-900 disabled:opacity-40";

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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Sign the agreement</h1>
        <p className="mt-1 text-neutral-600">
          Each founder signs the same sealed PDF, one after the other. Your signing key is made and kept in this browser;
          it never leaves your device.
        </p>
        {svc?.demo && (
          <p className="mt-3 rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-950">
            Demo mode: certificates come from a demo authority that runs inside this browser, and email codes are shown on
            screen. Good for trying it out (you can play both founders); it proves nothing about who signed.
          </p>
        )}
      </div>

      <section className={card + " space-y-3"}>
        <div className="text-sm font-medium">1. The sealed agreement</div>
        <FileDrop label="Choose or drop the sealed PDF" hint="Sealed with Create, or already signed by the other founder" accept="application/pdf,.pdf" file={file} onFile={(f) => f && load(f)} />
        <button className="text-xs text-neutral-600 underline" onClick={async () => load((await makeDemo("genuine")).pdf)} disabled={!svc}>
          Use the sample sealed agreement
        </button>
        {report && (
          <div className="space-y-1 text-sm" data-testid="sign-doc">
            {usable ? (
              <>
                <div>
                  Document <span className="font-mono">{groupDocId(report.documentId!)}</span> · {report.pageCount} pages · fingerprint{" "}
                  <span className="font-mono">{shortFingerprint(report.manifestDigest!)}</span>
                </div>
                <div className="text-neutral-600">
                  {report.signatures.length === 0
                    ? "Not signed yet: you will be the first founder."
                    : `Already signed by ${report.signatures.map((s) => `${s.signerName}${s.valid ? "" : " (not fully valid)"}`).join(", ")}.`}
                </div>
              </>
            ) : (
              <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-red-900">
                This copy cannot be signed: {report.outcome}. {report.summary} Check it on the Verify page.
              </div>
            )}
          </div>
        )}
      </section>

      {usable && bytes && (
        <section className={card + " space-y-3"}>
          <div className="text-sm font-medium">2. Read every page</div>
          <div className="max-h-[32rem] overflow-y-auto rounded-lg border border-neutral-200 bg-neutral-50 p-3">
            <PdfPreview bytes={bytes} />
          </div>
        </section>
      )}

      {usable && (
        <section className={card + " space-y-4"}>
          <div className="text-sm font-medium">3. Who is signing?</div>
          {ids.length > 0 && (
            <div className="space-y-2">
              {ids.map((i) => (
                <label key={i.id} className="flex items-center gap-2 text-sm">
                  <input type="radio" name="id" checked={chosen === i.id} onChange={() => setChosen(i.id)} />
                  <span className="font-medium">{who(i).name}</span>
                  <span className="text-neutral-500">{who(i).email}</span>
                </label>
              ))}
            </div>
          )}
          <details open={ids.length === 0} className="rounded-lg border border-neutral-200 p-3">
            <summary className="cursor-pointer text-sm">Get a signing certificate{ids.length ? " for someone else" : ""}</summary>
            <div className="mt-3 grid gap-2 sm:grid-cols-2">
              <input className="rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Your full name" value={enrol.name} onChange={(e) => setEnrol({ ...enrol, name: e.target.value })} disabled={!!enrol.pending} />
              <input className="rounded-lg border border-neutral-300 px-3 py-2 text-sm" placeholder="Your email" type="email" value={enrol.email} onChange={(e) => setEnrol({ ...enrol, email: e.target.value })} disabled={!!enrol.pending} />
            </div>
            {!enrol.pending ? (
              <button className={btn2 + " mt-3"} onClick={startEnrol} disabled={!enrol.name.trim() || !enrol.email.trim() || !!busy}>
                Email me a code
              </button>
            ) : (
              <div className="mt-3 space-y-2">
                <p className="text-sm text-neutral-600">
                  {enrol.pending.demoCode ? `Demo: your code is ${enrol.pending.demoCode} (a real service emails it).` : `We emailed a 6-digit code to ${enrol.email}.`}
                </p>
                <div className="flex gap-2">
                  <input className="w-32 rounded-lg border border-neutral-300 px-3 py-2 font-mono text-sm" placeholder="123456" value={enrol.code} onChange={(e) => setEnrol({ ...enrol, code: e.target.value })} />
                  <button className={btn2} onClick={finishEnrol} disabled={enrol.code.trim().length < 6 || !!busy}>
                    Confirm
                  </button>
                </div>
              </div>
            )}
          </details>
          {alreadySigned && <p className="text-sm text-amber-800">This person has already signed this copy.</p>}
        </section>
      )}

      {usable && consent && me && !alreadySigned && (
        <section className={card + " space-y-3"}>
          <div className="text-sm font-medium">4. Agree</div>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={readAll} onChange={(e) => setReadAll(e.target.checked)} />
            <span>I, {who(me).name}, have read all {consent.pageCount} pages above.</span>
          </label>
          <label className="flex items-start gap-2 text-sm">
            <input type="checkbox" className="mt-1" checked={agree} onChange={(e) => setAgree(e.target.checked)} />
            <span>I agree to this whole document and want my signature applied.</span>
          </label>
          <p className="rounded-lg bg-neutral-50 p-3 font-mono text-xs leading-relaxed text-neutral-700">{consentStatement(consent)}</p>
          <p className="text-xs text-neutral-500">
            This exact statement goes into your signature. To timestamp it, only a hash of your signature is sent to the{" "}
            {svc?.demo ? "demo timestamp service in this browser" : "PageLock timestamp service"}; the document never leaves this device.
          </p>
          <button className={btn} onClick={sign} disabled={!readAll || !agree || !!busy || !!signed}>
            Sign the agreement
          </button>
        </section>
      )}

      {signed && me && consent && (
        <section className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-5" data-testid="signed">
          <div className="font-medium text-emerald-950">Signed by {who(me).name}.</div>
          <div className="flex flex-wrap gap-2">
            <button className={btn} onClick={() => download(signed, `${baseName(file?.name ?? "agreement")} - signed by ${who(me).name}.pdf`, "application/pdf")}>
              Download the signed PDF
            </button>
            <button className={btn2} onClick={record} disabled={!!busy || !!logMsg}>
              Record my sign-off in the log
            </button>
            <button className={btn2} onClick={() => load(new File([signed as BlobPart], `${baseName(file?.name ?? "agreement")} - signed.pdf`, { type: "application/pdf" }))}>
              Continue with this signed copy (next founder)
            </button>
          </div>
          <p className="text-xs text-emerald-900">
            Recording sends the log only the document ID, page count, fingerprint, a hash of the signed file and your
            certificate, signed by you. No wording, no file. The log is private to the founders.
          </p>
          {logMsg && <p className="text-sm text-emerald-950" data-testid="log-msg">{logMsg}</p>}
        </section>
      )}

      {busy && <div className="text-sm text-neutral-600">{busy}</div>}
      {error && <div className="rounded-xl border border-red-200 bg-red-50 p-4 text-sm text-red-900">{error}</div>}
    </div>
  );
}
