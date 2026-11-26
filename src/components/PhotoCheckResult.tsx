"use client";
import { useEffect, useMemo } from "react";
import { AlertIcon, CheckCircleIcon, HelpIcon, InfoIcon, ShieldCheckIcon, XCircleIcon } from "./icons";
import { Notice } from "./ui";
import { PhotoCheckReport, PhotoCheckStatus, PhotoOutcome, formatMessage, looksMessage, shortFingerprint } from "@/lib/pagelock";
import { dayWhen, pngUrl, readSummary, sealedWhen } from "@/lib/photo-ui";

const LOOK: Record<PhotoOutcome, { badge: string; panel: string; Icon: typeof ShieldCheckIcon; plain: string }> = {
  "SEALED AND UNCHANGED": { badge: "bg-emerald-600 text-white", panel: "border-emerald-200 bg-gradient-to-br from-emerald-50 to-white", Icon: ShieldCheckIcon, plain: "Unchanged since it was sealed" },
  CHANGED: { badge: "bg-red-600 text-white", panel: "border-red-200 bg-gradient-to-br from-red-50 to-white", Icon: XCircleIcon, plain: "This picture has been changed" },
  "NO SEAL FOUND": { badge: "bg-slate-600 text-white", panel: "border-slate-200 bg-gradient-to-br from-slate-50 to-white", Icon: HelpIcon, plain: "Could not check" },
  "NOT TRUSTED": { badge: "bg-amber-500 text-white", panel: "border-amber-200 bg-gradient-to-br from-amber-50 to-white", Icon: AlertIcon, plain: "Matches, but the time is not trusted" },
};

const STATUS: Record<PhotoCheckStatus, [string, typeof CheckCircleIcon]> = {
  pass: ["text-emerald-600", CheckCircleIcon],
  fail: ["text-red-600", XCircleIcon],
  inconclusive: ["text-amber-600", AlertIcon],
};

