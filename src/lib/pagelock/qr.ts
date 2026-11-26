import QRCode from "qrcode";
import jsQR from "jsqr";
import { END, PROTOCOL, START } from "./constants";

/**
 * QR payload (brief §5): protocol version, document ID, page index, page count,
 * full current hash, previous hash, next hash. Uses only QR "alphanumeric" characters
 * (0-9 A-Z :) so the code stays as small as possible for printing and scanning.
 * The manifest that binds the whole sequence is embedded in the PDF and its digest is
 * what the trusted reference holds.
 *
 *   PL1:<docId>:<index>:<count>:<hash>:<prev|START>:<next|END>
 */
export interface QrPayload {
  version: string;
  documentId: string;
  index: number; // 1-based
  count: number;
  hash: string;
  prev: string; // hash or START
  next: string; // hash or END
}

const HASH = "[0-9A-F]{64}";
const PAYLOAD_RE = new RegExp(
  `^(PL1):([0-9A-HJKMNP-TV-Z]{24}):([1-9][0-9]{0,4}):([1-9][0-9]{0,4}):(${HASH}):(${HASH}|${START}):(${HASH}|${END})$`,
);

export function encodePayload(p: QrPayload): string {
  return [p.version, p.documentId, p.index, p.count, p.hash, p.prev, p.next].join(":");
}

/** Strict parser. Returns null for anything that is not an exact PL1 payload. */
export function parsePayload(text: string): QrPayload | null {
  const m = PAYLOAD_RE.exec(text);
  if (!m) return null;
  const p: QrPayload = {
    version: m[1],
    documentId: m[2],
    index: Number(m[3]),
    count: Number(m[4]),
    hash: m[5],
    prev: m[6],
    next: m[7],
  };
  if (p.version !== PROTOCOL || p.index > p.count) return null;
  if ((p.index === 1) !== (p.prev === START)) return null;
  if ((p.index === p.count) !== (p.next === END)) return null;
  return p;
}

export const QUIET_ZONE = 4;

/** QR as a 1-bit DeviceGray bitmap, 1 pixel per module, with quiet zone. 0 = black. */
/**
 * QR as a 1-bit DeviceGray bitmap, 1 pixel per module. `quiet` is the white border built into
 * the image: layouts 1-2 used 4 modules; layout 3 uses 0 and leaves real white space around the
 * code instead, so the printed code is smaller with the same module size.
 */
export function qrBitmap(text: string, quiet: number = QUIET_ZONE): { size: number; bits: Uint8Array } {
  const qr = QRCode.create(text, { errorCorrectionLevel: "M" });
  const m = qr.modules.size;
  const size = m + quiet * 2;
  const rowBytes = Math.ceil(size / 8);
  const bits = new Uint8Array(rowBytes * size).fill(0xff);
  for (let y = 0; y < m; y++) {
    for (let x = 0; x < m; x++) {
      if (qr.modules.get(y, x)) {
        const px = x + quiet;
        const py = y + quiet;
        bits[py * rowBytes + (px >> 3)] &= ~(0x80 >> (px & 7));
      }
    }
  }
  return { size, bits };
}

/** Decode a 1-bit bitmap (as stored in the PDF) back to text using jsQR. */
export function decodeQrBitmap(bits: Uint8Array, width: number, height: number): string | null {
  const scale = 4;
  const pad = 16; // 4 modules of white around the code, needed when the image has no quiet zone
  const W = width * scale + pad * 2;
  const H = height * scale + pad * 2;
  const rgba = new Uint8ClampedArray(W * H * 4).fill(255);
  const rowBytes = Math.ceil(width / 8);
  if (bits.length < rowBytes * height) return null;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const black = ((bits[y * rowBytes + (x >> 3)] >> (7 - (x & 7))) & 1) === 0;
      if (!black) continue;
      for (let dy = 0; dy < scale; dy++) {
        for (let dx = 0; dx < scale; dx++) {
          const o = ((pad + y * scale + dy) * W + pad + x * scale + dx) * 4;
          rgba[o] = rgba[o + 1] = rgba[o + 2] = 0;
        }
      }
    }
  }
  const res = jsQR(rgba, W, H, { inversionAttempts: "dontInvert" });
  return res ? res.data : null;
}
