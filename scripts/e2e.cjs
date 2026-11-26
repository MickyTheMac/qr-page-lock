// Browser end-to-end check in Chromium: seal + verify fixtures through the real UI, and confirm
// the page fingerprints computed in the browser equal those computed in Node (cross-environment repeatability).
const { chromium } = require("playwright");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "..");
const fx = (f) => path.join(root, "fixtures", f);
const shots = process.argv[2] || path.join(root, "e2e-screenshots");
fs.mkdirSync(shots, { recursive: true });

(async () => {
  const server = spawn("python3", ["-m", "http.server", "4173", "-d", path.join(root, "out")], { stdio: "ignore" });
  await new Promise((r) => setTimeout(r, 800));
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1200, height: 900 } });
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  let failures = 0;
  const expect = (name, got, want) => {
    const ok = got === want;
    if (!ok) failures++;
    console.log(`${ok ? "PASS" : "FAIL"}  ${name}: ${got}${ok ? "" : ` (expected ${want})`}`);
  };

  // CREATE
  await page.goto("http://localhost:4173/create/");
  await page.setInputFiles('input[type="file"]', fx("00-original-unsealed.pdf"));
  await page.getByRole("button", { name: "Seal every page" }).click();
  await page.getByText("self-check: REFERENCE MATCH").waitFor({ timeout: 30000 });
  const browserHashes = await page.$$eval("tbody tr td:nth-child(3)", (tds) => tds.map((t) => t.textContent.trim()));
  const nodeHashes = JSON.parse(fs.readFileSync(fx("01-sealed-genuine.pagelock-reference.json"), "utf8")).body.pages.map((p) => p.hash);
  expect("browser and Node page fingerprints identical", JSON.stringify(browserHashes) === JSON.stringify(nodeHashes), true);
  await page.getByText("QR scan test: readable").nth(2).waitFor({ timeout: 30000 });
  expect("QR codes readable from rendered pages", await page.getByText("QR scan test: readable").count(), 3);
  await page.screenshot({ path: path.join(shots, "create.png"), fullPage: true });

  // VERIFY
  const cases = [
    ["01-sealed-genuine.pdf", true, "REFERENCE MATCH"],
    ["01-sealed-genuine.pdf", false, "INTERNALLY CONSISTENT"],
    ["02-changed-character.pdf", true, "ALTERED / INVALID"],
    ["07-pages-reordered.pdf", false, "ALTERED / INVALID"],
    ["12-regenerated-chain.pdf", true, "ALTERED / INVALID"],
    ["14-qr-unreadable.pdf", false, "UNABLE TO VERIFY"],
  ];
  for (const [file, withRef, want] of cases) {
    await page.goto("http://localhost:4173/verify/");
    const inputs = page.locator('input[type="file"]');
    await inputs.nth(0).setInputFiles(fx(file));
    if (withRef) await inputs.nth(1).setInputFiles(fx("01-sealed-genuine.pagelock-reference.json"));
    await page.getByRole("button", { name: "Check every page" }).click();
    const outcome = page.locator('[data-testid="outcome"] div').first();
    await outcome.waitFor({ timeout: 30000 });
    expect(`${file}${withRef ? " + reference" : ""}`, (await outcome.textContent()).trim(), want);
    if (file === "01-sealed-genuine.pdf" && withRef) {
      await page.waitForTimeout(1500);
      await page.screenshot({ path: path.join(shots, "verify-match.png"), fullPage: true });
    }
    if (file === "07-pages-reordered.pdf") await page.screenshot({ path: path.join(shots, "verify-altered.png"), fullPage: true });
  }
  await page.goto("http://localhost:4173/");
  await page.screenshot({ path: path.join(shots, "home.png"), fullPage: true });
  expect("no browser errors", errors.length, 0);
  if (errors.length) console.log(errors);
  await browser.close();
  server.kill();
  process.exit(failures ? 1 : 0);
})();
