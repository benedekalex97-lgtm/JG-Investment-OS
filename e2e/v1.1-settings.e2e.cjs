/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v1.1 - Beállítások (SET-001-SET-008) böngészős E2E és akadálymentességi ellenőrzés (Playwright + axe-core).
 * Nézetek: 390 (mobil), 768 (tablet), 1280 és 1440 (desktop).
 *
 * Használat (a repó gyökeréből):  npm run build && node e2e/v1.1-settings.e2e.cjs
 *
 * Saját `next start` szervert indít egy ideiglenes, fájl alapú helyi PostgreSQL (PGlite) könyvtárral, migrál, fiktív felhasználókat hoz
 * létre, és az adminnak az üzemeltetői CLI-vel (a dokumentált provisioning-úton) adja a v1.1 adminjogokat. Éles vagy külső adatbázishoz
 * soha nem kapcsolódik. Kizárólag fiktív adat. Az ügyfélimport véglegesítésének kapcsolója (JG_CUSTOMER_IMPORT_ENABLED) NINCS bekapcsolva.
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
const PORT = Number(process.env.E2E_SETTINGS_PORT || 3301);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const WORK = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), "jg-e2e-settings-"));
const DB_DIR = path.join(WORK, "pg");
const ADMIN = { email: "crm.admin@example.test", pw: "e2e-crm-admin-12345", name: "Teszt CRM Admin" };
const WORKER = { email: "munkatars@example.test", pw: "e2e-munkatars-67890", name: "Munkatárs Márk" };
const DATA = { email: "adatos@example.test", pw: "e2e-adatos-24680", name: "Adatos Ada" };
const TZ = "Europe/Budapest";

const results = [];
let skipped = 0;
const log = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name, ok ? "" : extra); };
const skip = (name) => { skipped += 1; console.log("SKIPPED", name, "(axe-core nem érhető el)"); };

const baseEnv = { ...process.env, JG_ENV: "local", JG_PGLITE_DIR: DB_DIR, NODE_ENV: "production", JG_OPERATOR: "E2E Üzemeltető" };
delete baseEnv.JG_CUSTOMER_IMPORT_ENABLED;
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

