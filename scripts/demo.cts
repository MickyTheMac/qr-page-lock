import { writeFileSync } from "node:fs";
import { makeSampleAgreement } from "../tests/helpers";
import { preparePdf, serializeManifestFile } from "../src/lib/pagelock";
(async () => {
  const out = process.argv[2];
  const src = await makeSampleAgreement(3);
  const r = await preparePdf(src);
  writeFileSync(`${out}/original.pdf`, src);
  writeFileSync(`${out}/prepared.pdf`, r.pdfBytes);
  writeFileSync(`${out}/manifest.json`, serializeManifestFile(r.manifest));
  console.log(r.pages[0].payload, r.pages[0].payload.length);
})();
