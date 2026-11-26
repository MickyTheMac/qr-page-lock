"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
import { CameraIcon, CheckCircleIcon, DownloadIcon, LockIcon, RefreshIcon, SearchCheckIcon, SpinnerIcon, ShieldCheckIcon } from "@/components/icons";
import { Notice, PageHeader, Step, btnPrimary, btnSecondary, card, inputCls, linkBtn } from "@/components/ui";
import { download } from "@/lib/download";
import { ActiveService, getService } from "@/lib/service-config";
import { EMPTY_DETAILS, PhotoDetails, PhotoSeal, RgbImage, assembleSealedPng, makeSeal, sealPhoto, shortFingerprint } from "@/lib/pagelock";
import {
  PendingPhoto,
  VAULT_FILE_LIMIT,
  getPendingPhoto,
  grabFrame,
  makePending,
  pngUrl,
  savePhotoToVault,
  sealedWhen,
  setPendingPhoto,
  unlockedVault,
  writeStripText,
} from "@/lib/photo-ui";

/**
 * Take a sealed photo. The picture can only come from the camera (there is no "choose from gallery"), it is sealed the
 * moment it is taken, and only its fingerprint is sent to PageLock.
 */

const KINDS = ["Driving licence", "Passport", "ID card", "Document", "Other"];

type Cam =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "live"; stream: MediaStream; label: string; canSwitch: boolean }
  | { kind: "error"; text: string };

type Work =
  | { kind: "idle" }
  | { kind: "sealing" }
  | { kind: "retry"; photo: RgbImage; seal: PhotoSeal; text: string }
  | { kind: "done"; photo: PendingPhoto; url: string };

const errText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function cameraError(e: unknown): string {
  const name = e instanceof DOMException ? e.name : "";
  if (name === "NotAllowedError" || name === "SecurityError")
    return "PageLock was not allowed to use the camera. Allow camera access for this site in your browser settings, then press Start the camera again.";
  if (name === "NotFoundError" || name === "OverconstrainedError") return "No camera was found on this device.";
  if (name === "NotReadableError") return "The camera is being used by another app. Close that app and try again.";
  if (typeof navigator !== "undefined" && !navigator.mediaDevices?.getUserMedia) return "This browser cannot use the camera here. Try Chrome or Safari.";
  return `The camera could not start (${errText(e)}).`;
}

