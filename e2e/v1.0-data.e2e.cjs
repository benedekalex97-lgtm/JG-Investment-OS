/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v1.0 - Adatkezelés (CRM-014-018) böngészős E2E és akadálymentességi ellenőrzés (Playwright + axe-core).
 * Nézetek: 390 (mobil), 768 (tablet), 1280 és 1440 (desktop).
 *
 * Használat (a repó gyökeréből):  npm run build && node e2e/v1.0-data.e2e.cjs
 *
 * Saját `next start` szervert indít egy ideiglenes, fájl alapú helyi PostgreSQL (PGlite) könyvtárral, migrál, két fiktív pilot
 * felhasználót hoz létre, és az egyiknek az üzemeltetői CLI-vel import/export/importnapló jogot ad. Éles vagy külső adatbázishoz
 * soha nem kapcsolódik. Kizárólag fiktív adat (example.test, 000-s telefonszámok).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");

function loadPlaywright() {
  for (const p of ["playwright", process.env.PLAYWRIGHT_PATH, "/opt/node22/lib/node_modules/playwright"].filter(Boolean)) {
    try { return require(p); } catch { /* next */ }
  }
  throw new Error("Playwright nem található (PLAYWRIGHT_PATH beállítható).");
}
const { chromium } = loadPlaywright();
let axeSrc = null;
for (const p of [process.env.AXE_PATH, () => require.resolve("axe-core/axe.min.js")].filter(Boolean)) {
  try { axeSrc = fs.readFileSync(typeof p === "function" ? p() : p, "utf8"); break; } catch { /* next */ }
}

const ROOT = path.join(__dirname, "..");
const PORT = Number(process.env.E2E_DATA_PORT || 3201);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const WORK = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), "jg-e2e-data-"));
const DB_DIR = path.join(WORK, "pg");
const FILES = path.join(WORK, "files");
fs.mkdirSync(FILES);
const EMAIL_A = "adat.admin@example.test", PW_A = "e2e-adat-admin-12345";
const EMAIL_B = "munkatars@example.test", PW_B = "e2e-munkatars-67890";
const TZ = "Europe/Budapest";

const results = [];
let skipped = 0;
const log = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name, ok ? "" : extra); };
const skip = (name) => { skipped += 1; console.log("SKIPPED", name, "(axe-core nem érhető el)"); };

const baseEnv = { ...process.env, JG_ENV: "local", JG_PGLITE_DIR: DB_DIR, NODE_ENV: "production", JG_CUSTOMER_IMPORT_ENABLED: "true", JG_OPERATOR: "E2E Üzemeltető" };
function cli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", ...args], { cwd: ROOT, env: { ...baseEnv, ...extraEnv }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`db ${args.join(" ")} sikertelen: ${r.stderr}`);
  return r.stdout;
}
let server = null;
async function startServer(env) {
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(PORT), "-H", "127.0.0.1"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.exited = new Promise((res) => child.on("exit", res));
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`${BASE}/api/status`, { signal: AbortSignal.timeout(2000) }); if (r.status === 200 || r.status === 503) return child; } catch { /* még nem fut */ }
    await new Promise((r) => setTimeout(r, 500));
  }
  child.kill("SIGKILL");
  throw new Error(`A szerver nem indult el: ${out.slice(-500)}`);
}
async function stop(child) {
  child.kill("SIGTERM");
  await Promise.race([child.exited, new Promise((r) => setTimeout(r, 8000))]);
  if (child.exitCode === null) child.kill("SIGKILL");
}

