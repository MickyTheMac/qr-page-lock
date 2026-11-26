/** Final evidence report (brief §11, Phase 2): a PDF listing every check, every signature and the sign-off log. */
import { PDFDocument, PDFFont, StandardFonts, rgb } from "pdf-lib";
import { groupDocId } from "./encoding";
import type { LogCheck } from "./service/log";
import type { VerifyReport } from "./verify";

export interface EvidenceOptions {
  fileName?: string;
  log?: (LogCheck & { publicSignedOffAt?: string | null }) | null;
  generatedAt?: Date;
}

const STATUS_TEXT: Record<string, string> = {
  pass: "PASS",
  fail: "FAIL",
  inconclusive: "INCONCLUSIVE",
  "not-provided": "NOT PROVIDED",
  "not-available": "NOT AVAILABLE",
};

/** Keep to characters the standard Helvetica font can draw. */
function clean(s: string): string {
  return s
    .replace(/[‘’]/g, "'")
    .replace(/[“”]/g, '"')
    .replace(/[–—]/g, "-")
    .replace(/↔/g, "<->")
    .replace(/…/g, "...")
    .replace(/[^\x20-\x7e\xa0-\xff]/g, "?");
}

export async function evidenceReport(r: VerifyReport, o: EvidenceOptions = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  doc.setTitle("PageLock evidence report");
  doc.setProducer("PageLock");
  doc.setCreator("PageLock");
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const bold = await doc.embedFont(StandardFonts.HelveticaBold);
  const mono = await doc.embedFont(StandardFonts.Courier);
  const W = 595.28;
  const H = 841.89;
  const M = 50;
  let page = doc.addPage([W, H]);
  let y = H - M;

  const need = (h: number) => {
    if (y - h < M) {
      page = doc.addPage([W, H]);
      y = H - M;
    }
  };
  const wrap = (text: string, f: PDFFont, size: number, width: number) => {
    const words = clean(text).split(/\s+/);
    const lines: string[] = [];
    let cur = "";
    for (const w of words) {
      const t = cur ? cur + " " + w : w;
      if (f.widthOfTextAtSize(t, size) <= width) cur = t;
      else {
        if (cur) lines.push(cur);
        let rest = w;
        while (f.widthOfTextAtSize(rest, size) > width) {
          let n = rest.length;
          while (n > 1 && f.widthOfTextAtSize(rest.slice(0, n), size) > width) n--;
          lines.push(rest.slice(0, n));
          rest = rest.slice(n);
        }
        cur = rest;
      }
    }
    if (cur) lines.push(cur);
    return lines;
  };
  const text = (s: string, opt: { f?: PDFFont; size?: number; x?: number; color?: [number, number, number]; gap?: number } = {}) => {
    const f = opt.f ?? font;
    const size = opt.size ?? 9.5;
    const x = opt.x ?? M;
    for (const line of wrap(s, f, size, W - M - x)) {
      need(size + 3);
      page.drawText(line, { x, y: y - size, size, font: f, color: rgb(...(opt.color ?? [0.1, 0.1, 0.1])) });
      y -= size + 3;
    }
    y -= opt.gap ?? 0;
  };
  const field = (k: string, v: string, m = false) => {
    need(14);
    page.drawText(clean(k), { x: M, y: y - 9.5, size: 9.5, font: bold });
    const lines = wrap(v, m ? mono : font, m ? 8.5 : 9.5, W - M - (M + 130));
    for (const l of lines) {
      need(13);
      page.drawText(l, { x: M + 130, y: y - 9.5, size: m ? 8.5 : 9.5, font: m ? mono : font });
      y -= 13;
    }
  };
  const heading = (s: string) => {
    y -= 8;
    need(24);
    text(s, { f: bold, size: 12.5, gap: 4 });
  };

  text("PageLock evidence report", { f: bold, size: 20, gap: 4 });
  text(`Generated ${(o.generatedAt ?? new Date()).toISOString()}${o.fileName ? ` for "${o.fileName}"` : ""}.`, { color: [0.35, 0.35, 0.35], gap: 10 });

  const good = r.outcome === "VERIFIED" || r.outcome === "REFERENCE MATCH";
  const bad = r.outcome === "ALTERED / INVALID";
  need(40);
  page.drawRectangle({ x: M, y: y - 30, width: W - 2 * M, height: 30, color: bad ? rgb(0.86, 0.15, 0.15) : good ? rgb(0.02, 0.59, 0.41) : rgb(0.35, 0.35, 0.4) });
  page.drawText(r.outcome, { x: M + 12, y: y - 20, size: 14, font: bold, color: rgb(1, 1, 1) });
  y -= 40;
  text(r.summary, { gap: 6 });

  heading("Document");
  field("Document ID", r.documentId ? groupDocId(r.documentId) : "unknown");
  field("Fingerprint", r.manifestDigest ?? "not established", true);
  field("Pages", String(r.pageCount));
  field("File SHA-256", r.fileSha256, true);
  if (r.sealedSha256 !== r.fileSha256) field("Sealed original", r.sealedSha256, true);
  field("Trust file", r.trustName ? `${r.trustName}${r.trustIsDemo ? " (DEMO: keys are public, proves nothing about identity)" : ""}` : "none loaded");

  heading(`Signatures (${r.signatures.length}, ${r.requiredSigners} required)`);
  if (!r.signatures.length) text("No signatures.");
  for (const s of r.signatures) {
    text(`${s.index}. ${s.signerName}${s.signerEmail ? ` <${s.signerEmail}>` : ""}  -  ${s.valid ? "VALID" : "NOT FULLY VALID"}`, { f: bold, gap: 1 });
    field("Issued by", s.issuerName);
    field("Certificate", s.certificateSha256 ?? "unknown", true);
    field("Trusted time", s.timestampTime ? `${s.timestampTime} (${s.timestampAuthority ?? "unknown authority"})` : "none");
    field("Signer's clock", s.claimedTime ?? "none");
    field(
      "Checks",
      `integrity ${STATUS_TEXT[s.integrity]}, consent ${STATUS_TEXT[s.consent]}, trust ${STATUS_TEXT[s.trust]}, revocation ${STATUS_TEXT[s.revocation]}, timestamp ${STATUS_TEXT[s.timestamp]}, covers ${s.coversWholeFile ? "whole file" : "its revision"}`,
    );
    for (const p of s.problems) text("- " + p, { x: M + 130, color: [0.45, 0.2, 0.1] });
    y -= 4;
  }

  heading("Every check");
  for (const c of r.checks) {
    need(16);
    const st = STATUS_TEXT[c.status];
    const col: [number, number, number] = c.status === "pass" ? [0.02, 0.45, 0.3] : c.status === "fail" ? [0.75, 0.1, 0.1] : [0.45, 0.4, 0.1];
    page.drawText(st, { x: M, y: y - 9.5, size: 8.5, font: bold, color: rgb(...col) });
    const lines = wrap(c.label, font, 9.5, W - 2 * M - 90);
    for (const l of lines) {
      need(13);
      page.drawText(l, { x: M + 90, y: y - 9.5, size: 9.5, font });
      y -= 13;
    }
    for (const d of c.details) text(d, { x: M + 100, size: 8.5, color: [0.35, 0.35, 0.35] });
  }

  if (o.log) {
    heading("Sign-off log");
    field("Log check", o.log.ok ? "entries, countersignatures and hash chain are intact" : "PROBLEMS FOUND");
    field("Status", o.log.complete ? `signed off by all founders at ${o.log.signedOffAt}` : "not yet complete");
    if (o.log.publicSignedOffAt !== undefined) field("Public record", o.log.publicSignedOffAt ? `fingerprint signed off at ${o.log.publicSignedOffAt}` : "none");
    o.log.signers.forEach((s, i) => field(i === 0 ? "Signed" : "Double signed", `${s.name}${s.email ? ` <${s.email}>` : ""} at ${s.at}`));
    for (const p of o.log.problems) text("- " + p, { color: [0.75, 0.1, 0.1] });
  }

  heading("What this report means");
  text(
    "PageLock checks that every page is the one that was sealed, in order, with nothing added, and that each signature is valid for this exact file. " +
      "Signer identity is only as strong as the authority in the trust file: PageLock's own certificates show that the signer controlled the email address and the key on their device. " +
      "This report is produced by a prototype, is not legal advice and is not proof of legal enforceability.",
    { color: [0.35, 0.35, 0.35] },
  );

  const pages = doc.getPages();
  pages.forEach((p, i) =>
    p.drawText(`PageLock evidence report  -  ${r.documentId ? groupDocId(r.documentId) : ""}  -  page ${i + 1} of ${pages.length}`, {
      x: M,
      y: 25,
      size: 7.5,
      font,
      color: rgb(0.5, 0.5, 0.5),
    }),
  );
  return doc.save();
}
