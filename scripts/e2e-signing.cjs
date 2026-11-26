// Browser end-to-end check of the whole Phase 2 flow in the single-file build (demo service in the page):
// founder A gets a certificate, reads, agrees, signs and logs; founder B does the same on A's copy; Verify shows VERIFIED.
// Usage: npm run build:standalone && cp dist-standalone/pagelock.html dist-standalone/index.html && node scripts/e2e-signing.cjs dist-standalone
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
(async () => {
  const dir = path.resolve(process.argv[2] ?? "dist-standalone");
  const server = spawn("python3", ["-m", "http.server", "4175", "-d", dir], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const b = await chromium.launch();
  const ctx = await b.newContext({ viewport: { width: 1100, height: 900 }, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", (e) => errs.push(e.message));
  await p.goto("http://localhost:4175/#sign");
  await p.getByRole("button", { name: "Use the sample sealed agreement" }).click();
  await p.getByText("Not signed yet").waitFor({ timeout: 30000 });

  async function founder(name, email) {
    await p.getByPlaceholder("Your full name").fill(name);
    await p.getByPlaceholder("Your email").fill(email);
    await p.getByRole("button", { name: "Email me a code" }).click();
    await p.getByText(/Demo: your code is/).waitFor();
    await p.getByRole("button", { name: "Confirm" }).click();
    await p.getByRole("radio", { name: new RegExp(name) }).check();
    await p.getByText(/have read all 3 pages/).click();
    await p.getByText(/I agree to this whole document/).click();
    await p.getByRole("button", { name: "Sign the agreement" }).click();
    await p.getByText(`Signed by ${name}.`).waitFor({ timeout: 30000 });
    await p.getByRole("button", { name: "Record my sign-off in the log" }).click();
    await p.locator('[data-testid="log-msg"]').waitFor({ timeout: 30000 });
    console.log(name, "->", (await p.locator('[data-testid="log-msg"]').textContent()).slice(0, 60));
  }
  await founder("Alex Example", "alex@example.com");
  await p.screenshot({ path: path.join(dir, "sign-founder-a.png"), fullPage: true });
  await p.getByRole("button", { name: /Continue with this signed copy/ }).click();
  await p.getByText("Already signed by Alex Example").waitFor({ timeout: 30000 });
  await p.getByRole("button", { name: "Confirm" }).waitFor({ state: "detached" }).catch(() => {});
  await p.getByText("Get a signing certificate for someone else").click();
  await founder("Sam Example", "sam@example.com");
  await p.screenshot({ path: path.join(dir, "sign-founder-b.png"), fullPage: true });
  const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: "Download the signed PDF" }).click()]);
  const signedPath = path.join(dir, "signed-by-both.pdf");
  await dl.saveAs(signedPath);

  await p.goto("http://localhost:4175/#verify");
  await p.locator('input[type="file"]').nth(0).setInputFiles(signedPath);
  await p.getByRole("button", { name: "Check every page" }).click();
  await p.locator('[data-testid="outcome"]').waitFor({ timeout: 30000 });
  console.log("verify:", await p.locator('[data-testid="outcome"] div').first().textContent());
  await p.locator('[data-testid="signoff-log"]').waitFor({ timeout: 30000 });
  console.log("log:", (await p.locator('[data-testid="signoff-log"]').textContent()).slice(0, 160));
  await p.screenshot({ path: path.join(dir, "verify-signed.png"), fullPage: true });
  const [ev] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: /evidence report/ }).click()]);
  await ev.saveAs(path.join(dir, "evidence.pdf"));
  console.log("evidence bytes", fs.statSync(path.join(dir, "evidence.pdf")).size, "errors", errs);
  await b.close();
  server.kill();
})();
