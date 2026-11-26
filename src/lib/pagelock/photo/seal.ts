/**
 * Sealed photos: a picture taken inside PageLock, sealed the moment it is taken.
 *
 *   1. The camera frame's exact pixels are fingerprinted (SHA-256).
 *   2. A small "seal" is made: that fingerprint, the picture size, this device's clock, and any details the person
 *      typed (what it is, a reference number, who it was taken for, a note), plus a random salt.
 *   3. Only the seal's own fingerprint (64 hex characters) is sent to PageLock. PageLock records it with its own clock
 *      and returns an RFC 3161 timestamp: PageLock's signed statement of when it first saw that fingerprint.
 *   4. A strip is added BELOW the picture (never over it) with the time, a short fingerprint and a QR code linking to
 *      the public record. The seal and the timestamp also ride along inside the PNG file.
 *
 * Checking re-reads the pixels, recomputes both fingerprints and checks PageLock's timestamp. One changed pixel, a
 * crop, or an edited detail makes it fail.
 *
 * What it proves: this picture is unchanged since PageLock sealed it, at the time shown. It does NOT prove that what is
 * in the picture is real (a sharp photo of a fake licence seals just as well), and a browser camera can be fooled by
 * a determined person (a fake camera device, or a photo of a screen).
 */
import jsQR from "jsqr";
import QRCode from "qrcode";
import * as pkijs from "pkijs";
import { canonicalJson, concatBytes, toHex, utf8 } from "../encoding";
import { sha256Hex } from "../crypto";
import { LINK_BASE } from "../qr";
import { b64decode, hasExtKeyUsage, nameInfo, OID } from "../sign/pki";
import { checkTimestampToken, equalBytes } from "../sign/cms";
import { TrustProfile } from "../sign/trust";
import { validatePath } from "../sign/validate";
import { PngError, decodePng, encodePng, isPng } from "./png";

export const PHOTO_SEAL_TYPE = "pagelock-photo-seal";
/** The PNG text chunk that carries the seal. */
export const PHOTO_CHUNK = "PageLock-Photo-Seal";
/** Where the strip's QR code points. Uppercase so the code stays in QR alphanumeric mode (smaller). */
export const PHOTO_LINK_BASE = LINK_BASE.replace(/\/C\/$/, "/P/");
/** Longest side of a sealed photo, in pixels. Keeps the file small enough for the vault (3 MB). */
export const PHOTO_MAX_SIDE = 1280;
/** QR version 5 (37 × 37) always fits the 100-character link at error correction level M. */
const QR_VERSION = 5;

export interface PhotoDetails {
  /** What the picture is of, e.g. "Driving licence". */
  what: string;
  /** e.g. a licence or document number. */
  reference: string;
  /** Who it was taken for, e.g. a customer's name. */
  takenFor: string;
  note: string;
}

export const EMPTY_DETAILS: PhotoDetails = { what: "", reference: "", takenFor: "", note: "" };

export interface PhotoSeal {
  type: typeof PHOTO_SEAL_TYPE;
  version: 1;
  photo: { width: number; height: number; pixelsSha256: string };
  stripHeight: number;
  /** This device's clock when the picture was taken. PageLock's own (trusted) time is in the timestamp. */
  capturedAt: string;
  /** How the picture was made. Always "pagelock-camera": there is no way to seal a picture from the gallery. */
  source: "pagelock-camera";
  camera: string;
  details: PhotoDetails;
  /** Random, so nobody can guess the details from the public fingerprint. */
  salt: string;
}

/** What rides along inside the PNG. */
export interface PhotoSealRecord {
  pagelockPhoto: 1;
  seal: PhotoSeal;
  sealDigest: string;
  /** PageLock's time, as it answered (the trusted copy is inside the timestamp token). */
  sealedAt: string;
  timestampToken: string; // base64 RFC 3161 TimeStampToken over sealDigest
}

// ------------------------------------------------------------------ fingerprints

/** RGB pixels, 3 bytes each, rows top to bottom. */
export interface RgbImage {
  width: number;
  height: number;
  rgb: Uint8Array;
}

