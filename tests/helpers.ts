import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const CLAUSES = [
  ["1. Parties", "This Founders' Agreement is made between Founder A and Founder B (together, the Founders) for the company referred to here as NewCo."],
  ["2. Equity", "The Founders agree that equity in NewCo will be held 50% by Founder A and 50% by Founder B, subject to the vesting terms below."],
  ["3. Vesting", "Each Founder's shares vest monthly over four years with a one-year cliff. Unvested shares may be bought back at nominal value if a Founder leaves."],
  ["4. Roles", "Founder A will lead product and engineering. Founder B will lead sales, finance and operations. Major decisions require both Founders' agreement."],
  ["5. Intellectual property", "Each Founder assigns to NewCo all intellectual property created for the business, including code, designs, brand assets and customer lists."],
  ["6. Confidentiality", "The Founders will keep NewCo's confidential information private during and after their involvement with the company."],
  ["7. Departure", "If a Founder leaves, they will hand over all company materials, accounts and passwords within fourteen days."],
  ["8. Disputes", "The Founders will first try to resolve disagreements in good faith, then by mediation, before any other step."],
  ["9. Entire agreement", "This agreement records the whole understanding between the Founders on these subjects and replaces earlier discussions."],
];

/** A small, realistic, plain founders' agreement used as the main test fixture. */
export async function makeSampleAgreement(pages = 3, opts: { marker?: string } = {}): Promise<Uint8Array> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.TimesRoman);
  const bold = await doc.embedFont(StandardFonts.TimesRomanBold);
  doc.setTitle("Sample Founders' Agreement (test fixture)");
  doc.setProducer("PageLock test fixtures");
  doc.setCreationDate(new Date("2026-11-26T00:00:00Z"));
  doc.setModificationDate(new Date("2026-11-26T00:00:00Z"));
  let clause = 0;
  for (let p = 0; p < pages; p++) {
    const page = doc.addPage([595.28, 841.89]); // A4
    let y = 780;
    if (p === 0) {
      page.drawText("FOUNDERS' AGREEMENT", { x: 72, y, size: 18, font: bold });
      y -= 36;
    }
    for (let k = 0; k < 3; k++) {
      const [h, body] = CLAUSES[clause % CLAUSES.length];
      clause++;
      page.drawText(h, { x: 72, y, size: 12, font: bold });
      y -= 18;
      const words = body.split(" ");
      let line = "";
      for (const w of words) {
        if (font.widthOfTextAtSize(line + " " + w, 11) > 450) {
          page.drawText(line, { x: 72, y, size: 11, font });
          y -= 15;
          line = w;
        } else line = line ? line + " " + w : w;
      }
      page.drawText(line, { x: 72, y, size: 11, font });
      y -= 30;
    }
    if (opts.marker) page.drawText(opts.marker, { x: 72, y: 120, size: 9, font, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(`Page ${p + 1}`, { x: 280, y: 40, size: 9, font });
  }
  return doc.save({ useObjectStreams: false });
}