const ctxOpts = (viewport, extra = {}) => ({ viewport, timezoneId: TZ, acceptDownloads: true, ...extra });
async function login(page, email, pw) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail-cím").fill(email);
  await page.getByLabel("Jelszó").fill(pw);
  await page.getByRole("button", { name: "Belépés" }).click();
  await page.waitForSelector('[data-testid="current-user"]');
}
async function checkPage(page, label, tag) {
  await page.waitForTimeout(300);
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  log(`[${label}] ${tag}: nincs vízszintes oldalgörgetés`, overflow <= 0, `overflow=${overflow}`);
  if (axeSrc) {
    await page.evaluate(axeSrc);
    const v = await page.evaluate(async () => (await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}(${x.nodes.length}):${x.nodes[0].target}`));
    log(`[${label}] ${tag}: axe (WCAG A/AA)`, v.length === 0, v.join("; "));
  } else skip(`[${label}] ${tag}: axe`);
  await page.screenshot({ path: path.join(SHOTS, `v10-${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}
const csv = (rows) => "﻿" + rows.map((r) => r.map((v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(";")).join("\r\n") + "\r\n";

/** A teljes importvarázsló egy fájllal; a lépések képernyőit és akadálymentességét a megadott nézetben ellenőrzi. */
async function wizard(page, file, label, opts = {}) {
  await page.goto(BASE + "/data/import", { waitUntil: "networkidle" });
  await page.getByLabel(/Excel- vagy CSV-fájl/).setInputFiles(file);
  await page.getByText(/adatsor ·/).waitFor({ timeout: 10000 });
  await page.getByLabel(/Adatforrás megnevezése/).fill("E2E fiktív rendezvénylista");
  await page.getByLabel(/Forrásadatok ellenőrzési státusza/).selectOption("verified");
  await page.getByLabel(/Az import célja/).fill("Böngészős teszt");
  await page.getByLabel(/Nyilatkozom/).check();
  if (opts.check) await checkPage(page, label, "import 1 fajl es forras");
  await page.getByRole("button", { name: "Tovább: oszlopok megfeleltetése" }).click();
  await page.getByRole("heading", { name: "Oszlopok", exact: true }).waitFor();
  if (opts.check) await checkPage(page, label, "import 2 oszlopok");
  await page.getByRole("button", { name: "Előnézet készítése" }).click();
  await page.locator('[data-testid="import-summary"]').waitFor({ timeout: 15000 });
  if (opts.check) await checkPage(page, label, "import 3 elonezet");
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"] } : {});
  const VIEWS = { mobil: { width: 390, height: 844 }, tablet: { width: 768, height: 1024 }, desktop1280: { width: 1280, height: 800 }, desktop: { width: 1440, height: 900 } };
  const errors = [];
  const watch = (page) => {
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
  };
  try {
    cli(["migrate"]);
    cli(["user:create", EMAIL_A, "Adat Admin"], { JG_USER_PASSWORD: PW_A });
    cli(["user:create", EMAIL_B, "Munkatárs Márk"], { JG_USER_PASSWORD: PW_B });
    for (const p of ["crm.customer.import", "crm.customer.export", "crm.import.history.read"]) cli(["permission:grant", EMAIL_A, p]);
    log("üzemeltetői kiosztás: a jogok listázhatók, a munkatársnak nincs joga", (() => { const l = cli(["permission:list"]); return l.includes(EMAIL_A) && !l.includes(EMAIL_B); })());
    server = await startServer(baseEnv);

    // ============ P) Munkatárs: nincs import/export (felület és API) ============
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      watch(page);
      await login(page, EMAIL_B, PW_B);
      // v1.1: az Adatkezelés a Beállítások alá került; jog nélkül egyik menüpont sem látszik.
      log("P01/P02: munkatárs: az Adatkezelés (Beállítások) menüpont nem látszik", (await page.locator('nav a:has-text("Adatkezelés"), nav a:has-text("Beállítások")').count()) === 0);
      await page.goto(BASE + "/data/import", { waitUntil: "networkidle" });
      log("P01: munkatárs: az importoldal jogosultsági üzenetet mutat", (await page.locator('[data-testid="no-permission"]').innerText()).includes("Ehhez a művelethez nincs jogosultságod."));
      const api = await page.request.post(BASE + "/api/data/export", { headers: { origin: BASE }, data: { format: "csv", filters: {} } });
      log("P09: munkatárs: a kliens megkerülésével (közvetlen API-hívás) sem exportálhat", api.status() === 403);
      await page.goto(BASE + "/customers", { waitUntil: "networkidle" });
      log("P07: munkatárs: a napi CRM (Ügyfelek) elérhető", (await page.locator("main h1").innerText()) === "Ügyfelek");
      await ctx.close();
    }

    // ============ I) CRM-admin: teljes import a böngészőben (desktop) ============
    const ctxA = await browser.newContext(ctxOpts(VIEWS.desktop));
    const pageA = await ctxA.newPage();
    watch(pageA);
    await login(pageA, EMAIL_A, PW_A);
    // Meglévő ügyfél az erős egyezéshez (a CRM normál útján).
    await pageA.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: require("crypto").randomUUID(), op: "customer.create", args: { input: { type: "individual", name: "Meglévő Melinda", email: "melinda@example.test" } } } });
    log("P03/P04: CRM-admin: az Adatkezelés (v1.1: Beállítások) menüpont látszik", (await pageA.locator('nav a:has-text("Beállítások")').count()) > 0);
    await pageA.goto(BASE + "/data", { waitUntil: "networkidle" });
    await pageA.waitForURL("**/data/import");
    log("Adatkezelés: a kezdőoldal az első jogosult aloldalra (Importálás) visz", pageA.url().endsWith("/data/import"));
    const [tpl] = await Promise.all([pageA.waitForEvent("download"), pageA.getByRole("button", { name: /Importsablon letöltése/ }).click()]);
    log("7.2: az importsablon letölthető (JG_CRM_Import_Template.xlsx)", tpl.suggestedFilename() === "JG_CRM_Import_Template.xlsx");

    const file1 = path.join(FILES, "ugyfelek.csv");
    fs.writeFileSync(file1, csv([
      ["Ügyféltípus", "Név", "Cégnév", "Telefonszám", "E-mail", "Kapcsolattartó neve", "Státusz"],
      ["Magánszemély", "Böngésző Bianka", "", "06 30 000 0501", "bianka@example.test", "", ""],
      ["Cég", "", "Böngésző Kft.", "+36 1 000 0502", "info@bongeszo-kft.example.test", "Kapcsoló Kende", ""],
      ["Magánszemély", "Hibás Hugó", "", "", "nem-email", "", ""],
      ["Magánszemély", "Melinda Másik", "", "", "MELINDA@example.test", "", ""],
      ["Magánszemély", "Státuszos Sára", "", "", "sara@example.test", "", "Tőke elhelyezve"],
    ]));
    await wizard(pageA, file1, "desktop", { check: true });
    const summary = await pageA.locator('[data-testid="import-summary"]').innerText();
    log("V09: előnézet: összes / érvényes / hibás / egyezés összesítő", /Összes sor\s*5/i.test(summary) && /Érvényes új\s*2/i.test(summary) && /Hibás\s*1/i.test(summary) && /Egyezés \(erős vagy lehetséges\)\s*1/i.test(summary), summary.replace(/\s+/g, " "));
    const before = await pageA.request.get(BASE + "/api/crm/snapshot").then((r) => r.json());
    log("V10: az előnézet nem mentett adatot", before.snapshot.customers.length === 1);
    log("V08: hibás sor jelölve, a hibaüzenetben nincs cellaérték", (await pageA.locator('[data-testid="import-row-4"]').innerText()).includes("Érvénytelen e-mail-cím") && !(await pageA.locator('[data-testid="import-row-4"]').innerText()).includes("nem-email"));
    const dupRow = pageA.locator('[data-testid="import-row-5"]');
    log("D03: erős egyezés a meglévő ügyféllel, link a meglévő ügyfélre", (await dupRow.innerText()).includes("Erős egyezés") && (await dupRow.locator('a[href^="/customers/"]').count()) === 1);
    const [report] = await Promise.all([pageA.waitForEvent("download"), pageA.getByRole("button", { name: "Hibajegyzék letöltése (CSV)" }).click()]);
    const reportText = fs.readFileSync(await report.path(), "utf8");
    log("7.5: hibajegyzék letölthető, felesleges személyes adat (cellaérték) nélkül", reportText.includes("Érvénytelen e-mail-cím") && !/example\.test|Hugó|nem-email/.test(reportText));
    // Döntés: a státuszos (figyelmeztetett) sor jóváhagyása; az erős egyezés kihagyva marad.
    await pageA.locator('[data-testid="import-row-6"]').getByLabel("Jóváhagyom az importálást").check();
    const commitBtn = pageA.locator('[data-testid="import-commit"]');
    log("7.5: a véglegesítés gombja a várható rekordszámot mutatja", (await commitBtn.innerText()).includes("(3 ügyfél)"), await commitBtn.innerText());
    await commitBtn.click();
    await pageA.getByText("Az importálás elkészült.").waitFor({ timeout: 15000 });
    log("I01/I10: „Az importálás elkészült.” - 3 létrehozott ügyfél", /Létrehozott ügyfél\s*3/i.test(await pageA.locator("main").innerText()));
    const after = await pageA.request.get(BASE + "/api/crm/snapshot").then((r) => r.json());
    const sara = after.snapshot.customers.find((c) => c.displayName === "Státuszos Sára");
    log("7.6: az importált ügyfél „Feldolgozásra vár” (a fájl státusza nem került át)", sara && sara.crmStatus === "waiting_for_contact");
    log("D07: a meglévő ügyfél nem duplikálódott és nem íródott felül", after.snapshot.customers.filter((c) => /Melinda/.test(c.displayName ?? "")).length === 1);
    const storage = await pageA.evaluate(() => [Object.keys(localStorage).length, Object.keys(sessionStorage).length]);
    log("6: az importfájl nem kerül böngészőtárolóba (local/sessionStorage üres)", storage[0] === 0 && storage[1] === 0, JSON.stringify(storage));
    await pageA.goto(BASE + "/customers", { waitUntil: "networkidle" });
    log("I10: az importált ügyfelek az Ügyfelek listában", (await pageA.locator("main").innerText()).includes("Böngésző Kft."));

    // ============ H) Importelőzmények ============
    await pageA.goto(BASE + "/data/history", { waitUntil: "networkidle" });
    await pageA.locator('[data-testid="import-job"]').first().waitFor();
    const job = await pageA.locator('[data-testid="import-job"]').first().innerText();
    log("9.4: importnapló: véglegesítve, forrás, importáló, jóváhagyás, SHA-256 - sortartalom nélkül", job.includes("Véglegesítve") && job.includes("E2E fiktív rendezvénylista") && job.includes("Adat Admin") && job.includes("3 létrehozva") && !/Bianka|example\.test/.test(job));
    await checkPage(pageA, "desktop", "importelozmenyek");

    // ============ E) Export ============
    await pageA.goto(BASE + "/data/export", { waitUntil: "networkidle" });
    await pageA.locator('[data-testid="export-count"]').getByText(/Várhatóan/).waitFor();
    log("E: export: a várható rekordszám megjelenik (4 aktív ügyfél)", (await pageA.locator('[data-testid="export-count"]').innerText()).includes("4"));
    await pageA.getByLabel("Ügyféltípus").selectOption("company");
    await pageA.waitForFunction(() => document.querySelector('[data-testid="export-count"]')?.textContent?.includes(" 1 "), null, { timeout: 5000 }).catch(() => {});
    log("E05: típusszűrés frissíti a rekordszámot", (await pageA.locator('[data-testid="export-count"]').innerText()).includes(" 1 "));
    await checkPage(pageA, "desktop", "export");
    const [x1] = await Promise.all([pageA.waitForEvent("download"), pageA.locator('[data-testid="export-run"]').click()]);
    log("E02: XLSX export letöltve, biztonságos fájlnévvel", /^JG_CRM_Ugyfelek_\d{4}-\d{2}-\d{2}_\d{4}\.xlsx$/.test(x1.suggestedFilename()) && fs.statSync(await x1.path()).size > 1000, x1.suggestedFilename());
    await pageA.getByLabel("Ügyféltípus").selectOption("");
    await pageA.getByText("CSV (.csv)").click();
    const [x2] = await Promise.all([pageA.waitForEvent("download"), pageA.locator('[data-testid="export-run"]').click()]);
    const csvText = fs.readFileSync(await x2.path(), "utf8");
    log("E01/E09: CSV export: fejléc, 4 ügyfél, a + kezdetű telefonszám aposztróffal védve", csvText.startsWith("﻿Ügyfélazonosító;") && csvText.trim().split(/\r\n/).length === 5 && csvText.includes(";'+36 30 000 0501;"), csvText.slice(0, 200));
    log("E: „Az exportálás elkészült” visszajelzés", (await pageA.locator("main").innerText()).includes("Az exportálás elkészült"));
    await ctxA.close();

    // ============ R) Reszponzív + akadálymentes nézetek ============
    for (const [label, viewport] of Object.entries(VIEWS).filter(([l]) => l !== "desktop")) {
      const ctx = await browser.newContext(ctxOpts(viewport));
      const page = await ctx.newPage();
      watch(page);
      await login(page, EMAIL_A, PW_A);
      await wizard(page, file1, label, { check: true });
      await page.goto(BASE + "/data/export", { waitUntil: "networkidle" });
      await page.locator('[data-testid="export-count"]').getByText(/Várhatóan/).waitFor();
      await checkPage(page, label, "export");
      await page.goto(BASE + "/data/history", { waitUntil: "networkidle" });
      await page.locator('[data-testid="import-job"]').first().waitFor();
      await checkPage(page, label, "importelozmenyek");
      if (label === "mobil") log("[mobil] az Adatkezelés (v1.1: Beállítások) menüpont a mobil navigációban is elérhető", (await page.locator('nav[aria-label="Fő navigáció (mobil)"] a:has-text("Beállítások")').count()) === 1);
      await ctx.close();
    }

    // ============ P06) Jog visszavonása: a meglévő munkamenettel sem exportálhat ============
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      watch(page);
      await login(page, EMAIL_A, PW_A);
      await stop(server);
      cli(["permission:revoke", EMAIL_A, "crm.customer.export"]);
      server = await startServer(baseEnv);
      const res = await page.request.post(BASE + "/api/data/export", { headers: { origin: BASE }, data: { format: "csv", filters: {} } });
      log("P06: visszavont jog: a korábbi munkamenettel az export 403", res.status() === 403);
      await page.goto(BASE + "/data/export", { waitUntil: "networkidle" });
      log("P06: visszavont jog: az export fül eltűnik, az oldal jogosultsági üzenetet mutat", (await page.locator('[data-testid="no-permission"]').count()) === 1 && (await page.locator('nav[aria-label="Beállítások"] a:has-text("Exportálás")').count()) === 0);
      await ctx.close();
    }

    log("nincs kezeletlen böngészőoldali konzolhiba", errors.length === 0, errors.slice(0, 3).join(" | "));
  } finally {
    if (server) await stop(server).catch(() => {});
    await browser.close();
    fs.rmSync(WORK, { recursive: true, force: true });
  }
  const failed = results.filter((r) => !r.ok);
  console.log(`\n${results.length - failed.length}/${results.length} sikeres${skipped ? `, ${skipped} kihagyva (axe-core nem elérhető)` : ""}`);
  if (failed.length) {
    console.log("Sikertelen:\n" + failed.map((f) => " - " + f.name).join("\n"));
    process.exit(1);
  }
})().catch((e) => {
  console.error("E2E futtatási hiba:", e);
  process.exit(1);
});
