/**
 * Sealed photos: a picture taken inside PageLock is fingerprinted, timestamped by PageLock (which only ever sees the
 * fingerprint), and saved as a PNG with a strip and QR code below it. One changed pixel must fail the check.
 */
import { beforeAll, describe, expect, it } from "vitest";
import {
  MemoryStore,
  PageLockClient,
  PageLockService,
  PHOTO_CHUNK,
  PhotoSealRecord,
  RgbImage,
  TrustProfile,
  assembleSealedPng,
  checkSealedPhoto,
  decodePng,
  encodePng,
  inPageFetch,
  makeSeal,
  parsePhotoLink,
  photoLink,
  sealPhoto,
  stripLayout,
} from "../src/lib/pagelock";

let service: PageLockService;
let client: PageLockClient;
let trust: TrustProfile;
const seen: string[] = [];

function fakePhoto(width = 320, height = 240, seed = 1): RgbImage {
  const rgb = new Uint8Array(width * height * 3);
  let s = seed;
  for (let i = 0; i < rgb.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    rgb[i] = ((i % (width * 3)) / 3 + (s >> 24)) & 255;
  }
  return { width, height, rgb };
}

async function sealed(photo = fakePhoto(), details = { what: "Driving licence", reference: "MORGA753116SM9IJ", takenFor: "Acme Ltd", note: "" }) {
  const seal = await makeSeal(photo, { details, camera: "Test camera" });
  const s = await sealPhoto(photo, seal, (d) => client.sealPhoto(d));
  return { photo, record: s.record, png: assembleSealedPng(photo, s.stripBase, s.record) };
}

/** Rewrites the PNG with changed pixels and/or a changed record. */
function rewrite(png: Uint8Array, change: (img: { width: number; height: number; rgb: Uint8Array }, rec: PhotoSealRecord) => void) {
  const d = decodePng(png);
  const rec = JSON.parse(d.texts.find((t) => t.keyword === PHOTO_CHUNK)!.text) as PhotoSealRecord;
  const img = { width: d.width, height: d.height, rgb: d.rgb };
  change(img, rec);
  return encodePng(img.rgb, img.width, img.height, [{ keyword: PHOTO_CHUNK, text: JSON.stringify(rec) }]);
}

beforeAll(async () => {
  service = await PageLockService.create({ store: new MemoryStore(), mailer: { send: async () => undefined } });
  const f = inPageFetch(service);
  client = new PageLockClient("https://service.test", async (input, init) => {
    if (typeof init?.body === "string") seen.push(init.body);
    return f(input, init);
  });
  trust = await client.trust();
});

describe("PNG", () => {
  it("round-trips pixels exactly, with the text chunk", () => {
    const p = fakePhoto(97, 31);
    const png = encodePng(p.rgb, p.width, p.height, [{ keyword: "k", text: "héllo" }]);
    const d = decodePng(png);
    expect(d.width).toBe(97);
    expect(d.height).toBe(31);
    expect(Buffer.from(d.rgb).equals(Buffer.from(p.rgb))).toBe(true);
    expect(d.texts).toEqual([{ keyword: "k", text: "héllo" }]);
  });
});

