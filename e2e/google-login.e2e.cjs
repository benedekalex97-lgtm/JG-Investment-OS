/* eslint-disable @typescript-eslint/no-require-imports */
// Local UI checks with fictitious OAuth configuration; no real Google account or external database.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");
const { chromium } = require(process.env.PLAYWRIGHT_PATH || "playwright");
const ROOT = path.join(__dirname, "..");
const work = fs.mkdtempSync(path.join(os.tmpdir(), "jg-google-ui-"));
const port = Number(process.env.E2E_PORT || 3281);
const base = `http://127.0.0.1:${port}`;
const env = { ...process.env, NODE_ENV: "production", JG_ENV: "local", DATABASE_URL: "", JG_PGLITE_DIR: path.join(work, "pg"), JG_AUTH_MODE: "google", JG_APP_URL: base, GOOGLE_CLIENT_ID: "fictitious.apps.googleusercontent.com", GOOGLE_CLIENT_SECRET: "test-only-not-a-real-credential" };
let server, browser;
async function start(extra = {}, serverPort = port) {
  server = spawn(process.execPath, ["node_modules/next/dist/bin/next", "start", "-H", "127.0.0.1", "-p", String(serverPort)], { cwd: ROOT, env: { ...env, ...extra }, stdio: "ignore" });
  server.exited = new Promise((resolve) => server.once("exit", resolve));
  for (let i = 0; i < 100; i++) {
    try { await fetch(`http://127.0.0.1:${serverPort}/api/status`, { signal: AbortSignal.timeout(1000) }); return; } catch { /* starting */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("Local Google UI server did not start");
}
async function stop() {
  if (!server || server.exitCode !== null) return;
  server.kill("SIGTERM");
  await Promise.race([server.exited, new Promise((resolve) => setTimeout(resolve, 5000))]);
  if (server.exitCode === null) server.kill("SIGKILL");
}
(async () => {
  try {
    console.log("Preparing local Google UI database");
    const migrated = spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", "migrate"], { cwd: ROOT, env, encoding: "utf8", timeout: 30000 });
    assert.equal(migrated.status, 0, migrated.stderr);
    console.log("Starting local Google UI server");
    await start();
    console.log("Opening local Google UI browser");
    browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"] });
    for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
      const context = await browser.newContext({ viewport });
      const page = await context.newPage();
      await page.goto(base, { waitUntil: "networkidle" });
      const button = page.getByRole("button", { name: "Sign in with Google", exact: true });
      await button.waitFor({ state: "visible" });
      assert.equal(await page.locator('input[type="password"]').count(), 0);
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
      if (process.env.AXE_PATH) {
        await page.evaluate(fs.readFileSync(process.env.AXE_PATH, "utf8"));
        const violations = await page.evaluate(async () => (await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations);
        assert.deepEqual(violations.map((x) => x.id), []);
      }
      // Check native navigation only; provider integration is verified separately with signed tokens.
      await page.route("**/api/auth/google*", async (route) => {
        assert.equal(new URL(route.request().url()).pathname, "/api/auth/google");
        assert.equal(route.request().method(), "GET");
        await route.fulfill({ status: 200, contentType: "text/plain", body: "OAuth navigation reached" });
      });
      await button.click();
      await page.getByText("OAuth navigation reached").waitFor();
      await page.goto(base + "/?login_error=not_allowed", { waitUntil: "networkidle" });
      await page.getByRole("alert").filter({ hasText: "nem rendelkezik CRM-hozzáféréssel" }).waitFor();
      console.log(`PASS Google-only login, navigation, error, layout and axe: ${viewport.width}px`);
      await context.close();
    }
    await stop();
    const missingEnv = { GOOGLE_CLIENT_SECRET: "", JG_PGLITE_DIR: path.join(work, "missing-config-pg") };
    const prepared = spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", "migrate"], { cwd: ROOT, env: { ...env, ...missingEnv }, encoding: "utf8", timeout: 30000 });
    assert.equal(prepared.status, 0, prepared.stderr);
    await start(missingEnv, port + 1);
    const missingBase = `http://127.0.0.1:${port + 1}`;
    const status = await fetch(missingBase + "/api/status");
    assert.equal(status.status, 503);
    assert.equal((await status.json()).state, "auth_not_configured");
    const page = await browser.newPage();
    await page.goto(missingBase, { waitUntil: "networkidle" });
    await page.getByText("A Google-belépés beállítása hiányzik", { exact: true }).waitFor({ timeout: 5000 }).catch(async () => { throw new Error("Missing config UI: " + await page.locator("main").innerText()); });
    assert.equal(await page.getByRole("button", { name: "Sign in with Google" }).count(), 0);
    console.log("PASS missing Google configuration fails closed");
  } finally {
    await browser?.close();
    await stop();
    fs.rmSync(work, { recursive: true, force: true });
  }
})().catch((error) => { console.error(error); process.exitCode = 1; });
