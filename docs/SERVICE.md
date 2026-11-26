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

## Hosting: Vercel + a Postgres database of its own (free tiers)
The repo deploys to Vercel as one project: the static web app from `out/`, plus one function, `api/pagelock.ts`,
that answers every `/api/...` address (`vercel.json` rewrites them to it). Because a serverless host runs many
short-lived copies of the service, everything is kept in Postgres (`server/pg-store.ts`):

- `pagelock_kv`: authority keys, the register of issued certificates, pending email checks.
- `pagelock_log`: the private sign-off log. The database refuses `UPDATE`, `DELETE` and `TRUNCATE` on it.
- Every write runs in one transaction under a database-wide lock, so two copies can never fork the hash chain.
- Tables are created on first use; there is no migration step.

Give PageLock **its own database** (for example a second database inside an existing Neon project). Never share
another app's database: an app that resets its own schema would take the log with it.

Vercel environment variables:

| Name | Value |
| --- | --- |
| `PAGELOCK_DATABASE_URL` | the PageLock database's pooled connection string (secret) |
| `RESEND_API_KEY` | Resend API key (secret) |
| `PAGELOCK_MAIL_FROM` | e.g. `PageLock <pagelock@your-domain>`; Resend's test sender only delivers to the Resend account owner |
| `PAGELOCK_ALLOWED_ORIGIN` | the site's own address, e.g. `https://pagelock-xyz.vercel.app` |
| `NEXT_PUBLIC_PAGELOCK_SERVICE_URL` | the same address (built into the web app, so redeploy after changing it) |
| `PAGELOCK_ADMIN_TOKEN` | optional, a long random string; enables certificate revocation |
| `PAGELOCK_EMAIL_PEPPER` | optional but recommended before real users, a long random string; scrambles vault email addresses. Never change it once people use the vault |
| `PAGELOCK_SITE_URL` | optional, the site's address for vault invite emails (defaults to `PAGELOCK_ALLOWED_ORIGIN`) |

Without `PAGELOCK_DATABASE_URL` and `RESEND_API_KEY` the API answers 503 "not set up yet"; without
`NEXT_PUBLIC_PAGELOCK_SERVICE_URL` the site keeps using the in-browser demo service.

The database holds the authority's private keys: keep its connection string secret and turn on backups.

Tests against Postgres (throwaway database only, its PageLock tables are dropped):
```bash
PAGELOCK_TEST_DATABASE_URL=postgres://... npm run test:pg
PAGELOCK_DATABASE_URL=postgres://... NEXT_PUBLIC_PAGELOCK_SERVICE_URL=http://localhost:4180 npm run build && node scripts/e2e-hosted.cjs
```
`npm run server` also uses Postgres when `PAGELOCK_DATABASE_URL` is set, otherwise the private folder.

Before real use: privacy notice, data-protection review and an independent security review.
