# PageLock — every page accounted for

Prototype (Phases 1 and 2). A privacy-first web app that makes multi-page agreements tamper-evident.
Documents never leave the browser. Signing uses a small PageLock service for certificates, timestamps and the
sign-off log, which only ever sees fingerprints and hashes.

- **Create**: choose a PDF → PageLock gives it a random document ID, fingerprints every page (SHA-256),
  adds a 1.5-inch footer band under each page with a linked QR seal, and gives you the sealed PDF plus a
  **reference file** (and a receipt with the manifest digest) to keep safe.
- **Verify**: choose a PDF and, ideally, your reference file or digest. PageLock recomputes every fingerprint,
  checks order and links, and shows each check with one of five results:
  VERIFIED · REFERENCE MATCH · INTERNALLY CONSISTENT · ALTERED / INVALID · UNABLE TO VERIFY.
- **Sign**: each founder reads every page, ticks two consent boxes and adds a PAdES signature (with a trusted
  timestamp). Then they record the sign-off in the log: founder B's entry countersigns founder A's ("signed, then
  double signed"). Only the fingerprint and sign-off time are public.
- **VERIFIED** appears when every page checks out and both founders' signatures are valid, trusted and timestamped.
  Verify can also download an **evidence report** PDF listing every check.

Identity is only as strong as the certificates: PageLock's own certificates show control of an email address and a
key on the signer's device. PageLock is not legal advice.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 90 acceptance tests (Node)
npm run server     # PageLock service on :8787 (see docs/SERVICE.md)
npm run build      # static site in ./out (host anywhere, or `npm start`)
node scripts/e2e.cjs   # browser end-to-end checks in Chromium (after build)
node scripts/e2e-signing.cjs dist-standalone   # full two-founder signing flow in Chromium (after build:standalone, copy pagelock.html to index.html)
npm run fixtures   # regenerate ./fixtures (tampered sample PDFs + expected results)
npm run build:standalone  # whole app as one HTML file in ./dist-standalone (used for the try-out link)
```

## Where things are

| Path | What |
| --- | --- |
| `src/lib/pagelock/` | The protocol: page representation, hashing, QR payload, footer, manifest, create, verify |
| `src/lib/pagelock/sign/` | PAdES signing and validation, certificates, timestamps, trust files |
| `src/lib/pagelock/service/` | PageLock service (certificates, timestamps, sign-off log) and its browser client |
| `server/` | Node entry point for the service |
| `src/app/` | Home, Create, Sign and Verify screens |
| `tests/` | Acceptance tests (brief §12) and tampering helpers |
| `fixtures/` | Sample agreement, sealed copy, reference file and 14 tampered variants with expected results |
| `docs/PROTOCOL.md` | Protocol v1 in detail, design decisions and known limits |
| `docs/ROADMAP.md` | Phase 2/3 notes, including the "scan, agree and log" idea |

Pinned dependencies (exact versions): Next.js 16.4.6, pdf-lib 1.17.1, pdfjs-dist 6.5.438, qrcode 1.5.4, jsQR 1.4.0,
PKI.js 3.4.3, asn1js 3.0.10.
An independent security review is required before any production use.
