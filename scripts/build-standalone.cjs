// Builds dist-standalone/pagelock.html: the whole app (UI, protocol, PDF.js worker, styles) in one file.
const esbuild = require("esbuild");
const { execFileSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const out = path.join(root, "dist-standalone");
fs.mkdirSync(out, { recursive: true });

execFileSync("npx", ["@tailwindcss/cli", "-i", "src/app/globals.css", "-o", "dist-standalone/app.css", "--minify"], { cwd: root, stdio: "inherit" });

esbuild.buildSync({
  entryPoints: [path.join(root, "src/standalone/main.tsx")],
  bundle: true,
  format: "esm",
  minify: true,
  target: "es2022",
  outfile: path.join(out, "app.js"),
  alias: { "next/link": path.join(root, "src/standalone/link-shim.tsx") },
  define: { "process.env.NODE_ENV": '"production"' },
  jsx: "automatic",
  logLevel: "warning",
});

const esc = (s) => s.replace(/<\/script/gi, "<\\/script").replace(/<!--/g, "<\\!--");
const css = fs.readFileSync(path.join(out, "app.css"), "utf8");
const js = fs.readFileSync(path.join(out, "app.js"), "utf8");
const worker = fs.readFileSync(require.resolve("pdfjs-dist/build/pdf.worker.min.mjs"), "utf8");
const html = `<title>PageLock</title>
<meta name="claude:viewport-fit-sides" content="cover">
<style>${css}
:root{--background:#f7f7f5;--foreground:#1c1c1a}
html,body{height:100%}
body{background:var(--background);color:var(--foreground)}
#root{min-height:100%;display:flex;flex-direction:column}
header nav,main,footer>div{padding-left:max(16px,env(safe-area-inset-left,0px))!important;padding-right:max(16px,env(safe-area-inset-right,0px))!important}
</style>
<div id="root"></div>
<script type="text/plain" id="pdf-worker">${esc(worker)}</script>
<script type="module">${esc(js)}</script>
`;
fs.writeFileSync(path.join(out, "pagelock.html"), html);
console.log("pagelock.html", (html.length / 1048576).toFixed(2), "MB");
