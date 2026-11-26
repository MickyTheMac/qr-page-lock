import { FONT_BOLD, FONT_REGULAR, FOOTER_HEIGHT, QR_XOBJECT } from "./constants";
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
}

/**
 * The footer drawing instructions. A pure function of its inputs, so the verifier can
 * regenerate it and check the footer was not edited. Drawn inside a form XObject whose
 * BBox is the footer band, so it can never paint over the original page above.
 */
export function footerContent(f: FooterInput): string {
  const W = f.pageWidth;
  const F = FOOTER_HEIGHT;
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

/** The page's own content: draw the untouched original shifted up, then the footer band. */
export function wrapperContent(box: number[]): string {
  const [llx, lly] = box;
  return `q 1 0 0 1 ${fmtNum(-llx)} ${fmtNum(FOOTER_HEIGHT - lly)} cm /PLOrig Do Q\nq /PLFoot Do Q\n`;
}
