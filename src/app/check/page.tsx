"use client";
import { useEffect, useState } from "react";
import Link from "next/link";
import { LINK_BASE, PublicSignOff, QrPayload, groupDocId, parsePayload, parsePhotoLink, shortFingerprint } from "@/lib/pagelock";
import { getService } from "@/lib/service-config";

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

function DocumentCheck() {
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
      <h1 className="text-2xl font-semibold">Document check</h1>

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
        <dl className="mt-6 grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
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

/** The page behind every scanned code: /C/... for a document's last page, /P/... for a sealed photo's strip. */
export default function CheckPage() {
  const [mode, setMode] = useState<"doc" | "photo" | null>(null);
  // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is only known in the browser
  useEffect(() => setMode(/^\/[Pp]\//.test(window.location.pathname) ? "photo" : "doc"), []);
  if (!mode) return null;
  return mode === "photo" ? <PhotoRecordCheck /> : <DocumentCheck />;
}

type PhotoState =
  | { kind: "loading" }
  | { kind: "bad" }
  | { kind: "error"; digest: string }
  | { kind: "done"; digest: string; sealedAt: string | null; demo: boolean };

/**
 * Opened when someone scans the QR code on a sealed photo's strip. PageLock only knows the photo's fingerprint and
 * when it was sealed, so that is all this shows. Checking the picture itself needs the file.
 */
function PhotoRecordCheck() {
  const [state, setState] = useState<PhotoState>({ kind: "loading" });
  useEffect(() => {
    const m = /^\/[Pp]\/([^/]+)\/?$/.exec(window.location.pathname);
    const digest = m ? parsePhotoLink(decodeURIComponent(m[1])) : null;
    if (!digest) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- the address is only known in the browser
      setState({ kind: "bad" });
      return;
    }
    (async () => {
      try {
        const svc = await getService();
        const r = await svc.client.publicPhoto(digest);
        setState({ kind: "done", digest, sealedAt: r?.sealedAt ?? null, demo: svc.demo });
      } catch {
        setState({ kind: "error", digest });
      }
    })();
  }, []);

  return (
    <div className="mx-auto max-w-xl py-2">
      <h1 className="text-2xl font-semibold">Sealed photo check</h1>
      {state.kind === "loading" && <p className="mt-6 text-neutral-600">Looking up this photo…</p>}
      {state.kind === "bad" && (
        <div className="mt-6 rounded-lg border border-amber-300 bg-amber-50 p-4">
          <p className="font-medium">This is not a PageLock photo code we recognise.</p>
        </div>
      )}
      {state.kind !== "loading" && state.kind !== "bad" && (
        <p className="mt-6 break-all text-sm text-neutral-600">
          Fingerprint <span className="font-mono">{shortFingerprint(state.digest)}…</span>
        </p>
      )}
      {state.kind === "error" && (
        <div className="mt-4 rounded-lg border border-neutral-300 bg-neutral-50 p-4">
          <p className="font-medium">PageLock could not be reached right now.</p>
          <p className="mt-2 text-sm text-neutral-700">Check your connection and try again in a moment.</p>
        </div>
      )}
      {state.kind === "done" && state.sealedAt && (
        <div className="mt-4 rounded-lg border border-emerald-300 bg-emerald-50 p-4">
          <p className="text-lg font-semibold text-emerald-800">A photo with this fingerprint was sealed</p>
          <p className="mt-2 text-sm text-neutral-800">PageLock sealed it on {when(state.sealedAt)}.</p>
        </div>
      )}
      {state.kind === "done" && !state.sealedAt && (
        <div className="mt-4 rounded-lg border border-red-300 bg-red-50 p-4">
          <p className="text-lg font-semibold text-red-800">No photo with this fingerprint was sealed here</p>
          <p className="mt-2 text-sm text-neutral-800">Do not rely on this picture.</p>
        </div>
      )}
      {state.kind === "done" && state.demo && <p className="mt-4 text-xs text-amber-700">Demo mode: this site is using the in-browser demo, not the real record.</p>}
      {state.kind !== "loading" && (
        <p className="mt-8 text-sm text-neutral-600">
          This only shows when the photo was sealed. It cannot see the picture in front of you, which could be a different
          one with this strip pasted on. To check every pixel, open{" "}
          <Link href="/verify/" className="underline">
            Check a copy
          </Link>{" "}
          and add the original photo file.
        </p>
      )}
    </div>
  );
}
