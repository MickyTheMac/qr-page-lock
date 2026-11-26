// Copies the pinned PDF.js worker into /public so the browser loads it from our own origin.
const fs = require("node:fs");
const path = require("node:path");
const src = require.resolve("pdfjs-dist/build/pdf.worker.min.mjs");
const dir = path.join(__dirname, "..", "public");
fs.mkdirSync(dir, { recursive: true });
fs.copyFileSync(src, path.join(dir, "pdf.worker.min.mjs"));