export default function PhotoPage() {
  const [svc, setSvc] = useState<ActiveService | null>(null);
  const [details, setDetails] = useState<PhotoDetails>({ ...EMPTY_DETAILS, what: KINDS[0] });
  const [cam, setCam] = useState<Cam>({ kind: "off" });
  const [facing, setFacing] = useState<"environment" | "user">("environment");
  const [work, setWork] = useState<Work>(() => {
    // Coming back from the vault: the photo just sealed is still here.
    const p = getPendingPhoto();
    return p ? { kind: "done", photo: p, url: pngUrl(p.png) } : { kind: "idle" };
  });
  const video = useRef<HTMLVideoElement>(null);

  useEffect(() => {
    getService().then(setSvc);
  }, []);

  const stop = useCallback((s?: MediaStream) => s?.getTracks().forEach((t) => t.stop()), []);
  useEffect(() => () => (cam.kind === "live" ? stop(cam.stream) : undefined), [cam, stop]);

  useEffect(() => {
    if (cam.kind === "live" && video.current) {
      video.current.srcObject = cam.stream;
      video.current.play().catch(() => undefined);
    }
  }, [cam]);

  const start = async (want = facing) => {
    if (cam.kind === "live") stop(cam.stream);
    setCam({ kind: "starting" });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: want }, width: { ideal: 1920 }, height: { ideal: 1080 } },
        audio: false,
      });
      const devices = await navigator.mediaDevices.enumerateDevices().catch(() => []);
      const label = stream.getVideoTracks()[0]?.label ?? "";
      setFacing(want);
      setCam({ kind: "live", stream, label, canSwitch: devices.filter((d) => d.kind === "videoinput").length > 1 });
    } catch (e) {
      setCam({ kind: "error", text: cameraError(e) });
    }
  };

  const finish = async (photo: RgbImage, seal: PhotoSeal) => {
    if (!svc) return;
    setWork({ kind: "sealing" });
    try {
      const s = await sealPhoto(photo, seal, (d) => svc.client.sealPhoto(d));
      const png = assembleSealedPng(photo, writeStripText(s.stripBase, s.record), s.record);
      const p = makePending(png, s.record);
      setPendingPhoto(p);
      setWork({ kind: "done", photo: p, url: pngUrl(png) });
    } catch (e) {
      setWork({
        kind: "retry",
        photo,
        seal,
        text: `PageLock could not add its trusted time (${errText(e)}). Check your connection and press Try again. Your picture is kept on this page until then.`,
      });
    }
  };

  const take = async () => {
    if (cam.kind !== "live" || !video.current) return;
    let photo: RgbImage;
    try {
      photo = grabFrame(video.current);
    } catch (e) {
      setCam({ kind: "error", text: errText(e) });
      return;
    }
    const settings = cam.stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    stop(cam.stream);
    setCam({ kind: "off" });
    // Sealed at once: fingerprinted here, before anything else can touch it.
    const seal = await makeSeal(photo, { details, camera: [cam.label, settings.facingMode].filter(Boolean).join(", ") });
    await finish(photo, seal);
  };

  const again = () => {
    setPendingPhoto(null);
    setWork({ kind: "idle" });
  };

  const locked = work.kind !== "idle";

  return (
    <div className="space-y-6">
      <PageHeader icon={<CameraIcon size={24} />} title="Take a sealed photo">
        Take a picture of a licence, passport or document. PageLock seals it the moment it is taken, so anyone you send
        it to can check later that <strong>not one pixel has changed</strong>. Only the picture&apos;s fingerprint is
        sent to PageLock, never the picture.
      </PageHeader>

      {svc?.demo && (
        <Notice tone="warn" title="Demo mode">
          The trusted clock runs in this browser only, so photos sealed here can only be checked in this browser.
        </Notice>
      )}

      <div className="grid gap-4 md:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
        <Step n={1} icon={<ShieldCheckIcon size={18} />} title="What are you photographing?" hint="These ride along inside the sealed file" done={locked}>
          <fieldset disabled={locked} className="space-y-3">
            <label className="block space-y-1 text-sm text-slate-700">
              <span>What it is</span>
              <select className={inputCls} value={details.what} onChange={(e) => setDetails({ ...details, what: e.target.value })}>
                {KINDS.map((k) => (
                  <option key={k}>{k}</option>
                ))}
              </select>
            </label>
            <label className="block space-y-1 text-sm text-slate-700">
              <span>Document number (optional)</span>
              <input className={inputCls} value={details.reference} maxLength={80} onChange={(e) => setDetails({ ...details, reference: e.target.value })} />
            </label>
            <label className="block space-y-1 text-sm text-slate-700">
              <span>Taken for (optional)</span>
              <input
                className={inputCls}
                value={details.takenFor}
                maxLength={120}
                placeholder="e.g. a customer or company"
                onChange={(e) => setDetails({ ...details, takenFor: e.target.value })}
              />
            </label>
            <label className="block space-y-1 text-sm text-slate-700">
              <span>Note (optional)</span>
              <input className={inputCls} value={details.note} maxLength={400} onChange={(e) => setDetails({ ...details, note: e.target.value })} />
            </label>
          </fieldset>
        </Step>

        <Step n={2} icon={<CameraIcon size={18} />} title="Take the picture" hint="Straight from the camera. Pictures from your gallery cannot be sealed." done={work.kind === "done"}>
          {work.kind === "idle" && (
            <div className="space-y-3">
              <div className="relative overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: "4 / 3" }}>
                {cam.kind === "live" ? (
                  <video ref={video} playsInline muted className="h-full w-full object-contain" data-testid="camera" />
                ) : (
                  <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-300">
                    {cam.kind === "starting" ? <SpinnerIcon size={28} /> : <CameraIcon size={36} />}
                    {cam.kind === "starting" ? "Starting the camera…" : "The camera is off"}
                  </div>
                )}
              </div>
              {cam.kind === "error" && <Notice tone="error">{cam.text}</Notice>}
              <div className="flex flex-wrap gap-2">
                {cam.kind === "live" ? (
                  <>
                    <button className={`${btnPrimary} !px-6`} onClick={take}>
                      <CameraIcon size={18} /> Take and seal
                    </button>
                    {cam.canSwitch && (
                      <button className={btnSecondary} onClick={() => start(facing === "environment" ? "user" : "environment")}>
                        <RefreshIcon size={16} /> Switch camera
                      </button>
                    )}
                  </>
                ) : (
                  <button className={btnPrimary} onClick={() => start()} disabled={!svc || cam.kind === "starting"}>
                    <CameraIcon size={18} /> Start the camera
                  </button>
                )}
              </div>
              <p className="text-xs text-slate-500">Tip: lay the card flat on a dark surface, fill the frame and avoid glare.</p>
            </div>
          )}
          {work.kind === "sealing" && (
            <div className="flex items-center gap-2 text-slate-600">
              <SpinnerIcon /> Sealing your picture…
            </div>
          )}
          {work.kind === "retry" && (
            <div className="space-y-3">
              <Notice tone="error">{work.text}</Notice>
              <button className={btnPrimary} onClick={() => finish(work.photo, work.seal)}>
                <RefreshIcon size={16} /> Try again
              </button>
            </div>
          )}
          {work.kind === "done" && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={work.url} alt="Your sealed photo, with the PageLock strip below it" className="w-full rounded-xl border border-slate-200" data-testid="sealed-photo" />
          )}
        </Step>
      </div>

      {work.kind === "done" && svc && <Keep svc={svc} photo={work.photo} onAgain={again} />}

      <section className={`${card} space-y-2 text-sm text-slate-600`}>
        <div className="font-semibold text-slate-900">What a sealed photo proves</div>
        <ul className="list-disc space-y-1 pl-5">
          <li>
            <strong>It proves the picture is unchanged</strong> since PageLock sealed it, and when that was. It does not
            prove that what is in the picture is genuine: a clear photo of a fake licence seals just as well.
          </li>
          <li>
            It stops casual editing. A determined person could still fool a browser camera, for example by photographing a
            screen.
          </li>
          <li>The details you type ride along inside the file. PageLock never sees them.</li>
        </ul>
      </section>
    </div>
  );
}