export function PhotoCheckResult({ report, file, publicSealedAt }: { report: PhotoCheckReport; file: Uint8Array; publicSealedAt?: string | null }) {
  const look = LOOK[report.outcome];
  const url = useMemo(() => (report.outcome === "NO SEAL FOUND" ? null : pngUrl(file)), [file, report.outcome]);
  useEffect(() => () => void (url && URL.revokeObjectURL(url)), [url]);
  const r = report.record;
  const d = r?.seal.details;
  const drift = r && report.trustedTime ? Math.abs(new Date(r.seal.capturedAt).getTime() - new Date(report.trustedTime).getTime()) : 0;
  return (
    <div className="space-y-6" data-testid="photo-outcome">
      <section className={`space-y-3 rounded-2xl border p-5 shadow-sm sm:p-6 ${look.panel}`}>
        <div className={`inline-flex items-center gap-2 rounded-xl px-4 py-2 text-lg font-bold tracking-wide shadow-sm ${look.badge}`}>
          <look.Icon size={22} />
          {report.outcome}
        </div>
        <div className="text-xl font-bold text-slate-900">{look.plain}</div>
        <p className="max-w-3xl leading-relaxed text-slate-700">{report.summary}</p>
      </section>

      <div className="grid gap-6 md:grid-cols-2">
        {url && (
          // eslint-disable-next-line @next/next/no-img-element
          <img src={url} alt="The photo that was checked" className="w-full rounded-2xl border border-slate-200 shadow-sm" />
        )}
        <div className="space-y-4">
          {r && (
            <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1.5 rounded-2xl border border-slate-200 bg-white p-5 text-sm shadow-sm">
              <dt className="text-slate-500">Sealed by PageLock</dt>
              <dd className="font-medium whitespace-nowrap text-slate-900">{report.trustedTime ? sealedWhen(report.trustedTime) : "Unknown (no trusted time)"}</dd>
              <dt className="text-slate-500">Device clock said</dt>
              <dd className="whitespace-nowrap">{sealedWhen(r.seal.capturedAt)}</dd>
              {d?.what && (
                <>
                  <dt className="text-slate-500">What it is</dt>
                  <dd>{d.what}</dd>
                </>
              )}
              {d?.name && (
                <>
                  <dt className="text-slate-500">Name</dt>
                  <dd>{d.name}</dd>
                </>
              )}
              {d?.reference && (
                <>
                  <dt className="text-slate-500">Document number</dt>
                  <dd className="whitespace-nowrap">{d.reference}</dd>
                </>
              )}
              {d?.born && (
                <>
                  <dt className="text-slate-500">Date of birth</dt>
                  <dd className="whitespace-nowrap">{dayWhen(d.born)}</dd>
                </>
              )}
              {d?.expires && (
                <>
                  <dt className="text-slate-500">Expires</dt>
                  <dd className="whitespace-nowrap">{dayWhen(d.expires)}</dd>
                </>
              )}
              {r.seal.capture?.format && r.seal.capture.format.result !== "not-checked" && (
                <>
                  <dt className="text-slate-500">Details check</dt>
                  <dd className={r.seal.capture.format.result === "does-not-add-up" ? "font-medium text-red-700" : ""}>
                    {formatMessage(r.seal.capture.format, d?.what ?? "document")}
                  </dd>
                </>
              )}
              {r.seal.capture?.read && (
                <>
                  <dt className="text-slate-500">Read from picture</dt>
                  <dd>{readSummary(r.seal.capture.read, d?.what ?? "document")}</dd>
                </>
              )}
              {d?.takenFor && (
                <>
                  <dt className="text-slate-500">Taken for</dt>
                  <dd>{d.takenFor}</dd>
                </>
              )}
              {d?.note && (
                <>
                  <dt className="text-slate-500">Note</dt>
                  <dd>{d.note}</dd>
                </>
              )}
              {r.seal.capture?.looks && (
                <>
                  <dt className="text-slate-500">Look check</dt>
                  <dd>{looksMessage(r.seal.capture.looks)}</dd>
                </>
              )}
              {r.seal.capture && r.seal.capture.linedUp !== null && (
                <>
                  <dt className="text-slate-500">Lined up on target</dt>
                  <dd>{r.seal.capture.linedUp ? "Yes" : "No, taken anyway"}</dd>
                </>
              )}
              {r.seal.camera && (
                <>
                  <dt className="text-slate-500">Camera</dt>
                  <dd>{r.seal.camera}</dd>
                </>
              )}
              <dt className="text-slate-500">Fingerprint</dt>
              <dd className="font-mono whitespace-nowrap">{shortFingerprint(r.sealDigest)}</dd>
              {publicSealedAt !== undefined && (
                <>
                  <dt className="text-slate-500">Public record</dt>
                  <dd>{publicSealedAt ? (<>Found, sealed <span className="whitespace-nowrap">{sealedWhen(publicSealedAt)}</span></>) : "Not found on this PageLock site"}</dd>
                </>
              )}
            </dl>
          )}
          <ul className="divide-y divide-slate-100 rounded-2xl border border-slate-200 bg-white shadow-sm">
            {report.checks.map((c, i) => {
              const [cls, Icon] = STATUS[c.status];
              return (
                <li key={i} className="flex gap-3 px-5 py-3 text-sm">
                  <Icon size={18} className={`mt-0.5 shrink-0 ${cls}`} />
                  <div>
                    <div className="font-semibold text-slate-900">{c.label}</div>
                    <div className="text-slate-600">{c.detail}</div>
                  </div>
                </li>
              );
            })}
          </ul>
        </div>
      </div>

      {r && report.outcome !== "CHANGED" && (
        <Notice tone="info" title="Trust the details on this screen">
          The words printed on the strip are only a convenience. The time and details above come from inside the sealed
          file and are what PageLock checked.
          {drift > 5 * 60 * 1000 && " Note: the device's own clock was more than 5 minutes out from PageLock's clock when the picture was taken."}
        </Notice>
      )}
      {report.demoAuthority && (
        <Notice tone="warn">Demo mode: the trusted clock runs in this browser only. It is not proof for anyone else.</Notice>
      )}
      <p className="flex gap-2 text-xs leading-relaxed text-slate-500">
        <InfoIcon size={14} className="mt-0.5 shrink-0" />A sealed photo proves the picture is unchanged since PageLock
        sealed it. It does not prove that what is in the picture is genuine.
      </p>
    </div>
  );
}
