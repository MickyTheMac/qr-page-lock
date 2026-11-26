# Sealed photos

A picture taken inside PageLock (`/photo`), sealed the moment it is taken.

1. **Camera only.** The page uses the live camera (`getUserMedia`). There is no gallery upload.
2. **Fingerprint.** The frame's exact RGB pixels (longest side at most 1280 px) are hashed:
   `SHA-256("PageLock photo pixels v1|<w>|<h>|" || RGB bytes)`.
3. **Seal.** A small JSON object (`pagelock-photo-seal` v1): pixel fingerprint and size, strip height, this device's
   clock, camera name, the details typed (what it is, document number, taken for, note) and a random salt.
   `sealDigest = SHA-256(canonical JSON of the seal)`.
4. **PageLock's clock.** Only `sealDigest` is sent: `POST /api/photo/seal`. The service records
   `photo:<digest> -> sealedAt` and returns an RFC 3161 timestamp token over the digest (same TSA as signatures).
   Asking again returns the first record. Public lookup: `GET /api/public/photo/<digest>` (time only).
5. **File.** A PNG (PageLock's own encoder, so pixels are exact): the photo, then a strip below it (never over it)
   with the time, short fingerprint and a QR code linking to `HTTPS://PAGELOCK-INDOL.VERCEL.APP/P/<digest>`.
   The seal, digest, time and token ride along in an `iTXt` chunk named `PageLock-Photo-Seal`.
6. **Vault.** "Save locked in my vault" locks the PNG on the device (same as sealed PDFs) before upload.

## Checking (Check a copy, or the vault's Open)

- the seal is inside the file;
- the picture part is exactly the sealed size and every pixel matches;
- the seal hashes to `sealDigest`, and PageLock's timestamp is over that digest;
- the timestamp is signed by a trusted PageLock clock (trust file);
- the QR code on the strip points to this seal (catches a swapped strip).

The words on the strip are not covered by the fingerprint; the checker shows the true details from inside the file.

## What it does not prove

- That what is in the picture is genuine (a sharp photo of a fake licence seals just as well).
- A determined person can fool a browser camera (fake camera device, photo of a screen).
- Messaging apps re-compress pictures and drop the seal: send the original file.