export async function pixelsDigest(img: RgbImage): Promise<string> {
  if (img.rgb.length !== img.width * img.height * 3) throw new Error("Pixel data does not match the image size.");
  return sha256Hex(concatBytes([utf8(`PageLock photo pixels v1|${img.width}|${img.height}|`), img.rgb]));
}

export async function sealDigestOf(seal: PhotoSeal): Promise<string> {
  return sha256Hex(utf8(canonicalJson(seal)));
}

export function photoLink(sealDigest: string): string {
  return PHOTO_LINK_BASE + sealDigest;
}

/** Reads a photo fingerprint out of a scanned link (or a bare fingerprint). */
export function parsePhotoLink(text: string): string | null {
  const t = text.trim().toUpperCase();
  const m = /^(?:HTTPS:\/\/PAGELOCK-INDOL\.VERCEL\.APP\/P\/)?([0-9A-F]{64})\/?$/.exec(t);
  return m ? m[1] : null;
}

/** RGBA (from a canvas) to RGB, dropping alpha. */
export function rgbaToRgb(rgba: Uint8Array | Uint8ClampedArray, width: number, height: number): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  for (let i = 0, j = 0; j < rgb.length; i += 4, j += 3) {
    rgb[j] = rgba[i];
    rgb[j + 1] = rgba[i + 1];
    rgb[j + 2] = rgba[i + 2];
  }
  return { width, height, rgb };
}

export function rgbToRgba(img: RgbImage): Uint8ClampedArray<ArrayBuffer> {
  const out = new Uint8ClampedArray(img.width * img.height * 4);
  for (let i = 0, j = 0; i < img.rgb.length; i += 3, j += 4) {
    out[j] = img.rgb[i];
    out[j + 1] = img.rgb[i + 1];
    out[j + 2] = img.rgb[i + 2];
    out[j + 3] = 255;
  }
  return out;
}

function randomHex(n: number): string {
  const b = new Uint8Array(n);
  globalThis.crypto.getRandomValues(b);
  return toHex(b);
}

const clean = (s: string, max: number) => s.replace(/[\u0000-\u001f\u007f]/g, " ").trim().slice(0, max);

export async function makeSeal(photo: RgbImage, opts: { details?: Partial<PhotoDetails>; camera?: string; capturedAt?: Date }): Promise<PhotoSeal> {
  const d = { ...EMPTY_DETAILS, ...opts.details };
  return {
    type: PHOTO_SEAL_TYPE,
    version: 1,
    photo: { width: photo.width, height: photo.height, pixelsSha256: await pixelsDigest(photo) },
    stripHeight: stripLayout(photo.width).height,
    capturedAt: (opts.capturedAt ?? new Date()).toISOString(),
    source: "pagelock-camera",
    camera: clean(opts.camera ?? "", 120),
    details: { what: clean(d.what, 80), reference: clean(d.reference, 80), takenFor: clean(d.takenFor, 120), note: clean(d.note, 400) },
    salt: randomHex(16),
  };
}

// ------------------------------------------------------------------ the strip below the picture

export interface StripLayout {
  height: number;
  /** QR code, drawn on white, on the right. */
  qr: { x: number; y: number; scale: number; modules: number; box: number };
  /** Where the browser writes the words, on the left. */
  text: { x: number; y: number; width: number; height: number };
  /** The coloured bar along the top of the strip. */
  bar: number;
}

export function stripLayout(width: number): StripLayout {
  const height = Math.max(150, Math.round(width * 0.16));
  const bar = Math.max(4, Math.round(height * 0.03));
  const modules = 17 + 4 * QR_VERSION;
  const inner = height - bar - 12;
  const scale = Math.max(2, Math.floor(inner / (modules + 6)));
  const box = scale * (modules + 6); // with a 3-module white border each side
  const pad = Math.round((height - bar - box) / 2);
  const qr = { x: width - box - pad, y: bar + pad, scale, modules, box };
  const tx = Math.max(12, Math.round(height * 0.12));
  return { height, bar, qr, text: { x: tx, y: bar + pad, width: Math.max(0, qr.x - tx * 2), height: box } };
}

export const STRIP_COLORS = { background: [15, 23, 42], bar: [79, 70, 229], text: [255, 255, 255], muted: [165, 180, 252] } as const;

