// Copies files the browser needs into /public so they load from our own origin (no third-party servers):
//  - the pinned PDF.js worker,
//  - the on-device text reader (Tesseract) used to sense-check sealed photos, and its English model.
const fs = require("node:fs");
const path = require("node:path");
const pub = path.join(__dirname, "..", "public");
fs.mkdirSync(pub, { recursive: true });
fs.copyFileSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"), path.join(pub, "pdf.worker.min.mjs"));

const t = path.join(pub, "tesseract");
fs.mkdirSync(t, { recursive: true });
const tjs = path.dirname(require.resolve("tesseract.js/package.json"));
const core = path.dirname(require.resolve("tesseract.js-core/package.json"));
const eng = path.dirname(require.resolve("@tesseract.js-data/eng/package.json"));
fs.copyFileSync(path.join(tjs, "dist", "worker.min.js"), path.join(t, "worker.min.js"));
for (const f of ["tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js"]) fs.copyFileSync(path.join(core, f), path.join(t, f));
fs.copyFileSync(path.join(eng, "4.0.0_best_int", "eng.traineddata.gz"), path.join(t, "eng.traineddata.gz"));
