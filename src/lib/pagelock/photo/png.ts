/**
 * A tiny PNG writer and reader, so a sealed photo's pixels come out EXACTLY the same on every device.
 * (A browser's own image decoder may apply colour management; this one never does.)
 *
 * Writes 8-bit RGB, non-interlaced, with one zlib stream and an iTXt text chunk for the seal.
 * Reads 8-bit RGB / RGBA non-interlaced PNGs (anything PageLock wrote, and most simple re-saves).
 */
import pako from "pako";
import { concatBytes, utf8 } from "../encoding";

const SIGNATURE = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);

let CRC_TABLE: Uint32Array | null = null;
function crc32(data: Uint8Array): number {
  if (!CRC_TABLE) {
    CRC_TABLE = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      CRC_TABLE[n] = c >>> 0;
    }
  }
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  return new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const td = concatBytes([utf8(type), data]);
  return concatBytes([u32(data.length), td, u32(crc32(td))]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export interface PngText {
  keyword: string;
  text: string;
}

/** Encodes RGB pixels (3 bytes per pixel, rows top to bottom) as a PNG. */
export function encodePng(rgb: Uint8Array, width: number, height: number, texts: PngText[] = []): Uint8Array {
  if (rgb.length !== width * height * 3) throw new Error("Pixel data does not match the image size.");
  const stride = width * 3;
  const raw = new Uint8Array((stride + 1) * height);
  const line = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const cur = rgb.subarray(y * stride, (y + 1) * stride);
    const prev = y > 0 ? rgb.subarray((y - 1) * stride, y * stride) : null;
    // Pick the filter that gives the smallest sum of absolute values (the usual heuristic).
    let best = 0;
    let bestScore = Infinity;
    let bestLine: Uint8Array = cur;
    for (let f = 0; f < 5; f++) {
      let score = 0;
      const out = f === 0 ? cur : line;
      if (f !== 0) {
        for (let i = 0; i < stride; i++) {
          const a = i >= 3 ? cur[i - 3] : 0;
          const b = prev ? prev[i] : 0;
          const c = prev && i >= 3 ? prev[i - 3] : 0;
          const pred = f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
          line[i] = (cur[i] - pred) & 255;
        }
      }
      for (let i = 0; i < stride; i++) score += out[i] < 128 ? out[i] : 256 - out[i];
      if (score < bestScore) {
        bestScore = score;
        best = f;
        bestLine = f === 0 ? cur : line.slice();
      }
    }
    raw[y * (stride + 1)] = best;
    raw.set(bestLine, y * (stride + 1) + 1);
  }
  const ihdr = concatBytes([u32(width), u32(height), new Uint8Array([8, 2, 0, 0, 0])]);
  const textChunks = texts.map((t) =>
    // iTXt: keyword, 0, compression flag 0, method 0, empty language tag, 0, empty translated keyword, 0, text
    chunk("iTXt", concatBytes([utf8(t.keyword), new Uint8Array([0, 0, 0, 0, 0]), utf8(t.text)])),
  );
  return concatBytes([
    SIGNATURE,
    chunk("IHDR", ihdr),
    ...textChunks,
    chunk("IDAT", pako.deflate(raw, { level: 9 })),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

export class PngError extends Error {}

export interface DecodedPng {
  width: number;
  height: number;
  /** 3 bytes per pixel. Any alpha channel is dropped. */
  rgb: Uint8Array;
  texts: PngText[];
  /** False if the PNG has an alpha channel that is not fully opaque everywhere. */
  opaque: boolean;
}

export function isPng(bytes: Uint8Array): boolean {
  return bytes.length > 8 && SIGNATURE.every((b, i) => bytes[i] === b);
}

export function decodePng(bytes: Uint8Array, maxPixels = 40_000_000): DecodedPng {
  if (!isPng(bytes)) throw new PngError("This is not a PNG image.");
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  const texts: PngText[] = [];
  const dec = new TextDecoder();
  while (pos + 12 <= bytes.length) {
    const len = dv.getUint32(pos);
    const type = dec.decode(bytes.subarray(pos + 4, pos + 8));
    if (pos + 12 + len > bytes.length) throw new PngError("This PNG is cut short.");
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + len)) !== dv.getUint32(pos + 8 + len)) throw new PngError("This PNG is damaged.");
    pos += 12 + len;
    if (type === "IHDR") {
      if (len !== 13) throw new PngError("This PNG is damaged.");
      width = ((data[0] << 24) | (data[1] << 16) | (data[2] << 8) | data[3]) >>> 0;
      height = ((data[4] << 24) | (data[5] << 16) | (data[6] << 8) | data[7]) >>> 0;
      const [depth, ct, , , interlace] = data.subarray(8, 13);
      if (depth !== 8 || (ct !== 2 && ct !== 6) || interlace !== 0) throw new PngError("This PNG uses a format PageLock never writes.");
      colorType = ct;
      if (!width || !height || width * height > maxPixels) throw new PngError("This image is too big.");
    } else if (type === "IDAT") idat.push(data);
    else if (type === "iTXt") {
      const z = data.indexOf(0);
      if (z < 0 || data[z + 1] !== 0) continue; // compressed iTXt is never written by PageLock
      let p = z + 3;
      p = data.indexOf(0, p) + 1; // language tag
      p = data.indexOf(0, p) + 1; // translated keyword
      if (p <= 0) continue;
      texts.push({ keyword: dec.decode(data.subarray(0, z)), text: dec.decode(data.subarray(p)) });
    } else if (type === "IEND") break;
  }
  if (colorType < 0 || !idat.length) throw new PngError("This PNG has no picture in it.");
  const bpp = colorType === 6 ? 4 : 3;
  const stride = width * bpp;
  let raw: Uint8Array;
  try {
    raw = pako.inflate(concatBytes(idat));
  } catch {
    throw new PngError("This PNG's picture data is damaged.");
  }
  if (raw.length < (stride + 1) * height) throw new PngError("This PNG's picture data is cut short.");
  const px = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const f = raw[y * (stride + 1)];
    const src = raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1));
    const o = y * stride;
    for (let i = 0; i < stride; i++) {
      const a = i >= bpp ? px[o + i - bpp] : 0;
      const b = y > 0 ? px[o - stride + i] : 0;
      const c = y > 0 && i >= bpp ? px[o - stride + i - bpp] : 0;
      let v: number;
      if (f === 0) v = src[i];
      else if (f === 1) v = src[i] + a;
      else if (f === 2) v = src[i] + b;
      else if (f === 3) v = src[i] + ((a + b) >> 1);
      else if (f === 4) v = src[i] + paeth(a, b, c);
      else throw new PngError("This PNG's picture data is damaged.");
      px[o + i] = v & 255;
    }
  }
  if (bpp === 3) return { width, height, rgb: px, texts, opaque: true };
  const rgb = new Uint8Array(width * height * 3);
  let opaque = true;
  for (let i = 0, j = 0; i < px.length; i += 4, j += 3) {
    rgb[j] = px[i];
    rgb[j + 1] = px[i + 1];
    rgb[j + 2] = px[i + 2];
    if (px[i + 3] !== 255) opaque = false;
  }
  return { width, height, rgb, texts, opaque };
}
