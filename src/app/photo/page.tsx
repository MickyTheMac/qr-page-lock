"use client";
import { useCallback, useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import Link from "next/link";
import { AlertIcon, CameraIcon, CheckCircleIcon, DownloadIcon, LockIcon, RefreshIcon, SearchCheckIcon, SpinnerIcon, ShieldCheckIcon } from "@/components/icons";
import { Notice, PageHeader, Step, btnPrimary, btnRow, btnSecondary, card, inputCls, linkBtn } from "@/components/ui";
import { download } from "@/lib/download";
import { ActiveService, getService } from "@/lib/service-config";
import {
  AlignScore,
  CaptureChecks,
  DetailsRead,
  EMPTY_DETAILS,
  EMPTY_FIELDS,
  LooksCheck,
  PhotoDetails,
  PhotoSeal,
  ReadFields,
  ReadResult,
  RgbImage,
  TARGET_RATIO,
  assembleSealedPng,
  cropRect,
  foundFields,
  looksMessage,
  makeSeal,
  sealPhoto,
  shortFingerprint,
  targetRect,
} from "@/lib/pagelock";
import { readPicture, warmUpReader } from "@/lib/photo-ocr";
import {
  PendingPhoto,
  VAULT_FILE_LIMIT,
  frameAlignment,
  dayWhen,
  getPendingPhoto,
  grabFrame,
  previewUrl,
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
/** Kinds whose name, number and dates PageLock reads off the picture for the person to check. */
const READS_DETAILS = new Set(["Driving licence", "Passport", "ID card"]);

/** Everything known about a picture just taken, before it is sealed. */
interface Taken {
  photo: RgbImage;
  url: string;
  at: Date;
  camera: string;
  linedUp: boolean | null;
  looks: LooksCheck | null;
  read: ReadResult | null;
}

type Cam =
  | { kind: "off" }
  | { kind: "starting" }
  | { kind: "live"; stream: MediaStream; label: string; canSwitch: boolean }
  | { kind: "error"; text: string };

type Work =
  | { kind: "idle" }
  | { kind: "checking"; photo: RgbImage; url: string }
  | { kind: "doubt"; taken: Taken & { looks: LooksCheck } }
  | { kind: "review"; taken: Taken }
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
  const [align, setAlign] = useState<{ sides: AlignScore["sides"]; ready: boolean; struggling: boolean } | null>(null);
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
      warmUpReader();
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

  const ratio = TARGET_RATIO[details.what] ?? null;

  // While the camera is on: a few times a second, check whether the document fills the target.
  useEffect(() => {
    if (cam.kind !== "live" || ratio === null) return;
    let steady = 0;
    const started = Date.now();
    const t = setInterval(() => {
      const v = video.current;
      if (!v) return;
      const sc = frameAlignment(v, ratio);
      if (!sc) return;
      steady = sc.aligned ? steady + 1 : 0;
      setAlign({ sides: sc.sides, ready: steady >= 3, struggling: Date.now() - started > 15000 });
    }, 200);
    return () => {
      clearInterval(t);
      setAlign(null);
    };
  }, [cam, ratio]);

  const seal = async (t: Taken, extra?: { fields: ReadFields; read?: DetailsRead }) => {
    const d: PhotoDetails = extra
      ? { ...details, reference: extra.fields.number, name: extra.fields.name, born: extra.fields.born, expires: extra.fields.expires }
      : details;
    const capture: CaptureChecks = { linedUp: t.linedUp, looks: t.looks, ...(extra?.read ? { read: extra.read } : {}) };
    const sealObj = await makeSeal(t.photo, { details: d, camera: t.camera, capturedAt: t.at, capture });
    await finish(t.photo, sealObj);
  };

  /** After the look check: licences, passports and ID cards show what was read for the person to check first. */
  const next = (t: Taken) => (READS_DETAILS.has(details.what) ? setWork({ kind: "review", taken: t }) : seal(t));

  const take = async (linedUp: boolean | null) => {
    if (cam.kind !== "live" || !video.current) return;
    const v = video.current;
    let photo: RgbImage;
    try {
      const crop = ratio === null ? undefined : cropRect(v.videoWidth, v.videoHeight, targetRect(v.videoWidth, v.videoHeight, ratio));
      photo = grabFrame(v, crop);
    } catch (e) {
      setCam({ kind: "error", text: errText(e) });
      return;
    }
    const at = new Date();
    const settings = cam.stream.getVideoTracks()[0]?.getSettings?.() ?? {};
    const camera = [cam.label, settings.facingMode].filter(Boolean).join(", ");
    stop(cam.stream);
    setCam({ kind: "off" });
    // Read the picture on this device: does it look like what was chosen, and what details does it carry?
    const url = previewUrl(photo);
    setWork({ kind: "checking", photo, url });
    const r = await readPicture(details.what, photo);
    const t: Taken = { photo, url, at, camera, linedUp, looks: r?.looks ?? null, read: r?.read ?? null };
    if (t.looks && t.looks.result === "not-recognised") {
      setWork({ kind: "doubt", taken: { ...t, looks: t.looks } });
      return;
    }
    await next(t);
  };

  const again = () => {
    setPendingPhoto(null);
    setWork({ kind: "idle" });
  };

  const locked = work.kind !== "idle";

  return (
    <div className="space-y-6">
      <PageHeader icon={<CameraIcon size={24} />} title="Take a sealed photo" tone="sky">
        Take a picture of a licence, passport or document. PageLock checks it looks right and seals it straight away, so
        anyone you send it to can check later that <strong>not one pixel has changed</strong>. Only the picture&apos;s
        fingerprint is sent to PageLock, never the picture.
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
            {READS_DETAILS.has(details.what) ? (
              <p className="rounded-lg bg-sky-50 px-3 py-2 text-sm text-sky-900">
                No need to type the name, number or dates. PageLock reads them off the {details.what.toLowerCase()} for you
                to check before it is sealed.
              </p>
            ) : (
              <label className="block space-y-1 text-sm text-slate-700">
                <span>Document number (optional)</span>
                <input className={inputCls} value={details.reference} maxLength={80} onChange={(e) => setDetails({ ...details, reference: e.target.value })} />
              </label>
            )}
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
              <Viewfinder video={video} cam={cam} ratio={ratio} align={align} />
              {cam.kind === "error" && <Notice tone="error">{cam.text}</Notice>}
              {cam.kind === "live" && ratio !== null && (
                <p className={`text-sm font-medium ${align?.ready ? "text-emerald-700" : "text-slate-600"}`} data-testid="target-hint">
                  {align?.ready
                    ? `Lined up. Hold still and press Take and seal.`
                    : `Move closer or further away until the ${details.what.toLowerCase()} fills the frame and its edges sit on the white lines.`}
                </p>
              )}
              <div className={btnRow}>
                {cam.kind === "live" ? (
                  <>
                    <button className={btnPrimary} onClick={() => take(ratio === null ? null : true)} disabled={ratio !== null && !align?.ready}>
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
              {cam.kind === "live" && ratio !== null && align?.struggling && !align.ready && (
                <p className="text-xs text-slate-500">
                  Still not lining up? Put it on a plain dark surface, out of shadow. If it still will not line up,{" "}
                  <button className={linkBtn} onClick={() => take(false)}>
                    take it anyway
                  </button>{" "}
                  (the seal will say it was not lined up).
                </p>
              )}
              {cam.kind !== "live" && <p className="text-xs text-slate-500">Tip: lay the card flat on a plain dark surface and avoid glare.</p>}
            </div>
          )}
          {work.kind === "checking" && (
            <div className="space-y-3">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={work.url} alt="The picture you just took" className="w-full rounded-xl border border-slate-200" />
              <div className="flex items-center gap-2 text-slate-600">
                <SpinnerIcon /> {READS_DETAILS.has(details.what) ? `Reading the ${details.what.toLowerCase()}…` : `Checking it looks like a ${details.what.toLowerCase()}…`}
              </div>
            </div>
          )}
          {work.kind === "doubt" && (
            <div className="space-y-3" data-testid="doubt">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={work.taken.url} alt="The picture you just took" className="w-full rounded-xl border border-slate-200" />
              <Notice tone="warn">
                {looksMessage(work.taken.looks)} Take it again, or seal it anyway: the seal will then say it was not recognised.
              </Notice>
              <div className={btnRow}>
                <button className={btnPrimary} onClick={() => setWork({ kind: "idle" })}>
                  <CameraIcon size={18} /> Take it again
                </button>
                <button className={btnSecondary} onClick={() => next(work.taken)}>
                  <AlertIcon size={16} /> Seal it anyway
                </button>
              </div>
            </div>
          )}
          {work.kind === "review" && <Review taken={work.taken} what={details.what} onSeal={(x) => seal(work.taken, x)} onAgain={() => setWork({ kind: "idle" })} />}
          {work.kind === "sealing" && (
            <div className="flex items-center gap-2 text-slate-600">
              <SpinnerIcon /> Sealing your picture…
            </div>
          )}
          {work.kind === "retry" && (
            <div className="space-y-3">
              <Notice tone="error">{work.text}</Notice>
              <div className={btnRow}>
                <button className={btnPrimary} onClick={() => finish(work.photo, work.seal)}>
                  <RefreshIcon size={16} /> Try again
                </button>
              </div>
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
          <li>
            Before sealing, this device reads the words in the picture to check it looks like the document you chose (for
            example, a licence says &ldquo;Driving licence&rdquo;). It catches mistakes, not forgeries.
          </li>
          <li>
            For licences, passports and ID cards, this device also reads the name, number and dates, and you check them
            before sealing. Passports and ID cards carry check numbers, so those read very reliably.
          </li>
          <li>The details ride along inside the file. PageLock never sees them, or the picture.</li>
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
        <dd className="font-medium whitespace-nowrap text-slate-900">{sealedWhen(r.sealedAt)}</dd>
        <dt className="text-slate-500">Fingerprint</dt>
        <dd className="font-mono whitespace-nowrap text-slate-900">{shortFingerprint(r.sealDigest)}</dd>
        {r.seal.details.what && (
          <>
            <dt className="text-slate-500">What it is</dt>
            <dd>{r.seal.details.what}</dd>
          </>
        )}
        {r.seal.capture?.looks && (
          <>
            <dt className="text-slate-500">Look check</dt>
            <dd>{looksMessage(r.seal.capture.looks)}</dd>
          </>
        )}
        {r.seal.details.name && (
          <>
            <dt className="text-slate-500">Name</dt>
            <dd>{r.seal.details.name}</dd>
          </>
        )}
        {r.seal.details.reference && (
          <>
            <dt className="text-slate-500">Document number</dt>
            <dd className="whitespace-nowrap">{r.seal.details.reference}</dd>
          </>
        )}
        {r.seal.details.born && (
          <>
            <dt className="text-slate-500">Date of birth</dt>
            <dd className="whitespace-nowrap">{dayWhen(r.seal.details.born)}</dd>
          </>
        )}
        {r.seal.details.expires && (
          <>
            <dt className="text-slate-500">Expires</dt>
            <dd className="whitespace-nowrap">{dayWhen(r.seal.details.expires)}</dd>
          </>
        )}
        {r.seal.details.takenFor && (
          <>
            <dt className="text-slate-500">Taken for</dt>
            <dd>{r.seal.details.takenFor}</dd>
          </>
        )}
      </dl>
      <div className={btnRow}>
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

const FIELD_LABELS: Record<keyof ReadFields, string> = { name: "Full name", number: "Document number", born: "Date of birth", expires: "Expires" };

/** Shows what was read off the document so the person can check it against the picture, and fix it, before sealing. */
function Review({
  taken,
  what,
  onSeal,
  onAgain,
}: {
  taken: Taken;
  what: string;
  onSeal: (x: { fields: ReadFields; read?: DetailsRead }) => void;
  onAgain: () => void;
}) {
  const read = taken.read;
  const found = read?.source ? foundFields(read) : [];
  const [f, setF] = useState<ReadFields>(() => ({ ...EMPTY_FIELDS, ...(read?.source ? read.fields : {}) }));
  const label = (k: keyof ReadFields) => (k === "number" && what === "Driving licence" ? "Licence number" : FIELD_LABELS[k]);
  const go = () => {
    const changed = found.filter((k) => f[k].trim() !== read!.fields[k]);
    onSeal({
      fields: { name: f.name.trim(), number: f.number.trim(), born: f.born, expires: f.expires },
      read: read?.source && found.length ? { method: "on-device text reading v1", source: read.source, checkDigitsOk: read.checkDigitsOk, found, changedByPerson: changed } : undefined,
    });
  };
  return (
    <div className="space-y-3" data-testid="review">
      {/* eslint-disable-next-line @next/next/no-img-element */}
      <img src={taken.url} alt="The picture you just took" className="w-full rounded-xl border border-slate-200" />
      {found.length ? (
        <Notice tone={read?.checkDigitsOk === false ? "warn" : "info"} title="Check these against the picture">
          PageLock read these off the {what.toLowerCase()}. Fix anything that is wrong, then seal it.
          {read?.checkDigitsOk === true && " Its check numbers match, so they are very likely right."}
          {read?.checkDigitsOk === false && " Some of its check numbers do not match, so look closely."}
        </Notice>
      ) : (
        <Notice tone="info">
          PageLock could not read the details from this picture. Type them in if you want them sealed with it, or leave
          them blank.
        </Notice>
      )}
      <div className="grid gap-3 sm:grid-cols-2">
        {(Object.keys(FIELD_LABELS) as (keyof ReadFields)[]).map((k) => (
          <label key={k} className={`block space-y-1 text-sm text-slate-700 ${k === "name" ? "sm:col-span-2" : ""}`}>
            <span className="flex flex-wrap items-baseline justify-between gap-x-2">
              <span>{label(k)}</span>
              {found.includes(k) && <span className="text-xs font-medium whitespace-nowrap text-emerald-700">Read from the picture</span>}
            </span>
            <input
              className={inputCls}
              type={k === "born" || k === "expires" ? "date" : "text"}
              value={f[k]}
              maxLength={k === "name" ? 120 : 80}
              autoCapitalize="characters"
              data-testid={`read-${k}`}
              onChange={(e) => setF({ ...f, [k]: e.target.value })}
            />
          </label>
        ))}
      </div>
      <div className={btnRow}>
        <button className={btnPrimary} onClick={go}>
          <ShieldCheckIcon size={18} /> Seal it
        </button>
        <button className={btnSecondary} onClick={onAgain}>
          <CameraIcon size={18} /> Take it again
        </button>
      </div>
    </div>
  );
}

/** The live camera with the target drawn over it: everything outside the target is dimmed. */
function Viewfinder({
  video,
  cam,
  ratio,
  align,
}: {
  video: RefObject<HTMLVideoElement | null>;
  cam: Cam;
  ratio: number | null;
  align: { sides: AlignScore["sides"]; ready: boolean } | null;
}) {
  const [size, setSize] = useState<{ w: number; h: number } | null>(null);
  const t = size && ratio !== null ? targetRect(size.w, size.h, ratio) : null;
  const pct = (v: number, of: number) => `${(v / of) * 100}%`;
  const line = (ok: boolean | undefined) => (align?.ready ? "#10b981" : ok ? "#6ee7b7" : "rgba(255,255,255,0.9)");
  return (
    <div className="relative overflow-hidden rounded-xl bg-slate-900" style={{ aspectRatio: size ? `${size.w} / ${size.h}` : "4 / 3" }}>
      {cam.kind === "live" ? (
        <video
          ref={video}
          playsInline
          muted
          className="h-full w-full object-fill"
          data-testid="camera"
          onLoadedMetadata={(e) => setSize({ w: e.currentTarget.videoWidth, h: e.currentTarget.videoHeight })}
        />
      ) : (
        <div className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center text-sm text-slate-300">
          {cam.kind === "starting" ? <SpinnerIcon size={28} /> : <CameraIcon size={36} />}
          {cam.kind === "starting" ? "Starting the camera…" : "The camera is off"}
        </div>
      )}
      {cam.kind === "live" && t && size && (
        <div
          aria-hidden="true"
          data-testid="target"
          className="pointer-events-none absolute rounded-[3%] transition-colors"
          style={{
            left: pct(t.x, size.w),
            top: pct(t.y, size.h),
            width: pct(t.w, size.w),
            height: pct(t.h, size.h),
            boxShadow: "0 0 0 9999px rgba(15,23,42,0.55)",
            borderStyle: "solid",
            borderWidth: 3,
            borderTopColor: line(align?.sides.top.ok),
            borderRightColor: line(align?.sides.right.ok),
            borderBottomColor: line(align?.sides.bottom.ok),
            borderLeftColor: line(align?.sides.left.ok),
          }}
        />
      )}
    </div>
  );
}
