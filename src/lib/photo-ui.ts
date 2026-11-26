/**
 * Browser-only helpers for sealed photos: grabbing a camera frame, writing the words on the strip, keeping a just-sealed
 * photo while the person opens their vault, and saving it to the vault (locked on this device first).
 */
import {
  PHOTO_MAX_SIDE,
  PhotoSealRecord,
  RgbImage,
  STRIP_COLORS,
  VaultIdentity,
  deriveIdentity,
  rgbToRgba,
  rgbaToRgb,
  sealedPhotoFileName,
  shortFingerprint,
  stripLayout,
} from "@/lib/pagelock";
import { recallRoot, savedToken } from "@/lib/pagelock/vault/device";
import type { ActiveService } from "@/lib/service-config";

/** Takes the current camera frame, scaled so its longest side is at most PHOTO_MAX_SIDE. */
export function grabFrame(video: HTMLVideoElement): RgbImage {
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh) throw new Error("The camera has not started yet.");
  const k = Math.min(1, PHOTO_MAX_SIDE / Math.max(vw, vh));
  const w = Math.round(vw * k);
  const h = Math.round(vh * k);
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.drawImage(video, 0, 0, w, h);
  return rgbaToRgb(ctx.getImageData(0, 0, w, h).data, w, h);
}

const rgbCss = (c: readonly number[]) => `rgb(${c[0]},${c[1]},${c[2]})`;

export function sealedWhen(iso: string): string {
  // dateStyle/timeStyle cannot be combined with timeZoneName, so name each part.
  return new Date(iso).toLocaleString(undefined, { day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}

/** Writes the words into the strip's text area. Only pixels inside that area change. */
export function writeStripText(base: RgbImage, record: PhotoSealRecord): RgbImage {
  const L = stripLayout(base.width);
  const c = document.createElement("canvas");
  c.width = base.width;
  c.height = base.height;
  const ctx = c.getContext("2d", { willReadFrequently: true })!;
  ctx.putImageData(new ImageData(rgbToRgba(base), base.width, base.height), 0, 0);
  const { x, y, width, height } = L.text;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, width, height);
  ctx.clip();
  ctx.textBaseline = "top";
  const sans = "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif";
  const mono = "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace";
  const line = (text: string, size: number, weight: number, family: string, color: readonly number[], top: number) => {
    let s = size;
    ctx.font = `${weight} ${s}px ${family}`;
    while (s > 8 && ctx.measureText(text).width > width) {
      s -= 1;
      ctx.font = `${weight} ${s}px ${family}`;
    }
    ctx.fillStyle = rgbCss(color);
    ctx.fillText(text, x, top);
  };
  const what = record.seal.details.what;
  const rows: [string, number, number, string, readonly number[]][] = [
    ["SEALED BY PAGELOCK", 0.17, 800, sans, STRIP_COLORS.text],
    [sealedWhen(record.sealedAt), 0.15, 600, sans, STRIP_COLORS.text],
    ...(what ? ([[what, 0.13, 500, sans, STRIP_COLORS.text]] as [string, number, number, string, readonly number[]][]) : []),
    [`Fingerprint ${shortFingerprint(record.sealDigest)}`, 0.12, 500, mono, STRIP_COLORS.muted],
    ["Scan the code, or drop this file into PageLock's Check a copy", 0.1, 400, sans, STRIP_COLORS.muted],
  ];
  const gap = height / rows.length;
  rows.forEach(([text, k, weight, family, color], i) => line(text, Math.round(height * k), weight, family, color, y + i * gap + (gap - height * k) / 2));
  ctx.restore();
  const out = rgbaToRgb(ctx.getImageData(0, 0, base.width, base.height).data, base.width, base.height);
  return out;
}

// ---------------------------------------------------------------- the photo just sealed, kept while you open your vault

export interface PendingPhoto {
  png: Uint8Array;
  record: PhotoSealRecord;
  name: string;
  savedToVault: boolean;
}

let pending: PendingPhoto | null = null;
const listeners = new Set<() => void>();

export function setPendingPhoto(p: PendingPhoto | null) {
  pending = p;
  listeners.forEach((f) => f());
}
export function getPendingPhoto(): PendingPhoto | null {
  return pending;
}
export function makePending(png: Uint8Array, record: PhotoSealRecord): PendingPhoto {
  return { png, record, name: sealedPhotoFileName(record), savedToVault: false };
}

// ---------------------------------------------------------------- the vault

/** If this device's vault is logged in and unlocked, returns its padlock; otherwise null. Never asks for anything. */
export async function unlockedVault(svc: ActiveService): Promise<VaultIdentity | null> {
  const t = savedToken();
  if (!t) return null;
  svc.vault.token = t;
  try {
    const acc = await svc.vault.account();
    if (!acc.keyFp) return null;
    const root = await recallRoot(acc.keyFp);
    return root ? await deriveIdentity(root) : null;
  } catch {
    return null;
  }
}

export const VAULT_FILE_LIMIT = 3 * 1024 * 1024 - 1024;

/** Locks the sealed photo on this device, then saves the locked box. */
export async function savePhotoToVault(svc: ActiveService, me: VaultIdentity, p: PendingPhoto): Promise<void> {
  if (p.png.length > VAULT_FILE_LIMIT) throw new Error("This photo is too big for the vault (over 3 MB). Download it instead.");
  await svc.vault.save(me, p.png, { name: p.name, documentId: null, manifestDigest: null, kind: "photo", photoSealDigest: p.record.sealDigest });
  if (pending === p) setPendingPhoto({ ...p, savedToVault: true });
}

export function pngUrl(png: Uint8Array): string {
  return URL.createObjectURL(new Blob([png as BlobPart], { type: "image/png" }));
}
