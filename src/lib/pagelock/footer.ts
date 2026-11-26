import { StandardFontEmbedder, StandardFonts } from "pdf-lib";
import { FONT_BOLD, FONT_REGULAR, FOOTER_HEIGHT, PRINT_SAFE_BOTTOM, QR_SIZE, QR_XOBJECT } from "./constants";
import { fmtNum, groupDocId, shortFingerprint } from "./encoding";

function pdfText(s: string): string {
  if (!/^[\x20-\x7e]*$/.test(s)) throw new Error("footer text must be printable ASCII");
  return "(" + s.replace(/[\\()]/g, (c) => "\\" + c) + ")";
}

export interface FooterInput {
  pageWidth: number;
  documentId: string;
  index: number;
  count: number;
  hash: string;
  /** Last page with a phone link (layout 3 only): print a line saying the code can be scanned to check. */
  scanHint?: boolean;
}

/** Layout 1 (sealed before 26 Nov 2026 evening): 1-inch band. Kept byte-for-byte so old seals still verify. */
function footerLayout1(f: FooterInput): string {
  const W = f.pageWidth;
  const F = 72;
  const x0 = 36;
  const qr = 64;
  const tx = x0 + qr + 10;
  const lines = [
    "q 0.6 G 0.5 w " + `${x0} ${F - 2} m ${fmtNum(W - x0)} ${F - 2} l S Q`,
    `q ${qr} 0 0 ${qr} ${x0} 3 cm /${QR_XOBJECT} Do Q`,
    `BT /${FONT_BOLD} 10 Tf 0 g ${tx} 52 Td ${pdfText("PageLock")} Tj ET`,
    `BT /${FONT_REGULAR} 7 Tf 0.35 g ${tx + 50} 52 Td ${pdfText("Every page accounted for.")} Tj ET`,
    `BT /${FONT_REGULAR} 8 Tf 0 g ${tx} 40 Td ${pdfText(`Document ${groupDocId(f.documentId)}   |   Page ${f.index} of ${f.count}`)} Tj ET`,
    `BT /${FONT_REGULAR} 8 Tf 0 g ${tx} 29 Td ${pdfText(`Page fingerprint (short): ${shortFingerprint(f.hash)}`)} Tj ET`,
    `BT /${FONT_REGULAR} 6 Tf 0.4 g ${tx} 17 Td ${pdfText("Tamper-evident page seal. Not proof of identity and not a legal signature.")} Tj ET`,
  ];
  return lines.join("\n") + "\n";
}

const helvetica = StandardFontEmbedder.for(StandardFonts.Helvetica as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);
const helveticaBold = StandardFontEmbedder.for(StandardFonts.HelveticaBold as unknown as Parameters<typeof StandardFontEmbedder.for>[0]);

/**
 * Layout 2: 1.5-inch band. Everything sits at least 0.5 in above the bottom edge
 * (clear of any printer's unprintable margin) and 0.5 in from the sides. The page number
 * appears once, right-aligned just below the separator line.
 */
function footerLayout2(f: FooterInput): string {
  const W = f.pageWidth;
  const F = 108;
  const x0 = 36; // side margin
  const y0 = 36; // layout 2: nothing below 0.5 in (fixed, must not change)
  const qr = 64;
  const tx = x0 + qr + 10;
  const right = W - x0;
  const pageLabel = `Page ${f.index} of ${f.count}`;
  const pageLabelX = right - helvetica.widthOfTextAtSize(pageLabel, 9);
  const lines = [
    "q 0.6 G 0.5 w " + `${x0} ${F - 4} m ${fmtNum(right)} ${F - 4} l S Q`,
    `BT /${FONT_REGULAR} 9 Tf 0 g ${fmtNum(pageLabelX)} ${F - 16} Td ${pdfText(pageLabel)} Tj ET`,
    `q ${qr} 0 0 ${qr} ${x0} ${y0} cm /${QR_XOBJECT} Do Q`,
    `BT /${FONT_BOLD} 10 Tf 0 g ${tx} ${y0 + 52} Td ${pdfText("PageLock")} Tj ET`,
    `BT /${FONT_REGULAR} 7 Tf 0.35 g ${tx + 50} ${y0 + 52} Td ${pdfText("Every page accounted for.")} Tj ET`,
    `BT /${FONT_REGULAR} 8 Tf 0 g ${tx} ${y0 + 38} Td ${pdfText(`Document ${groupDocId(f.documentId)}`)} Tj ET`,
    `BT /${FONT_REGULAR} 8 Tf 0 g ${tx} ${y0 + 26} Td ${pdfText(`Page fingerprint (short): ${shortFingerprint(f.hash)}`)} Tj ET`,
    `BT /${FONT_REGULAR} 6 Tf 0.4 g ${tx} ${y0 + 12} Td ${pdfText("Tamper-evident page seal. Not proof of identity and not a legal signature.")} Tj ET`,
  ];
  return lines.join("\n") + "\n";
}