/** The strip with its background, bar and QR code. The browser then writes the words into `layout.text`. */
export function drawStripBase(width: number, sealDigest: string): RgbImage {
  const L = stripLayout(width);
  const rgb = new Uint8Array(width * L.height * 3);
  const set = (x: number, y: number, c: readonly number[]) => {
    const o = (y * width + x) * 3;
    rgb[o] = c[0];
    rgb[o + 1] = c[1];
    rgb[o + 2] = c[2];
  };
  for (let y = 0; y < L.height; y++) for (let x = 0; x < width; x++) set(x, y, y < L.bar ? STRIP_COLORS.bar : STRIP_COLORS.background);
  const qr = QRCode.create(photoLink(sealDigest), { errorCorrectionLevel: "M", version: QR_VERSION });
  const { x: qx, y: qy, scale, box } = L.qr;
  for (let y = 0; y < box; y++) {
    for (let x = 0; x < box; x++) {
      const mx = Math.floor(x / scale) - 3;
      const my = Math.floor(y / scale) - 3;
      const dark = mx >= 0 && my >= 0 && mx < qr.modules.size && my < qr.modules.size && qr.modules.get(my, mx);
      set(qx + x, qy + y, dark ? [0, 0, 0] : [255, 255, 255]);
    }
  }
  return { width, height: L.height, rgb };
}

/** Puts the strip under the photo and writes the PNG with the seal inside. */
export function assembleSealedPng(photo: RgbImage, strip: RgbImage, record: PhotoSealRecord): Uint8Array {
  if (strip.width !== photo.width || strip.height !== record.seal.stripHeight) throw new Error("The strip does not fit the photo.");
  const all = concatBytes([photo.rgb, strip.rgb]);
  return encodePng(all, photo.width, photo.height + strip.height, [{ keyword: PHOTO_CHUNK, text: JSON.stringify(record) }]);
}

// ------------------------------------------------------------------ sealing

/** Sends ONLY the fingerprint to PageLock, and gets back its time and timestamp. */
export type PhotoSealer = (sealDigest: string) => Promise<{ sealedAt: string; timestampToken: string }>;

export interface SealedPhoto {
  record: PhotoSealRecord;
  /** The strip without words (the browser adds them). */
  stripBase: RgbImage;
}

export async function sealPhoto(photo: RgbImage, seal: PhotoSeal, sealer: PhotoSealer): Promise<SealedPhoto> {
  const sealDigest = await sealDigestOf(seal);
  const r = await sealer(sealDigest);
  const record: PhotoSealRecord = { pagelockPhoto: 1, seal, sealDigest, sealedAt: r.sealedAt, timestampToken: r.timestampToken };
  return { record, stripBase: drawStripBase(photo.width, sealDigest) };
}

// ------------------------------------------------------------------ checking

export type PhotoOutcome = "SEALED AND UNCHANGED" | "CHANGED" | "NO SEAL FOUND" | "NOT TRUSTED";
export type PhotoCheckStatus = "pass" | "fail" | "inconclusive";

export interface PhotoCheckItem {
  label: string;
  status: PhotoCheckStatus;
  detail: string;
}

export interface PhotoCheckReport {
  outcome: PhotoOutcome;
  summary: string;
  checks: PhotoCheckItem[];
  record: PhotoSealRecord | null;
  /** PageLock's trusted time, from the timestamp. */
  trustedTime: string | null;
  timestampAuthority: string | null;
  demoAuthority: boolean;
  /** The photo part only (without the strip), for showing on screen. */
  photo: RgbImage | null;
}

export function readPhotoRecord(texts: { keyword: string; text: string }[]): PhotoSealRecord | null {
  const t = texts.find((x) => x.keyword === PHOTO_CHUNK);
  if (!t) return null;
  try {
    const r = JSON.parse(t.text) as PhotoSealRecord;
    const s = r?.seal;
    if (r?.pagelockPhoto !== 1 || s?.type !== PHOTO_SEAL_TYPE || s.version !== 1) return null;
    if (!Number.isInteger(s.photo?.width) || !Number.isInteger(s.photo?.height) || !Number.isInteger(s.stripHeight)) return null;
    if (typeof r.timestampToken !== "string" || typeof r.sealDigest !== "string") return null;
    return r;
  } catch {
    return null;
  }
}

