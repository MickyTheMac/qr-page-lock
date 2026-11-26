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

## Target and look check (added 26 Nov)

- **Target.** For a licence or ID card (85.6 × 54 mm), passport photo page (125 × 88 mm) or A4 document, a frame of
  that shape is drawn over the camera. "Take and seal" stays off until the document's four edges sit on the frame
  (edge finding on a small grey copy of each frame, `photo/target.ts`). Only the frame area (plus a 4% margin) is kept.
  After 15 seconds a small "take it anyway" link appears; the seal then records `linedUp: false`.
- **Look check.** Before sealing, the device reads the words in the picture with Tesseract (served from PageLock's own
  site, `public/tesseract/`, about 7 MB on first use) and checks for the words that kind of document carries
  (`photo/looks.ts`). If they are missing, the person is told ("Hang on: PageLock can't see a driving licence…") and
  can retake or seal anyway. The result rides along in the seal (`capture.looks`) and is shown when checking.
  It catches mistakes, not forgeries.

## Reading the details off the document

For a driving licence, passport or ID card, the same on-device text reading also picks out the name, document
number, date of birth and expiry date (`src/lib/pagelock/photo/read.ts`), so the person does not type them:

- **Passports and ID cards:** the machine-readable lines at the bottom (ICAO 9303, TD3 and TD1). Their check digits
  are verified, and the result (`checkDigitsOk`) is shown and recorded.
- **Driving licences:** the numbered fields used on UK and EU licences (1 surname, 2 first names, 3 date of birth,
  4b expiry, 5 licence number), plus the UK licence number pattern. No check digits, so less reliable.

The person always sees what was read next to the picture and can correct it before sealing. The final values go into
`details` (`name`, `reference`, `born`, `expires`, the last three only when present) and `capture.read` records which
fields were read and which the person changed. Nothing is sent anywhere.

## Do the details add up?

`src/lib/pagelock/photo/consistency.ts` checks what was read (before the person corrects anything) against the
document's own rules:

- **Machine lines:** every ICAO check digit (number, birth, expiry, personal number, the whole line), letters and
  digits in their places (allowing the usual reader swaps such as O and 0), sex M/F/X/<.
- **UK licence number:** surname code (letters only, MAC as MC, padded with 9), birth date encoding (decade, month with
  +50 for women, day, year digit) and the initials, against the printed fields 1, 2 and 3.
- **Dates:** no birth in the future or over 120 years ago, no expiry before birth, issue date (4a) between birth and
  expiry. An expired document is flagged but not failed.

The first picture that does not add up asks for a clearer retake (glare can cause a misread). A second in a row is
marked as failed: the person can still seal it as a record, and the seal (`capture.format`), the strip and Check a copy
all say the details do not add up. Passing does not prove the document is genuine.
