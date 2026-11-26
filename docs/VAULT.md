# PageLock vault

Save sealed agreements so either signer can get them back later, on any device, without PageLock ever being
able to read them. Plan and decisions: see the "PageLock: private document vault plan" document (26 Nov 2026).

## What the server holds

| Kept | Readable by PageLock? |
| --- | --- |
| Account name = HMAC-SHA256 of the email address (keyed with `PAGELOCK_EMAIL_PEPPER`, or a secret kept in the database) | No address is stored. The typed address is used once to send the code. |
| Login codes (hashed), sessions (hashed tokens) | No |
| Each person's padlock (X-Wing public key) | Public by design |
| Each person's root, locked by a passkey (optional) | No: needs the passkey |
| Locked files, locked details (name, fingerprint), locked labels | No: AES-256-GCM with a per-document key |
| Per-person wrapped document keys | No: X-Wing (X25519 + ML-KEM-768) |
| Sizes, dates, and which accounts share a document | Yes |

Tested: `tests/vault.test.ts` dumps every stored row (memory and Postgres) and checks it contains no email
address, file name, fingerprint, document ID or PDF bytes.

## Keys

- **Root**: 32 random bytes made on the device, shown once as 24 recovery words (BIP-39 English list).
- **Padlock**: X-Wing key pair derived from the root with HKDF, so the words alone restore everything.
- **Document key**: 32 random bytes per document. File and details: AES-256-GCM, bound to the document number.
- **Wrap**: X-Wing encapsulation to the recipient's padlock, HKDF, AES-256-GCM, bound to document and padlock.
- **This device**: the root is kept locked by a non-extractable Web Crypto key in IndexedDB, until Lock or Log out.
- **Passkey** (WebAuthn PRF): the passkey's secret locks a copy of the root; the server stores that locked copy.
- **Safety code**: 20 digits from SHA-256 of both padlocks. Both people see the same code; compare once by phone
  or in person before giving access. This stops a hacked server slipping in a fake padlock.

## Flows

1. Log in: email, 6-digit code (15 minutes, 5 tries, 5 codes per 15 minutes, single use). Session 30 days.
2. First time: recovery sheet, check two words, padlock uploaded. Optionally add a passkey.
3. Save: only PageLock-sealed PDFs that pass the checks; up to 3 MB. Locked here, then uploaded.
4. Share: type the other signer's email. If they have no vault they are emailed an invite. When they have one,
   any signer who holds the key can "give access" after comparing the safety code.
5. Open: download, unlock here, re-check the fingerprint saved with it, then save the PDF.
6. Lost everything: log in by email and "start again with new keys". Old wrapped keys are cleared; the other
   signer gives access again (with a new safety code).
7. Remove: takes the document out of your vault only. The locked file is deleted when nobody with a key is left.

## API (all JSON; `Authorization: Bearer <token>` after login)

`POST /api/auth/start {email}` · `POST /api/auth/finish {loginId, code}` · `POST /api/auth/logout` ·
`GET /api/vault/account` · `POST /api/vault/account/key {publicKey, replace?}` ·
`POST /api/vault/account/passkeys {id, salt, lockedRoot, keyFp}` · `POST /api/vault/account/passkeys/:id/remove` ·
`GET /api/vault/docs` · `POST /api/vault/docs {id, meta, file, wrap, wrapFor}` · `GET /api/vault/docs/:id/file` ·
`POST /api/vault/docs/:id/members {email, label}` · `POST /api/vault/docs/:id/members/:memberId/access {wrap, wrapFor}` ·
`POST /api/vault/docs/:id/remove`

## Storage

Postgres tables `pagelock_vault_*` in PageLock's own database (created on first use). Locked files are kept in
the database for now: an agreement is usually well under 1 MB, so Neon's free 0.5 GB holds hundreds, with no
extra service. Moving files to Cloudflare R2 later only means a new `VaultStore` for `getFile`/`createDoc`.

## Limits (honest)

- The website code does the locking. A hacked or dishonest future version of the site could copy keys while
  someone uses it. Publish releases openly and get an independent review before advertising the promise.
- Someone holding an unlocked device, or the other signer, can of course read the document.
- Codes and invites reach only the Resend account owner until a domain is verified in Resend.