function qrInStrip(strip: RgbImage): string | null {
  // Read just the white square where PageLock puts the code, with extra white around it.
  const L = stripLayout(strip.width);
  if (L.height !== strip.height) return null;
  const pad = L.qr.scale * 4;
  const W = L.qr.box + pad * 2;
  const rgba = new Uint8ClampedArray(W * W * 4).fill(255);
  for (let y = 0; y < L.qr.box; y++) {
    for (let x = 0; x < L.qr.box; x++) {
      const i = ((L.qr.y + y) * strip.width + L.qr.x + x) * 3;
      const o = ((pad + y) * W + pad + x) * 4;
      rgba[o] = strip.rgb[i];
      rgba[o + 1] = strip.rgb[i + 1];
      rgba[o + 2] = strip.rgb[i + 2];
    }
  }
  return jsQR(rgba, W, W, { inversionAttempts: "dontInvert" })?.data ?? null;
}

const nothing = (summary: string, detail: string): PhotoCheckReport => ({
  outcome: "NO SEAL FOUND",
  summary,
  checks: [{ label: "A PageLock seal is inside the file", status: "fail", detail }],
  record: null,
  trustedTime: null,
  timestampAuthority: null,
  demoAuthority: false,
  photo: null,
});

/**
 * Checks a sealed photo file. `trust` says whose timestamps to believe (PageLock's, from its trust file). Without it,
 * the picture and seal are still checked, but the time is reported as not trusted.
 */
export async function checkSealedPhoto(file: Uint8Array, trust: TrustProfile | null): Promise<PhotoCheckReport> {
  const squashed =
    "Only the original sealed PNG file can be checked. Apps such as WhatsApp, email previews and screenshots make a new copy and drop the seal. Ask for the original file.";
  if (!isPng(file)) return nothing("This is not a sealed PageLock photo.", `This file is not a PNG image. ${squashed}`);
  let png;
  try {
    png = decodePng(file);
  } catch (e) {
    return nothing("This file could not be read as a sealed photo.", `${e instanceof PngError ? e.message : "The image could not be read."} ${squashed}`);
  }
  const record = readPhotoRecord(png.texts);
  if (!record) return nothing("No PageLock seal was found in this picture.", `The file has no PageLock seal inside it. ${squashed}`);

  const checks: PhotoCheckItem[] = [{ label: "A PageLock seal is inside the file", status: "pass", detail: "The seal was found." }];
  const seal = record.seal;
  const W = seal.photo.width;
  const H = seal.photo.height;
  let photo: RgbImage | null = null;
  let strip: RgbImage | null = null;

  // 1. The picture itself.
  if (png.width !== W || png.height !== H + seal.stripHeight || !png.opaque) {
    checks.push({
      label: "The picture is exactly as it was taken",
      status: "fail",
      detail: `The picture has been cropped, resized or made see-through since it was sealed (sealed at ${W} × ${H + seal.stripHeight} pixels, now ${png.width} × ${png.height}).`,
    });
  } else {
    photo = { width: W, height: H, rgb: png.rgb.subarray(0, W * H * 3) };
    strip = { width: W, height: seal.stripHeight, rgb: png.rgb.subarray(W * H * 3) };
    const ok = (await pixelsDigest(photo)) === seal.photo.pixelsSha256;
    checks.push({
      label: "The picture is exactly as it was taken",
      status: ok ? "pass" : "fail",
      detail: ok ? "Every pixel matches the fingerprint taken when the picture was sealed." : "At least one pixel has changed since the picture was sealed.",
    });
  }

  // 2. The details that ride along, and the timestamp over them.
  const digest = await sealDigestOf(seal);
  let trustedTime: string | null = null;
  let authority: string | null = null;
  let tsBound = false;
  if (digest !== record.sealDigest) {
    checks.push({ label: "The details saved with it are unchanged", status: "fail", detail: "The time or details inside the file have been edited." });
  }
  try {
    const ts = await checkTimestampToken(b64decode(record.timestampToken));
    const imprintOk = ts.imprintAlg === "2.16.840.1.101.3.4.2.1" && equalBytes(ts.imprint, hexBytes(digest));
    if (!ts.signatureValid || !imprintOk) {
      checks.push({
        label: "The details saved with it are unchanged",
        status: "fail",
        detail: ts.signatureValid ? "PageLock's timestamp was made for different details, so something inside the file has been edited." : "PageLock's timestamp is damaged.",
      });
    } else {
      tsBound = true;
      if (digest === record.sealDigest)
        checks.push({ label: "The details saved with it are unchanged", status: "pass", detail: "The time and details match what PageLock timestamped." });
      authority = ts.tsaCert ? nameInfo(ts.tsaCert.subject).text : null;
      trustedTime = ts.genTime.toISOString();
      checks.push(await trustCheck(ts.tsaCert, ts.certs, ts.genTime, trust));
    }
  } catch {
    checks.push({ label: "The details saved with it are unchanged", status: "fail", detail: "PageLock's timestamp is missing or damaged." });
  }

  // 3. The QR code on the strip.
  if (strip) {
    const text = qrInStrip(strip);
    const found = text ? parsePhotoLink(text) : null;
    checks.push(
      found === digest
        ? { label: "The QR code on the strip belongs to this photo", status: "pass", detail: "It points to this photo's public record." }
        : found
          ? { label: "The QR code on the strip belongs to this photo", status: "fail", detail: "The strip has been swapped: its QR code belongs to a different photo." }
          : { label: "The QR code on the strip belongs to this photo", status: "inconclusive", detail: "The QR code on the strip could not be read." },
    );
  }

  const failed = checks.some((c) => c.status === "fail");
  const trusted = checks.find((c) => c.label === TRUST_LABEL)?.status === "pass";
  const outcome: PhotoOutcome = failed ? "CHANGED" : tsBound && trusted ? "SEALED AND UNCHANGED" : "NOT TRUSTED";
  const summary =
    outcome === "CHANGED"
      ? "This picture is not the one PageLock sealed. Something has changed since."
      : outcome === "SEALED AND UNCHANGED"
        ? "This picture is exactly as it was when PageLock sealed it."
        : "The picture matches its seal, but the seal's time is not from a PageLock clock this page trusts.";
  return {
    outcome,
    summary,
    checks,
    record,
    trustedTime,
    timestampAuthority: authority,
    demoAuthority: !!trust?.demo,
    photo: photo ? { ...photo, rgb: photo.rgb.slice() } : null,
  };
}

