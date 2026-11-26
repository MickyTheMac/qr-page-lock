import { makeSampleAgreement } from "./sample";
import * as T from "./tamper";
import { preparePdf, serializeManifestFile } from "../pagelock";

export { makeSampleAgreement };

export const DEMOS = {
  genuine: "Genuine sealed copy",
  changed: "One character changed (50% to 60%)",
  reordered: "Pages 2 and 3 swapped",
  deleted: "Page 2 removed",
  forged: "Edited, then sealed again",
} as const;
export type DemoKind = keyof typeof DEMOS;

/** Seals the sample agreement, applies one tampering, and returns the PDF plus the genuine reference file. */
export async function makeDemo(kind: DemoKind): Promise<{ pdf: File; reference: File }> {
  const original = await makeSampleAgreement(3);
  const genuine = await preparePdf(original);
  let bytes: Uint8Array = genuine.pdfBytes;
  if (kind === "changed") bytes = await T.changeCharacter(bytes);
  if (kind === "reordered") bytes = await T.swapPages(bytes, 1, 2);
  if (kind === "deleted") bytes = await T.deletePage(bytes, 1);
  if (kind === "forged") bytes = (await preparePdf(await T.changeOriginalCharacter(original))).pdfBytes;
  return {
    pdf: new File([bytes as BlobPart], `demo-${kind}.pdf`, { type: "application/pdf" }),
    reference: new File([serializeManifestFile(genuine.manifest)], "demo-genuine.pagelock-reference.json", { type: "application/json" }),
  };
}
