# PageLock — every page accounted for

Phase 1 prototype. A privacy-first web app that makes multi-page agreements tamper-evident.
Everything runs in the browser: no accounts, no database, no uploads.

- **Create**: choose a PDF → PageLock gives it a random document ID, fingerprints every page (SHA-256),
  adds a 1-inch footer band under each page with a linked QR seal, and gives you the sealed PDF plus a
  **reference file** (and a receipt with the manifest digest) to keep safe.
- **Verify**: choose a PDF and, ideally, your reference file or digest. PageLock recomputes every fingerprint,
  checks order and links, and shows each check with one of five results:
  VERIFIED · REFERENCE MATCH · INTERNALLY CONSISTENT · ALTERED / INVALID · UNABLE TO VERIFY.
  (VERIFIED needs signatures, which arrive in Phase 2, so Phase 1 never shows it.)

PageLock shows whether pages changed. It does **not** prove who signed and is not legal advice.

## Run it

```bash
npm install
npm run dev        # http://localhost:3000
npm test           # 46 acceptance tests (Node)
npm run build      # static site in ./out (host anywhere, or `npm start`)
node scripts/e2e.cjs   # browser end-to-end checks in Chromium (after build)
npm run fixtures   # regenerate ./fixtures (tampered sample PDFs + expected results)
npm run build:standalone  # whole app as one HTML file in ./dist-standalone (used for the try-out link)
```

## Where things are

| Path | What |
| --- | --- |
| `src/lib/pagelock/` | The protocol: page representation, hashing, QR payload, footer, manifest, create, verify |
| `src/app/` | Home, Create and Verify screens |
| `tests/` | Acceptance tests (brief §12) and tampering helpers |
| `fixtures/` | Sample agreement, sealed copy, reference file and 14 tampered variants with expected results |
| `docs/PROTOCOL.md` | Protocol v1 in detail, design decisions and known limits |
| `docs/ROADMAP.md` | Phase 2/3 notes, including the "scan, agree and log" idea |

Pinned dependencies (exact versions): Next.js 16.4.6, pdf-lib 1.17.1, pdfjs-dist 6.5.438, qrcode 1.5.4, jsQR 1.4.0.
An independent security review is required before any production use.
