"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { LINK_BASE, PublicSignOff, QrPayload, groupDocId, parsePayload, shortFingerprint } from "@/lib/pagelock";
import { getService } from "@/lib/service-config";
import { PageHeader } from "@/components/ui";
import { QrIcon } from "@/components/icons";

/**
 * Opened when someone scans the LAST page's QR code with a phone (the code is a link to /C/<code>).
 * It shows whether this document was signed off and logged. Only public facts are shown:
 * the document fingerprint and the sign-off time. Nothing about the document's wording.
 */

type State =
  | { kind: "loading" }
  | { kind: "bad" }
  | { kind: "error"; code: QrPayload }
  | { kind: "done"; code: QrPayload; match: PublicSignOff | null; others: PublicSignOff[]; demo: boolean };

function codeFromLocation(): QrPayload | null {
  const path = window.location.pathname;
  const m = /^\/(?:C|c|check)\/(.+?)\/?$/.exec(path);
  if (!m) return null;
  let rest: string;
  try {
    rest = decodeURIComponent(m[1]);
  } catch {
    return null;
  }
  const p = parsePayload(LINK_BASE + rest.toUpperCase());
  return p && p.fingerprintPrefix ? p : null;
}

function when(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { dateStyle: "long", timeStyle: "short" });
}

export default function CheckPage() {
  const [state, setState] = useState<State>({ kind: "loading" });

  useEffect(() => {
    const code = codeFromLocation();
    if (!code) {
      setState({ kind: "bad" });
      return;
    }
    (async () => {
      try {
        const svc = await getService();
        const all = await svc.client.publicByDocument(code.documentId);
        const match = all.find((s) => s.manifestDigest.startsWith(code.fingerprintPrefix!)) ?? null;
        setState({ kind: "done", code, match, others: all.filter((s) => s !== match), demo: svc.demo });
      } catch {
        setState({ kind: "error", code });
      }
    })();
  }, []);

  return (
    <div className="mx-auto max-w-xl py-2">
      <PageHeader tone="emerald" icon={<QrIcon size={24} />} title="Document check">
        Was this document signed off?
      </PageHeader>

      {state.kind === "loading" && <p className="mt-6 text-neutral-600">Checking the sign-off log…</p>}

      {state.kind === "bad" && (
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="font-medium">This is not a PageLock code we recognise.</p>
          <p className="mt-2 text-sm text-neutral-700">
            Scan the QR code on the <strong>last page</strong> of a PageLock document.
          </p>
        </div>
      )}

      {state.kind !== "loading" && state.kind !== "bad" && (
        <dl className="mt-6 grid rounded-2xl border border-slate-300/70 bg-white p-4 shadow-md shadow-slate-900/5 grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
          <dt className="text-neutral-500">Document</dt>
          <dd className="font-mono">{groupDocId(state.code.documentId)}</dd>
          <dt className="text-neutral-500">Pages</dt>
          <dd>{state.code.count}</dd>
          <dt className="text-neutral-500">Fingerprint</dt>
          <dd className="font-mono">{shortFingerprint(state.code.fingerprintPrefix!)}…</dd>
        </dl>
      )}

      {state.kind === "error" && (
        <div className="mt-6 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
          <p className="font-medium">The sign-off log could not be reached right now.</p>
          <p className="mt-2 text-sm text-neutral-700">Check your connection and try again in a moment.</p>
        </div>
      )}

      {state.kind === "done" && state.match && (
        <div className="mt-6 rounded-lg border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-lg font-semibold text-emerald-800">Signed off and logged</p>
          <p className="mt-2 text-sm text-neutral-800">
            Both signatures for this document were recorded on {when(state.match.signedOffAt)}.
          </p>
          <p className="mt-2 break-all font-mono text-xs text-neutral-600">Fingerprint {state.match.manifestDigest}</p>
        </div>
      )}

      {state.kind === "done" && !state.match && state.others.length > 0 && (
        <div className="mt-6 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-lg font-semibold text-red-800">A different version was signed off</p>
          <p className="mt-2 text-sm text-neutral-800">
            This document number was signed off, but with a different fingerprint from this paper. This copy may not be the
            version that was agreed. Check the PDF on the Verify page.
          </p>
        </div>
      )}

      {state.kind === "done" && !state.match && state.others.length === 0 && (
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="text-lg font-semibold text-amber-800">No completed sign-off yet</p>
          <p className="mt-2 text-sm text-neutral-800">
            The log has no record of both founders signing off this document. It may still be waiting for a signature.
          </p>
        </div>
      )}

      {state.kind === "done" && state.demo && (
        <p className="mt-4 text-xs text-amber-700">Demo mode: this site is using the in-browser demo log, not the real one.</p>
      )}

      {state.kind !== "loading" && (
        <p className="mt-8 text-sm text-neutral-600">
          This checks the sign-off log only. It cannot see the paper in your hand. To check every page, open{" "}
          <Link href="/verify/" className="underline">
            Verify
          </Link>{" "}
          and add the PDF.
        </p>
      )}
    </div>
  );
}
