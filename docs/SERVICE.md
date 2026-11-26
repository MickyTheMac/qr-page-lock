# PageLock service (Phase 2)

A small server, `server/main.ts`, that does four things. The PDF and its wording never reach it.

| Job | Endpoint | What it receives |
| --- | --- | --- |
| Issue founders' signing certificates after an email check | `POST /api/enrol/start`, `POST /api/enrol/finish` | name, email, public key (the private key stays in the founder's browser) |
| Publish the trust file and revocation list | `GET /api/trust`, `GET /api/crl` | nothing |
| RFC 3161 timestamps | `POST /api/timestamp` | a 32-byte hash |
| Private sign-off log | `POST /api/signoff`, `GET /api/signoff/<fingerprint>` (founders only) | fingerprint, document ID, page count, hash of the signed file, certificate, signature |
| Public record | `GET /api/public/<fingerprint>` | returns only `{manifestDigest, signedOff, signedOffAt}`, and only once all founders signed off |
| Revoke a certificate | `POST /api/admin/revoke` (admin token) | certificate serial |

## Who can read the log
- A founder with an entry for that fingerprint reads all entries for it and can check them independently
  (`checkDocumentLog`: hash chain, the log's countersignature, each founder's signature, the countersign link).
- The second founder, before signing off, learns only the hash they must countersign, not who signed.
- Anyone else gets nothing beyond the public record. Reading needs a fresh signature from a PageLock certificate.

## Trust model (honest)
- Certificates show that the signer controlled the email address and the key on their device. Adobe Reader will
  show "signer unknown" because the PageLock authority is not on Adobe's list; PageLock's own verifier checks it fully.
  Paid, Adobe-trusted certificates can be added later without changing the PDF format (add their authority to the
  trust file).
- The timestamp service is PageLock's own. A public timestamp service can replace it (`httpTimestampSource(url)`).
- Whoever runs the server holds the authority key. Keep `PAGELOCK_DATA_DIR` private and backed up.

## Run locally
```bash
npm run server              # http://localhost:8787, email codes printed in this terminal
NEXT_PUBLIC_PAGELOCK_SERVICE_URL=http://localhost:8787 npm run dev
```
Without `NEXT_PUBLIC_PAGELOCK_SERVICE_URL`, the app uses a **demo service inside the browser** (codes shown on
screen, keys in browser storage, marked DEMO everywhere). The try-out link uses that.

## Hosting (not set up yet: needs Micky's go-ahead)
Needs: one small always-on Node process with a private persistent folder (or a database), HTTPS, and an email
sender for the codes (e.g. Resend: set `RESEND_API_KEY` and `PAGELOCK_MAIL_FROM`). Before real use: privacy
notice, data-protection review and an independent security review.