/**
 * Layout 3 (current): about 1.14 in (82 pt). Nothing printed in the bottom 0.25 in, 0.5 in clear at the sides,
 * a smaller QR footprint (same module size, white space instead of a built-in border) and the
 * text in two columns:
 *
 *   [QR]  PageLock  Every page accounted for.                    Page 1 of 3
 *         Document 7K3M-Q2XR-...           Fingerprint 2420 DB4F 6A19
 *         Tamper-evident page seal. Not proof of identity or a legal signature.
 *
 * On narrow pages the fingerprint drops under the document ID instead of sitting beside it.
 *
 * The last page (whose code is a phone link) also says it can be scanned: right-aligned on the bottom
 * text row where there is room, otherwise in place of the "Every page accounted for." tagline.
 */
function footerLayout3(f: FooterInput): string {
  const W = f.pageWidth;
  const F = 82;
  const x0 = 36;
  const y0 = PRINT_SAFE_BOTTOM;
  const qr = QR_SIZE;
  const tx = x0 + qr + 12; // >= 4 modules of white between QR and text
  const right = W - x0;
  const w = (t: string, size: number) => helvetica.widthOfTextAtSize(t, size);
  const pageLabel = `Page ${f.index} of ${f.count}`;
  const docLabel = `Document ${groupDocId(f.documentId)}`;
  const fpLabel = `Fingerprint ${shortFingerprint(f.hash)}`;
  const sideBySide = tx + w(docLabel, 8) + 16 + w(fpLabel, 8) <= right;
  const rowTop = y0 + 44; // 80
  const rowMid = y0 + 30; // 66
  const disclaimer = "Tamper-evident page seal. Not proof of identity or a legal signature.";
  const disclaimerY = sideBySide ? y0 + 14 : y0 + 6;
  let tagline = "Every page accounted for.";
  let scanLine: string | null = null;
  if (f.scanHint) {
    const long = "Scan this QR code with a phone to check this document.";
    const wb = (t: string, size: number) => helveticaBold.widthOfTextAtSize(t, size);
    const topRoom = right - w(pageLabel, 9) - 8 - (tx + 50);
    if (sideBySide && tx + w(disclaimer, 6) + 16 + wb(long, 7) <= right)
      scanLine = `BT /${FONT_BOLD} 7 Tf 0 g ${fmtNum(right - wb(long, 7))} ${disclaimerY} Td ${pdfText(long)} Tj ET`;
    else tagline = w("Scan the QR code to check this document.", 7) <= topRoom ? "Scan the QR code to check this document." : "Scan to check.";
  }
  const lines = [
    "q 0.6 G 0.5 w " + `${x0} ${F - 1} m ${fmtNum(right)} ${F - 1} l S Q`,
    `q ${qr} 0 0 ${qr} ${x0} ${y0} cm /${QR_XOBJECT} Do Q`,
    `BT /${FONT_BOLD} 10 Tf 0 g ${tx} ${rowTop} Td ${pdfText("PageLock")} Tj ET`,
    `BT /${FONT_REGULAR} 7 Tf 0.35 g ${tx + 50} ${rowTop} Td ${pdfText(tagline)} Tj ET`,
    `BT /${FONT_REGULAR} 9 Tf 0 g ${fmtNum(right - w(pageLabel, 9))} ${rowTop} Td ${pdfText(pageLabel)} Tj ET`,
    `BT /${FONT_REGULAR} 8 Tf 0 g ${tx} ${rowMid} Td ${pdfText(docLabel)} Tj ET`,
    sideBySide
      ? `BT /${FONT_REGULAR} 8 Tf 0 g ${fmtNum(right - w(fpLabel, 8))} ${rowMid} Td ${pdfText(fpLabel)} Tj ET`
      : `BT /${FONT_REGULAR} 8 Tf 0 g ${tx} ${rowMid - 11} Td ${pdfText(fpLabel)} Tj ET`,
    `BT /${FONT_REGULAR} 6 Tf 0.4 g ${tx} ${disclaimerY} Td ${pdfText(disclaimer)} Tj ET`,
  ];
  if (scanLine) lines.push(scanLine);
  return lines.join("\n") + "\n";
}

/**
 * The footer drawing instructions. A pure function of its inputs, so the verifier can
 * regenerate it and check the footer was not edited. Drawn inside a form XObject whose
 * BBox is the footer band, so it can never paint over the original page above.
 */
export function footerContent(f: FooterInput, footerHeight: number = FOOTER_HEIGHT): string {
  if (footerHeight === 72) return footerLayout1(f);
  if (footerHeight === 108) return footerLayout2(f);
  if (footerHeight === 82) return footerLayout3(f);
  throw new Error(`unknown footer layout (${footerHeight}pt)`);
}

/** The page's own content: draw the untouched original shifted up, then the footer band. */
export function wrapperContent(box: number[], footerHeight: number = FOOTER_HEIGHT): string {
  const [llx, lly] = box;
  return `q 1 0 0 1 ${fmtNum(-llx)} ${fmtNum(footerHeight - lly)} cm /PLOrig Do Q\nq /PLFoot Do Q\n`;
}
