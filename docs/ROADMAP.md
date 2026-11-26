# Roadmap notes

## Phase 2 — two-party signing (built, in review)
- Sign page: read every page, two explicit consent ticks, PAdES B-T signature in a new incremental revision.
- Verifier: trust, identity, coverage, revocation (CRL), timestamps, only-signatures-after-sealing. VERIFIED now possible.
- Evidence report PDF. Sign-off log ("signed, then double signed") on the PageLock service. See PROTOCOL.md §8, SERVICE.md.
- **Decided (Micky, 26 Nov 2026):** PageLock's own (free) certificates, issued after an email check.
- Still to do: hosting the service and an email sender (needs Micky's go-ahead), long-term validation (embedding
  revocation data, PAdES B-LT/LTA), optional Adobe-trusted certificates, DocMDP certification, privacy notice.

## Micky's idea: "scan, agree and log" (proposed for Phase 2/3)

**The idea in plain words:** when someone scans the last page's QR code, a website records that the document
was seen and agreed. When the other founder scans their copy and agrees, the log entry is signed again,
so the record is "signed, then double signed".

**Why it is a good fit:** the weakest point of Phase 1 is that each founder has to keep their own reference
file safe. A shared, append-only log would *be* the trusted reference that neither founder can quietly change.

**How it could work without breaking the privacy rules:**
1. The END page's QR (or every QR) also carries a short link like `https://pagelock.example/v#<docId>`.
   The part after `#` never leaves the phone, so scanning alone sends nothing.
2. The phone checks the page locally, then asks: "Do you agree to this document?" Only on an explicit yes
   does it send the log a small record: document ID, manifest digest, a timestamp request, and the founder's
   signature over that digest (passkey or certificate from Phase 2). **No wording, no file, no names.**
3. Founder A's entry = signed once. Founder B's entry references A's entry and signs both = "double signed".
   The log adds its own timestamp and countersignature.
4. The log is a hash chain (each entry includes the previous entry's hash), like certificate transparency,
   so deleting or reordering entries is detectable. Verifiers can check a document's digest against it.

**What it needs (so not Phase 1):** a server and storage, signer identity (Phase 2), a privacy notice and
data-protection review, and a decision on who runs the log. It does not change the Phase 1 page format: the
manifest digest it would log already exists.

**Decided (Micky, 26 Nov 2026):** agreeing happens **once for the whole document**, because the manifest
digest is already the aggregate of every page. Each founder's sign-off signs that one digest.

**Decided (Micky, 26 Nov 2026):** the sign-off log is **private to the two founders**. The only things made
public are each document's fingerprint (manifest digest) and the sign-off time, so anyone can later confirm
"this exact document was signed off at this time" without learning who signed or what it says.

## Phase 3
Mobile scanning of printed pages (with stated uncertainty), optional storage, white-label service, API,
possible SEQUR integration.