describe("sealed photos", () => {
  it("a freshly sealed photo checks as sealed and unchanged, with PageLock's time", async () => {
    const { png, record } = await sealed();
    const r = await checkSealedPhoto(png, trust);
    expect(r.outcome).toBe("SEALED AND UNCHANGED");
    expect(r.checks.every((c) => c.status === "pass")).toBe(true);
    expect(r.trustedTime).toBe(new Date(record.sealedAt).toISOString());
    expect(r.record?.seal.details.what).toBe("Driving licence");
    expect(r.photo?.height).toBe(240);
  });

  it("PageLock receives only the fingerprint, never the photo or the details", async () => {
    seen.length = 0;
    const { record } = await sealed();
    expect(seen).toEqual([JSON.stringify({ sealDigest: record.sealDigest })]);
    expect(seen.join()).not.toMatch(/licence|MORGA|Acme/i);
  });

  it("the public record shows when it was sealed, and the QR link points to it", async () => {
    const { record } = await sealed();
    expect(await client.publicPhoto(record.sealDigest)).toEqual({ sealDigest: record.sealDigest, sealedAt: record.sealedAt });
    expect(await client.publicPhoto("A".repeat(64))).toBeNull();
    expect(parsePhotoLink(photoLink(record.sealDigest))).toBe(record.sealDigest);
    expect(parsePhotoLink(photoLink(record.sealDigest).toLowerCase())).toBe(record.sealDigest);
  });

  it("asking twice for the same fingerprint keeps the first time", async () => {
    const { record } = await sealed();
    const again = await client.sealPhoto(record.sealDigest);
    expect(again.sealedAt).toBe(record.sealedAt);
  });

  it("one changed pixel fails", async () => {
    const { png } = await sealed();
    const bad = rewrite(png, (img) => (img.rgb[1000] ^= 1));
    const r = await checkSealedPhoto(bad, trust);
    expect(r.outcome).toBe("CHANGED");
    expect(r.checks.find((c) => c.label.startsWith("The picture"))?.status).toBe("fail");
  });

  it("cropping fails", async () => {
    const { png } = await sealed();
    const bad = rewrite(png, (img) => {
      img.height -= 1;
      img.rgb = img.rgb.slice(img.width * 3);
    });
    expect((await checkSealedPhoto(bad, trust)).outcome).toBe("CHANGED");
  });

  it("editing the details or the capture time inside the file fails", async () => {
    const { png } = await sealed();
    const a = rewrite(png, (_i, rec) => (rec.seal.details.reference = "SOMEONE ELSE"));
    expect((await checkSealedPhoto(a, trust)).outcome).toBe("CHANGED");
    const b = rewrite(png, (_i, rec) => (rec.seal.capturedAt = "2020-01-01T00:00:00.000Z"));
    expect((await checkSealedPhoto(b, trust)).outcome).toBe("CHANGED");
  });

  it("re-sealing with a made-up fingerprint fails (the timestamp was for different details)", async () => {
    const { png } = await sealed();
    const bad = rewrite(png, (img, rec) => {
      img.rgb[5] ^= 1;
      rec.seal.photo.pixelsSha256 = "0".repeat(64);
      rec.sealDigest = "F".repeat(64);
    });
    expect((await checkSealedPhoto(bad, trust)).outcome).toBe("CHANGED");
  });

  it("a strip swapped from another sealed photo fails", async () => {
    const one = await sealed(fakePhoto(320, 240, 1));
    const two = await sealed(fakePhoto(320, 240, 2));
    const H = 240 * 320 * 3;
    const twoPixels = decodePng(two.png).rgb;
    const bad = rewrite(one.png, (img) => img.rgb.set(twoPixels.subarray(H), H));
    const r = await checkSealedPhoto(bad, trust);
    expect(r.outcome).toBe("CHANGED");
    expect(r.checks.find((c) => c.label.includes("QR"))?.status).toBe("fail");
  });

  it("a copy without the seal (e.g. sent through a messaging app) is reported as no seal found", async () => {
    const { png } = await sealed();
    const d = decodePng(png);
    const stripped = encodePng(d.rgb, d.width, d.height);
    expect((await checkSealedPhoto(stripped, trust)).outcome).toBe("NO SEAL FOUND");
    expect((await checkSealedPhoto(new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6]), trust)).outcome).toBe("NO SEAL FOUND");
  });

  it("without a trusted clock it is not called sealed", async () => {
    const { png } = await sealed();
    expect((await checkSealedPhoto(png, null)).outcome).toBe("NOT TRUSTED");
    const other = await PageLockService.create({ store: new MemoryStore(), mailer: { send: async () => undefined } });
    const otherTrust = await new PageLockClient("https://other.test", inPageFetch(other)).trust();
    expect((await checkSealedPhoto(png, otherTrust)).outcome).toBe("NOT TRUSTED");
  });

  it("a full-size photo stays small enough for the vault", async () => {
    const p = fakePhoto(1280, 960, 7);
    const { png } = await sealed(p);
    expect(stripLayout(1280).height).toBeGreaterThan(150);
    // Random noise is the worst case for PNG; a real photo compresses better.
    expect(png.length).toBeLessThan(3 * 1024 * 1024 + 800_000);
  });
});