const ctxOpts = (viewport) => ({ viewport, timezoneId: TZ });
async function login(page, u) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail-cím").fill(u.email);
  await page.getByLabel("Jelszó").fill(u.pw);
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
  await page.screenshot({ path: path.join(SHOTS, `v11-${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}
const notice = async (page) => (await page.locator('[data-testid="settings-notice"]').first().textContent({ timeout: 5000 }).catch(() => "")) || "";
const rowLabels = (page) => page.locator('[data-testid="catalog-row"] [data-testid="catalog-label"]').allTextContents();

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
    for (const u of [ADMIN, WORKER, DATA]) cli(["user:create", u.email, u.name], { JG_USER_PASSWORD: u.pw });
    log("P05: friss migráció után senkinek nincs joga (a régi admin szerep sem ad)", cli(["permission:list"]).trim() === "");
    for (const p of ["crm.settings.manage", "crm.users.manage", "crm.settings.audit.read"]) cli(["permission:grant", ADMIN.email, p]);
    cli(["permission:grant", DATA.email, "crm.customer.export"]);
    server = await startServer(baseEnv);

    // ============ N02/N03/P01: munkatárs - nincs Beállítások, közvetlen URL és API tiltva ============
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      watch(page);
      await login(page, WORKER);
      log("N02: munkatárs: a Beállítások menüpont nem látszik", (await page.locator('nav a:has-text("Beállítások")').count()) === 0);
      for (const p of ["/settings", "/settings/pipeline", "/settings/users", "/settings/audit"]) {
        await page.goto(BASE + p, { waitUntil: "networkidle" });
        log(`N03: munkatárs: ${p} közvetlen URL-lel sem nyílik meg`, (await page.locator('[data-testid="no-permission"]').count()) === 1 && (await page.locator('[data-testid="catalog-row"], [data-testid="user-row"], [data-testid="audit-entry"]').count()) === 0);
      }
      const res = await page.request.post(BASE + "/api/settings/pipeline", { headers: { origin: BASE }, data: { label: "Behatoló" } });
      log("P01/P03: munkatárs: a konfiguráció API-n sem módosítható (403)", res.status() === 403);
      await ctx.close();
    }

    // ============ Admin: áttekintés, Pipeline-szerkesztés ============
    const ctxA = await browser.newContext(ctxOpts(VIEWS.desktop));
    const pageA = await ctxA.newPage();
    watch(pageA);
    await login(pageA, ADMIN);
    log("N01: admin: a Beállítások menüpont látszik", (await pageA.locator('nav[aria-label="Fő navigáció"] a:has-text("Beállítások")').count()) === 1);
    await pageA.locator('nav[aria-label="Fő navigáció"] a:has-text("Beállítások")').click();
    await pageA.waitForURL("**/settings");
    await pageA.locator('[data-testid="settings-stat"]').first().waitFor();
    const stats = await pageA.locator('[data-testid="settings-stat"]').allTextContents();
    log("SET-001: áttekintés valós adatokkal (3 aktív felhasználó, 7 státusz, 6 típus, import kikapcsolva)",
      stats.some((s) => s.startsWith("Aktív felhasználók3")) && stats.some((s) => s.startsWith("Aktív Pipeline-státuszok7")) && stats.some((s) => s.startsWith("Aktív feladattípusok6")) && stats.some((s) => s.includes("Véglegesítés kikapcsolva")), stats.join(" | "));
    const navItems = await pageA.locator('nav[aria-label="Beállítások"] a').allTextContents();
    log("N05: admin: a működő aloldalak elérhetők, az adatkezelési jog nélküliek nem", navItems.join("|") === "Áttekintés|Felhasználók és jogosultságok|Pipeline-státuszok|Feladattípusok|Input-opciók|Változásnapló", navItems.join("|"));
    await checkPage(pageA, "desktop", "beallitasok attekintes");

    await pageA.goto(BASE + "/settings/pipeline", { waitUntil: "networkidle" });
    await pageA.locator('[data-testid="catalog-row"]').first().waitFor();
    log("S01: a hét meglévő státusz sorrendben", (await rowLabels(pageA)).join("|") === "Feldolgozásra vár|Kapcsolatfelvétel|Kapcsolatépítés|Online/Személyes tárgyalás|Számlanyitás|Tőke elhelyezve|Elvesztett");
    log("S11: rendszerstátusznál nincs archiválás gomb", (await pageA.getByRole("button", { name: "Feldolgozásra vár archiválása" }).count()) === 0);
    await checkPage(pageA, "desktop", "pipeline statuszok");
    await pageA.getByRole("button", { name: "+ Új státusz hozzáadása" }).click();
    const dlg = pageA.locator("dialog[open]");
    await dlg.getByLabel("Megnevezés").fill("E2E Ajánlat");
    await dlg.locator('label:has-text("Kékeszöld")').click();
    await checkPage(pageA, "desktop", "pipeline uj statusz modal");
    await dlg.getByRole("button", { name: "Mentés" }).click();
    await pageA.locator('[data-key="e2e_ajanlat"]').waitFor();
    log("S02: új státusz létrehozva, visszajelzés: „A beállítás mentve.”", (await notice(pageA)).includes("A beállítás mentve."));
    await pageA.reload({ waitUntil: "networkidle" });
    await pageA.locator('[data-key="e2e_ajanlat"]').waitFor();
    log("S02: frissítés után is megmarad (adatbázis)", (await rowLabels(pageA)).at(-1) === "E2E Ajánlat");

    // S04 átnevezés
    await pageA.getByRole("button", { name: "E2E Ajánlat szerkesztése" }).click();
    await dlg.getByLabel("Megnevezés").fill("E2E Ajánlatkérés");
    await dlg.getByRole("button", { name: "Mentés" }).click();
    await pageA.locator('[data-key="e2e_ajanlat"] [data-testid="catalog-label"]:has-text("E2E Ajánlatkérés")').waitFor();
    log("S04: átnevezés; a technikai kulcs változatlan", (await pageA.locator('[data-key="e2e_ajanlat"]').count()) === 1);

    // S05 sorrend billentyűzettel
    const up = pageA.getByRole("button", { name: "E2E Ajánlatkérés feljebb mozgatása" });
    await up.focus();
    await pageA.keyboard.press("Enter");
    await pageA.keyboard.press("Enter");
    log("S05: billentyűzettel átrendezhető, mentés előtt jelzés", (await pageA.locator('[data-testid="order-bar"]').count()) === 1 && (await rowLabels(pageA)).indexOf("E2E Ajánlatkérés") === 5);
    await pageA.getByRole("button", { name: "Sorrend mentése" }).click();
    await pageA.locator('[data-testid="order-bar"]').waitFor({ state: "detached" });
    await pageA.reload({ waitUntil: "networkidle" });
    await pageA.locator('[data-testid="catalog-row"]').first().waitFor();
    log("S05: a sorrend frissítés után is megmarad", (await rowLabels(pageA)).indexOf("E2E Ajánlatkérés") === 5, (await rowLabels(pageA)).join("|"));

    // S14/S15: a CRM többi része azonnal az új státuszt használja
    await pageA.goto(BASE + "/customers/new", { waitUntil: "networkidle" });
    const options = await pageA.getByLabel("Kapcsolati státusz").locator("option").allTextContents();
    log("S14: új ügyfélnél választható az új státusz", options.includes("E2E Ajánlatkérés"));
    await pageA.getByLabel(/^Név/).fill("E2E Fiktív Ügyfél");
    await pageA.getByLabel("Kapcsolati státusz").selectOption({ label: "E2E Ajánlatkérés" });
    await pageA.getByRole("button", { name: "Ügyfél létrehozása" }).click();
    await pageA.waitForURL("**/customers/cust-*");
    log("S15: az ügyféladatlapon az új státusz látszik", (await pageA.getByLabel("Kapcsolati státusz").inputValue()) === "e2e_ajanlat");
    const customerUrl = pageA.url();
    await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
    log("S14: a Pipeline-on saját oszlopa van", (await pageA.locator('section[aria-label^="E2E Ajánlatkérés"]').count()) === 1);

    // S07/S08/S10: archiválás megerősítéssel, a meglévő ügyfél megmarad
    await pageA.goto(BASE + "/settings/pipeline", { waitUntil: "networkidle" });
    await pageA.getByRole("button", { name: "E2E Ajánlatkérés archiválása" }).click();
    log("S07: használatban lévő státusznál figyelmeztetés", (await dlg.getByRole("alert").textContent()).includes("NEM helyezi át"));
    await checkPage(pageA, "desktop", "pipeline archivalas megerosites");
    await dlg.getByRole("button", { name: "Archiválás megerősítése" }).click();
    await pageA.getByRole("button", { name: "E2E Ajánlatkérés újraaktiválása" }).waitFor();
    await pageA.goto(customerUrl, { waitUntil: "networkidle" });
    const sel = pageA.getByLabel("Kapcsolati státusz");
    log("S08: az ügyfél megtartja az archivált státuszt, az adatlap megnyílik", (await sel.inputValue()) === "e2e_ajanlat" && (await sel.locator("option:checked").textContent()).includes("archivált"));
    log("S09: archivált státusz új váltásként nem választható", (await sel.locator('option[value="e2e_ajanlat"]:not([disabled])').count()) === 0);
    await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
    log("S08: a Pipeline-on archivált oszlopként látható", (await pageA.locator('section[aria-label^="E2E Ajánlatkérés (archivált)"]').count()) === 1);
    await pageA.goto(BASE + "/settings/pipeline", { waitUntil: "networkidle" });
    await pageA.getByRole("button", { name: "E2E Ajánlatkérés újraaktiválása" }).click();
    await pageA.getByRole("button", { name: "E2E Ajánlatkérés archiválása" }).waitFor();
    log("S10: újraaktiválás", true);

    // S19: párhuzamos módosítás - a második mentés nem írja felül csendben
    {
      const page2 = await ctxA.newPage();
      watch(page2);
      await page2.goto(BASE + "/settings/pipeline", { waitUntil: "networkidle" });
      await page2.locator('[data-key="e2e_ajanlat"]').waitFor();
      await pageA.reload({ waitUntil: "networkidle" });
      await pageA.getByRole("button", { name: "E2E Ajánlatkérés szerkesztése" }).click();
      await dlg.getByLabel("Megnevezés").fill("E2E Ajánlatkérés (A)");
      await dlg.getByRole("button", { name: "Mentés" }).click();
      await pageA.locator('[data-testid="catalog-label"]:has-text("E2E Ajánlatkérés (A)")').waitFor();
      await page2.getByRole("button", { name: "E2E Ajánlatkérés szerkesztése" }).click();
      await page2.locator("dialog[open]").getByLabel("Megnevezés").fill("E2E Ajánlatkérés (B)");
      await page2.locator("dialog[open]").getByRole("button", { name: "Mentés" }).click();
      await page2.locator('[data-testid="settings-notice"]').waitFor();
      log("S19: párhuzamos módosítás: „A beállítás időközben megváltozott…” üzenet, nincs felülírás",
        (await notice(page2)).includes("A beállítás időközben megváltozott. Frissítsd az adatokat az új mentés előtt.") && (await page2.locator('[data-testid="catalog-label"]:has-text("(B)")').count()) === 0);
      await page2.close();
    }

    // ============ T/I: feladattípus és Input ============
    await pageA.goto(BASE + "/settings/tasks/types", { waitUntil: "networkidle" });
    await pageA.locator('[data-testid="catalog-row"]').first().waitFor();
    log("T01: a hat meglévő feladattípus", (await rowLabels(pageA)).join("|") === "Telefonhívás|E-mail|Online tárgyalás|Személyes tárgyalás|Utánkövetés|Egyéb");
    await pageA.getByRole("button", { name: "+ Új feladattípus hozzáadása" }).click();
    await dlg.getByLabel("Megnevezés").fill("E2E Videóhívás");
    await dlg.getByRole("button", { name: "Mentés" }).click();
    await pageA.locator('[data-key="e2e_videohivas"]').waitFor();
    await checkPage(pageA, "desktop", "feladattipusok");
    await pageA.goto(BASE + "/settings/tasks/inputs", { waitUntil: "networkidle" });
    await pageA.getByRole("button", { name: "+ Új Input-opció hozzáadása" }).click();
    await dlg.getByLabel("Megnevezés").fill("E2E Rendezvény");
    await dlg.getByLabel(/Rövid megjegyzés adható hozzá/).check();
    await dlg.getByRole("button", { name: "Mentés" }).click();
    await pageA.locator('[data-key="e2e_rendezveny"]').waitFor();
    log("I02: új, megjegyzést engedő Input-opció", (await pageA.locator('[data-key="e2e_rendezveny"]:has-text("Megjegyzés engedélyezett")').count()) === 1);
    await checkPage(pageA, "desktop", "input opciok");
    await pageA.goto(customerUrl, { waitUntil: "networkidle" });
    await pageA.getByRole("button", { name: "+ Feladat hozzáadása" }).click();
    const typeOpts = await dlg.getByLabel("Feladat típusa").locator("option").allTextContents();
    log("T02/I05: az új feladatnál választható az új típus és Input", typeOpts.includes("E2E Videóhívás") && (await dlg.getByLabel("Input (opcionális)").locator("option").allTextContents()).includes("E2E Rendezvény"));
    await dlg.getByLabel("Feladat típusa").selectOption({ label: "E2E Videóhívás" });
    await dlg.getByLabel("Input (opcionális)").selectOption({ label: "E2E Rendezvény" });
    log("I07: a megjegyzés mező a megjegyzést engedő Inputnál megjelenik", (await dlg.getByLabel("Rövid megjegyzés (opcionális)").count()) === 1);
    await dlg.getByLabel("Rövid megjegyzés (opcionális)").fill("E2E fiktív rendezvény");
    await dlg.getByRole("button", { name: "Feladat létrehozása" }).click();
    await pageA.locator('dialog[open]').waitFor({ state: "detached" }).catch(() => {});
    await pageA.waitForTimeout(500);
    log("T02: a feladat az új típus nevével jön létre", (await pageA.locator("#feladatok-lista").textContent()).includes("E2E Videóhívás"));

    // ============ SET-003: felhasználók és jogosultságok ============
    await pageA.goto(BASE + "/settings/users", { waitUntil: "networkidle" });
    await pageA.locator('[data-testid="user-row"]').first().waitFor();
    log("U01/U03: a felhasználólista nevekkel, jogokkal; saját sor nem szerkeszthető", (await pageA.locator('[data-testid="user-row"]').count()) === 3 && (await pageA.getByRole("button", { name: `${ADMIN.name} jogosultságainak szerkesztése` }).count()) === 0);
    await checkPage(pageA, "desktop", "felhasznalok");
    await pageA.getByRole("button", { name: `${WORKER.name} jogosultságainak szerkesztése` }).click();
    await dlg.getByLabel(/CRM-beállítások kezelése/).check();
    await dlg.getByRole("button", { name: "Változások előnézete" }).click();
    log("U04: a változások előnézete megerősítés előtt", (await dlg.getByRole("list", { name: "Változások" }).textContent()).includes("Kiosztás: CRM-beállítások kezelése"));
    await checkPage(pageA, "desktop", "jogosultsag elonezet");
    await dlg.getByRole("button", { name: "Megerősítés" }).click();
    await pageA.locator('[data-testid="settings-notice"]').waitFor();
    log("U04: kiosztva, visszajelzés", (await notice(pageA)).includes("A beállítás mentve."));
    {
      const ctxW = await browser.newContext(ctxOpts(VIEWS.desktop));
      const pw = await ctxW.newPage();
      watch(pw);
      await login(pw, WORKER);
      log("U04/P02: a jogot kapott munkatárs látja a Beállításokat és a Pipeline-szerkesztőt", (await pw.locator('nav a:has-text("Beállítások")').count()) > 0);
      await pageA.reload({ waitUntil: "networkidle" });
      await pageA.getByRole("button", { name: `${WORKER.name} jogosultságainak szerkesztése` }).click();
      await dlg.getByLabel(/CRM-beállítások kezelése/).uncheck();
      await dlg.getByRole("button", { name: "Változások előnézete" }).click();
      await dlg.getByRole("button", { name: "Megerősítés" }).click();
      await pageA.locator('[data-testid="settings-notice"]').waitFor();
      await pw.goto(BASE + "/settings/pipeline", { waitUntil: "networkidle" });
      log("U05/P04: visszavonás azonnal hat a meglévő munkamenetre is", (await pw.locator('[data-testid="no-permission"]').count()) === 1);
      await ctxW.close();
    }

    // ============ SET-008: változásnapló ============
    await pageA.goto(BASE + "/settings/audit", { waitUntil: "networkidle" });
    await pageA.locator('[data-testid="audit-entry"]').first().waitFor();
    const auditText = (await pageA.locator('[data-testid="audit-entry"]').allTextContents()).join(" ");
    log("A01-A05: a változásnapló a státusz-, típus-, Input- és jogosultság-változásokat mutatja",
      ["Létrehozva", "Átnevezve", "Sorrend módosítva", "Archiválva", "Újraaktiválva", "Jogosultság kiosztva", "Jogosultság visszavonva", "Üzemeltetői CLI"].every((x) => auditText.includes(x)), auditText.slice(0, 300));
    await checkPage(pageA, "desktop", "valtozasnaplo");
    await ctxA.close();

    // ============ SET-007: adatkezelés az új helyen, régi URL-ek ============
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      watch(page);
      await login(page, DATA);
      await page.goto(BASE + "/data/export", { waitUntil: "networkidle" });
      log("D05: a régi /data/export URL a Beállítások > Adatkezelés alá irányít", page.url().endsWith("/settings/data/export"));
      log("D02: az export elérhető a v1.0 joggal (adminjog nélkül)", (await page.getByRole("button", { name: /Exportálás/ }).count()) > 0);
      const nav = await page.locator('nav[aria-label="Beállítások"] a').allTextContents();
      log("SET-007: csak adatkezelési joggal az Adatkezelés látszik, a Pipeline és a felhasználók nem", nav.join("|") === "Áttekintés|Exportálás", nav.join("|"));
      await page.goto(BASE + "/data", { waitUntil: "networkidle" });
      await page.waitForURL("**/settings/data/export");
      log("D05: a régi /data kezdőoldal az első jogosult adatkezelési aloldalra visz", true);
      await page.goto(BASE + "/settings", { waitUntil: "networkidle" });
      await page.locator('[data-testid="settings-stat"]').first().waitFor();
      const s = await page.locator('[data-testid="settings-stat"]').allTextContents();
      log("SET-001: adatkezelési joggal az áttekintés felhasználói számokat nem mutat", !s.some((x) => x.startsWith("Aktív felhasználók")));
      log("D06: az import véglegesítése továbbra is kikapcsolt", s.some((x) => x.includes("Véglegesítés kikapcsolva")));
      const res = await page.request.post(BASE + "/api/data/import/commit", { headers: { origin: BASE }, multipart: { meta: "{}" } });
      log("D07: import jog nélkül a feltöltés tiltott (403)", res.status() === 403);
      await ctx.close();
    }

    // ============ Reszponzív: 390 / 768 / 1280 / 1440 ============
    for (const [label, viewport] of Object.entries(VIEWS)) {
      const ctx = await browser.newContext(ctxOpts(viewport));
      const page = await ctx.newPage();
      watch(page);
      await login(page, ADMIN);
      if (label === "mobil" || label === "tablet") log(`[${label}] N04: a Beállítások a mobil navigációban elérhető`, (await page.locator('nav[aria-label="Fő navigáció (mobil)"] a:has-text("Beállítások")').count()) === 1);
      for (const [p, tag, wait] of [["/settings", "attekintes", '[data-testid="settings-stat"]'], ["/settings/pipeline", "pipeline", '[data-testid="catalog-row"]'], ["/settings/users", "felhasznalok", '[data-testid="user-row"]'], ["/settings/audit", "naplo", '[data-testid="audit-entry"]']]) {
        await page.goto(BASE + p, { waitUntil: "networkidle" });
        await page.locator(wait).first().waitFor();
        if (label !== "desktop") await checkPage(page, label, tag);
      }
      if (label === "mobil") {
        await page.goto(BASE + "/settings/pipeline", { waitUntil: "networkidle" });
        await page.getByRole("button", { name: "Elvesztett szerkesztése" }).click();
        await checkPage(page, label, "pipeline szerkeszto modal");
        log("[mobil] a modál a képernyőn belül marad", await page.locator("dialog[open]").evaluate((d) => d.getBoundingClientRect().right <= window.innerWidth));
      }
      await ctx.close();
    }

    // Billentyűzet: a fókusz látható, a Beállítások link Tab-bal elérhető.
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      await login(page, ADMIN);
      let reached = false;
      for (let i = 0; i < 25 && !reached; i++) {
        await page.keyboard.press("Tab");
        reached = await page.evaluate(() => document.activeElement?.textContent?.trim() === "Beállítások");
      }
      const outline = reached ? await page.evaluate(() => getComputedStyle(document.activeElement).outlineStyle) : "none";
      log("billentyűzet: a Beállítások menüpont Tab-bal elérhető, látható fókusszal", reached && outline !== "none", `outline=${outline}`);
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