function Keep({ svc, photo, onAgain }: { svc: ActiveService; photo: PendingPhoto; onAgain: () => void }) {
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState(photo.savedToVault);
  const [msg, setMsg] = useState<{ tone: "success" | "error" | "info"; text: ReactNode } | null>(
    photo.savedToVault ? { tone: "success", text: "Locked on this device and saved in your vault." } : null,
  );
  const r = photo.record;
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const me = await unlockedVault(svc);
      if (!me) {
        setMsg({
          tone: "info",
          text: (
            <>
              To save it locked, first open your vault on this device.{" "}
              <Link href="/vault/" className={linkBtn}>
                Open my vault
              </Link>
              . Your photo waits here, and the vault will offer to save it.
            </>
          ),
        });
        return;
      }
      await savePhotoToVault(svc, me, photo);
      setSaved(true);
      setMsg({ tone: "success", text: "Locked on this device and saved in your vault. PageLock cannot open it." });
    } catch (e) {
      setMsg({ tone: "error", text: errText(e) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Step n={3} icon={<CheckCircleIcon size={18} />} title="Sealed. Now keep it" done={saved}>
      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-sm">
        <dt className="text-slate-500">Sealed by PageLock</dt>
        <dd className="font-medium text-slate-900">{sealedWhen(r.sealedAt)}</dd>
        <dt className="text-slate-500">Fingerprint</dt>
        <dd className="font-mono text-slate-900">{shortFingerprint(r.sealDigest)}</dd>
        {r.seal.details.what && (
          <>
            <dt className="text-slate-500">What it is</dt>
            <dd>{r.seal.details.what}</dd>
          </>
        )}
        {r.seal.details.reference && (
          <>
            <dt className="text-slate-500">Document number</dt>
            <dd>{r.seal.details.reference}</dd>
          </>
        )}
        {r.seal.details.takenFor && (
          <>
            <dt className="text-slate-500">Taken for</dt>
            <dd>{r.seal.details.takenFor}</dd>
          </>
        )}
      </dl>
      <div className="flex flex-wrap gap-2">
        <button className={btnPrimary} onClick={save} disabled={busy || saved || photo.png.length > VAULT_FILE_LIMIT}>
          {busy ? <SpinnerIcon size={16} /> : <LockIcon size={16} />} {saved ? "Saved in your vault" : "Save locked in my vault"}
        </button>
        <button className={btnSecondary} onClick={() => download(photo.png, photo.name, "image/png")}>
          <DownloadIcon size={16} /> Download the sealed photo
        </button>
        <button className={btnSecondary} onClick={onAgain}>
          <CameraIcon size={16} /> Take another
        </button>
      </div>
      {msg && <Notice tone={msg.tone}>{msg.text}</Notice>}
      <p className="text-xs leading-relaxed text-slate-500">
        A downloaded copy is not locked: keep it somewhere safe. Send the <strong>file itself</strong> (for example by
        email attachment). Messaging apps squash pictures and drop the seal. Anyone can check it on{" "}
        <Link href="/verify/" className={linkBtn}>
          <SearchCheckIcon size={12} className="inline" /> Check a copy
        </Link>
        .
      </p>
    </Step>
  );
}