const TRUST_LABEL = "The time comes from PageLock's trusted clock";

async function trustCheck(tsaCert: pkijs.Certificate | null, certs: pkijs.Certificate[], at: Date, trust: TrustProfile | null): Promise<PhotoCheckItem> {
  if (!trust) return { label: TRUST_LABEL, status: "inconclusive", detail: "No trusted clock was chosen, so the time cannot be relied on." };
  if (!tsaCert || !hasExtKeyUsage(tsaCert, OID.timeStamping))
    return { label: TRUST_LABEL, status: "fail", detail: "The time was not signed by a timestamping certificate." };
  const path = await validatePath(tsaCert, certs, trust.tsaAnchors, at);
  return path.ok
    ? { label: TRUST_LABEL, status: "pass", detail: trust.demo ? "Signed by the demo clock that runs in this browser." : "Signed by PageLock's timestamp service." }
    : { label: TRUST_LABEL, status: "inconclusive", detail: "The time was signed by a clock this page does not trust (for example, a different PageLock site or the demo)." };
}

function hexBytes(h: string): Uint8Array {
  return new Uint8Array(h.match(/../g)!.map((x) => parseInt(x, 16)));
}

/** A file name like "Sealed photo - Driving licence - 2026-11-26 2041.png". */
export function sealedPhotoFileName(record: PhotoSealRecord): string {
  const d = new Date(record.sealedAt);
  const pad = (n: number) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}${pad(d.getMinutes())}`;
  const what = record.seal.details.what.replace(/[\\/:*?"<>|]/g, "").trim();
  return `Sealed photo${what ? ` - ${what}` : ""} - ${stamp}.png`;
}

