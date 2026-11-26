// Browser end-to-end check of the hosted set-up (Vercel + Postgres), run locally:
// the static site from out/ plus the bundled api/pagelock.ts function behind the same rewrite as vercel.json.
// Email codes are caught instead of being sent to Resend.
// Usage: PAGELOCK_DATABASE_URL=postgres://... (throwaway database)
//        NEXT_PUBLIC_PAGELOCK_SERVICE_URL=http://localhost:4180 npm run build && node scripts/e2e-hosted.cjs
const { chromium } = require("playwright");
const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const esbuild = require("esbuild");

(async () => {
  const root = path.resolve(__dirname, "..");
  const outDir = path.join(root, "out");
  const work = fs.mkdtempSync(path.join(require("node:os").tmpdir(), "pagelock-e2e-"));
  const bundle = path.join(work, "pagelock-fn.cjs");
  await esbuild.build({ entryPoints: [path.join(root, "api/pagelock.ts")], bundle: true, platform: "node", format: "cjs", target: "node20", outfile: bundle, logLevel: "error" });

  const mail = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith("https://api.resend.com/")) {
      mail.push(JSON.parse(init.body));
      return new Response("{}", { status: 200 });
    }
    return realFetch(url, init);
  };
  process.env.RESEND_API_KEY ??= "test-key";
  process.env.PAGELOCK_ALLOWED_ORIGIN ??= "http://localhost:4180";
  const fn = require(bundle);
  const vercel = JSON.parse(fs.readFileSync(path.join(root, "vercel.json"), "utf8"));
  if (vercel.rewrites[0].destination !== "/api/pagelock?__path=:path*") throw new Error("vercel.json rewrite changed: update this script");

  const types = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml", ".png": "image/png", ".pdf": "application/pdf", ".ico": "image/x-icon", ".txt": "text/plain" };
  const server = http.createServer(async (req, res) => {
    const u = new URL(req.url, "http://localhost:4180");
    if (u.pathname.startsWith("/api/")) {
      if (u.pathname !== "/api/pagelock") {
        u.searchParams.set("__path", u.pathname.slice(5));
        u.pathname = "/api/pagelock";
      }
      const chunks = [];
      for await (const c of req) chunks.push(c);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const body = req.method === "GET" || req.method === "HEAD" ? undefined : Buffer.concat(chunks);
      const handler = fn[req.method];
      const r = handler ? await handler(new Request(u, { method: req.method, headers, body })) : new Response(null, { status: 405 });
      res.writeHead(r.status, Object.fromEntries(r.headers.entries()));
      return res.end(Buffer.from(await r.arrayBuffer()));
    }
    let f = path.join(outDir, decodeURIComponent(u.pathname));
    if (!f.startsWith(outDir)) return res.writeHead(403).end();
    if (fs.existsSync(f) && fs.statSync(f).isDirectory()) f = path.join(f, "index.html");
    if (!fs.existsSync(f)) return res.writeHead(404).end();
    res.writeHead(200, { "Content-Type": types[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(4180, r));

  const health = await realFetch("http://localhost:4180/api/health").then((r) => r.json());
  console.log("health", health);

  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:4180/sign/");
  await p.getByRole("button", { name: "Use the sample sealed agreement" }).click();
  await p.getByText("Not signed yet").waitFor({ timeout: 30000 });

  async function founder(name, email) {
    await p.getByPlaceholder("Your full name").fill(name);
    await p.getByPlaceholder("Your email").fill(email);
    await p.getByRole("button", { name: "Email me a code" }).click();
    await p.getByText(`We emailed a 6-digit code to ${email}`).waitFor({ timeout: 30000 });
    const code = mail.filter((m) => m.to[0] === email).pop().text.match(/\d{6}/)[0];
    await p.getByPlaceholder("123456").fill(code);
    await p.getByRole("button", { name: "Confirm" }).click();
    await p.getByRole("radio", { name: new RegExp(name) }).check({ timeout: 30000 });
    await p.getByText(/have read all 3 pages/).click();
    await p.getByText(/I agree to this whole document/).click();
    await p.getByRole("button", { name: "Sign the agreement" }).click();
    await p.getByText(`Signed by ${name}.`).waitFor({ timeout: 30000 });
    await p.getByRole("button", { name: "Record my sign-off in the log" }).click();
    await p.locator('[data-testid="log-msg"]').waitFor({ timeout: 30000 });
    console.log(name, "->", (await p.locator('[data-testid="log-msg"]').textContent()).slice(0, 80));
  }
  await founder("Alex Example", "alex@example.com");
  await p.getByRole("button", { name: /Continue with this signed copy/ }).click();
  await p.getByText("Already signed by Alex Example").waitFor({ timeout: 30000 });
  await p.getByText("Get a signing certificate for someone else").click();
  await founder("Sam Example", "sam@example.com");
  const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Download the signed PDF" }).click()]);
  const signedPath = path.join(work, "signed-by-both.pdf");
  await dl.saveAs(signedPath);

  await p.goto("http://localhost:4180/verify/");
  await p.locator('input[type="file"]').nth(0).setInputFiles(signedPath);
  await p.getByRole("button", { name: "Check every page" }).click();
  await p.locator('[data-testid="outcome"]').waitFor({ timeout: 30000 });
  console.log("verify:", await p.locator('[data-testid="outcome"] div').first().textContent());
  await p.locator('[data-testid="signoff-log"]').waitFor({ timeout: 30000 });
  console.log("log:", (await p.locator('[data-testid="signoff-log"]').textContent()).slice(0, 200));
  await p.screenshot({ path: path.join(work, "verify-hosted.png"), fullPage: true });
  console.log("emails sent", mail.length, "page errors", errs, "screenshot", path.join(work, "verify-hosted.png"));
  await b.close();
  server.close();
  process.exit(errs.length ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
