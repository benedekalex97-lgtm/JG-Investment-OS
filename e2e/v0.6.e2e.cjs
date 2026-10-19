/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v0.6-v0.9 (tartós adattárolás, bejelentkezés, feladat Input legördülő, jobb oldali kapcsolati adatok; v0.9: Sikeres /
 * Sikertelen lezárás kötelező szabad szöveges Outputtal, átidőzítés, Előzmények, globális kereső) — E2E és akadálymentességi ellenőrzés
 * (Playwright). Nézetek: 390 (mobil), 768 (tablet), 1280 és 1440 (desktop).
 *
 * Használat (a repó gyökeréből):
 *   npm run build
 *   npm run e2e                  # saját szervert indít: új, ideiglenes PGlite adatbázissal; AXE_PATH opcionális
 *
 * A futtató saját, éles buildet kiszolgáló szervert (`next start`) indít egy ideiglenes, fájl alapú helyi PostgreSQL (PGlite)
 * könyvtárral, migrálja és két fiktív pilot felhasználót hoz létre (a db CLI-vel). Teljes újraindítást is szimulál (a szerverfolyamat
 * leáll és újraindul ugyanazzal az adatbázissal). Éles vagy külső adatbázishoz soha nem kapcsolódik. Kizárólag fiktív adat.
 * Playwright: require("playwright") -> PLAYWRIGHT_PATH -> /opt/node22/lib/node_modules/playwright. axe-core: AXE_PATH vagy
 * require.resolve("axe-core/axe.min.js"); ha nincs, az a11y lépések "SKIPPED"-ként jelennek meg (NEM sikeresként).
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn, spawnSync } = require("child_process");
const { randomUUID } = require("crypto");

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
const PORT = Number(process.env.E2E_PORT || 3101);
const BASE = `http://127.0.0.1:${PORT}`;
const BASE_UNCONFIGURED = `http://127.0.0.1:${PORT + 1}`;
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const WORK = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), "jg-e2e-"));
const DB_DIR = path.join(WORK, "pg");
const EMAIL_A = "pilot.egy@example.test", PW_A = "e2e-jelszo-egy-12345";
const EMAIL_B = "pilot.ketto@example.test", PW_B = "e2e-jelszo-ketto-67890";

const results = [];
let skipped = 0;
const log = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name, ok ? "" : extra); };
const skip = (name) => { skipped += 1; console.log("SKIPPED", name, "(axe-core nem érhető el)"); };

const STATUSES = ["Feldolgozásra vár", "Kapcsolatfelvétel", "Kapcsolatépítés", "Online/Személyes tárgyalás", "Számlanyitás", "Tőke elhelyezve", "Elvesztett"];
const INPUTS = ["Első megkeresés", "Visszahívás", "Időpont-egyeztetés", "Tájékoztatás", "Utánkövetés", "Egyéb"];
const TYPES = ["Telefonhívás", "E-mail", "Online tárgyalás", "Személyes tárgyalás", "Utánkövetés", "Egyéb"];

// ----------------------------------------------------------------- szerverkezelés
const baseEnv = { ...process.env, JG_ENV: "local", JG_PGLITE_DIR: DB_DIR, NODE_ENV: "production" };
function cli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", ...args], { cwd: ROOT, env: { ...baseEnv, ...extraEnv }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`db ${args.join(" ")} sikertelen: ${r.stderr}`);
  return r.stdout;
}
let server = null;
async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port), "-H", "127.0.0.1"], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  child.stdout.on("data", (d) => { out += d; });
  child.stderr.on("data", (d) => { out += d; });
  child.exited = new Promise((res) => child.on("exit", res));
  for (let i = 0; i < 120; i++) {
    try { const r = await fetch(`http://127.0.0.1:${port}/api/status`, { signal: AbortSignal.timeout(2000) }); if (r.status === 200 || r.status === 503) return child; } catch { /* még nem fut */ }
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

// ----------------------------------------------------------------- segédek
const shows = (loc) => loc.first().waitFor({ state: "visible", timeout: 5000 }).then(() => true, () => false);
const dlg = (page) => page.locator("dialog[open]");
const settle = (page) => page.waitForTimeout(400);
const pad = (n) => String(n).padStart(2, "0");
/** A mai nap (Europe/Budapest, az alkalmazás időzónája) eltolva, ÉÉÉÉ-HH-NN alakban. */
const TZ = "Europe/Budapest";
const budapestToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date());
const dateInput = (offsetDays) => { const [y, m, d] = budapestToday().split("-").map(Number); return new Date(Date.UTC(y, m - 1, d + offsetDays)).toISOString().slice(0, 10); };
/** A dátummező értékéből mentett ISO időpont: a budapesti nap déli 12:00-ja (lásd src/domain/time.ts). */
const noonIso = (key) => { const [y, m, d] = key.split("-").map(Number); for (const off of [1, 2]) { const iso = new Date(Date.UTC(y, m - 1, d, 12 - off)).toISOString(); if (new Intl.DateTimeFormat("en-GB", { timeZone: TZ, hour: "2-digit", hourCycle: "h23" }).format(new Date(iso)) === "12") return iso; } return ""; };
const huDate = (key) => new Intl.DateTimeFormat("hu-HU", { timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit" }).format(new Date(noonIso(key)));
const ctxOpts = (viewport, extra = {}) => ({ viewport, timezoneId: TZ, ...extra });
const statusSelect = (page) => page.getByLabel("Kapcsolati státusz");
/** Feladatsor a feladat neve alapján (v0.9: nincs checkbox; a címre vagy a „Részletek”-re kattintva a közös feladatmodál nyílik). */
const taskRow = (page, title) => page.locator(`li[data-task-id]:has(button[aria-haspopup="dialog"] > span:first-child:text-is("${title}"))`).first();
const SIDE = 'aside[aria-labelledby="kapcsolati-adatok-cim"]';
const col = (page, label) => page.locator(`section[aria-label^="${label} ("]`);
const optionTexts = (loc) => loc.locator("option").allTextContents().then((a) => a.map((t) => t.trim()).filter((t) => !t.startsWith("—")));
async function until(fn, ms = 8000) { const end = Date.now() + ms; while (Date.now() < end) { if (await fn()) return true; await new Promise((r) => setTimeout(r, 150)); } return false; }
async function login(page, email, pw) {
  await page.goto(BASE + "/", { waitUntil: "networkidle" });
  await page.getByLabel("E-mail-cím").fill(email);
  await page.getByLabel("Jelszó").fill(pw);
  await page.getByRole("button", { name: "Belépés" }).click();
  await page.waitForSelector('[data-testid="current-user"]');
}
async function openCustomer(page, name) {
  await page.goto(BASE + "/customers", { waitUntil: "networkidle" });
  await page.locator(`main a:has-text("${name}")`).first().click();
  await page.waitForURL("**/customers/cust-*");
  await page.waitForSelector(`main h1:has-text("${name}")`);
}
async function newCustomer(page, fields) {
  await page.goto(BASE + "/customers/new", { waitUntil: "networkidle" });
  if (fields.company) await page.getByText("Cég", { exact: true }).click();
  if (fields.name) await page.getByLabel(/^Név/).fill(fields.name);
  if (fields.companyName) await page.getByLabel(/^Cégnév/).fill(fields.companyName);
  if (fields.contact) await page.getByLabel(/Kapcsolati személy neve/).fill(fields.contact);
  if (fields.phone) await page.getByLabel(/^Telefonszám/).fill(fields.phone);
  if (fields.email) await page.getByLabel(/^E-mail/).fill(fields.email);
  if (fields.source) await page.getByLabel(/^Adatforrás/).fill(fields.source);
  await page.getByRole("button", { name: "Ügyfél létrehozása", exact: true }).click();
  await page.waitForURL("**/customers/cust-*");
  await page.waitForSelector(`main h1:has-text("${fields.name || fields.companyName}")`);
}
async function addTask(page, typeLabel, opts = {}) {
  await page.click('button:has-text("+ Feladat hozzáadása")');
  await dlg(page).getByLabel(/Feladat típusa/).selectOption({ label: typeLabel });
  if (opts.input) await dlg(page).getByLabel(/^Input/).selectOption({ label: opts.input });
  if (opts.note) await dlg(page).getByLabel(/Rövid megjegyzés/).fill(opts.note);
  if (opts.due) await dlg(page).getByLabel(/Határidő/).fill(opts.due);
  await dlg(page).locator("button[type=submit]").click();
  await dlg(page).waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await settle(page);
}
/** A feladat közös modálja (CRM-007): a sor címére kattintva nyílik; a nyitott dialógust adja vissza. */
async function openTask(row, via = "title") {
  await row.locator('button[aria-haspopup="dialog"]').nth(via === "details" ? 1 : 0).click();
  const d = row.page().getByRole("dialog");
  await d.getByRole("heading", { name: "Feladat részletei" }).waitFor({ timeout: 8000 });
  return d;
}
/** Lezárás (v0.9): a modálban az Output kitöltése, Sikeres / Sikertelen, majd a következő-feladat kérdésre „Most nem”. */
async function closeTask(page, title, outcome, output) {
  const d = await openTask(taskRow(page, title));
  await d.getByLabel(/^Output/).fill(output);
  await d.getByRole("button", { name: outcome === "success" ? "Sikeres lezárás" : "Sikertelen lezárás", exact: true }).click();
  await d.getByText("Szeretnél következő feladatot létrehozni?").waitFor({ timeout: 8000 });
  await d.getByRole("button", { name: "Most nem" }).click();
  await dlg(page).waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await settle(page);
}
const closeDialog = async (page) => { await page.keyboard.press("Escape"); await dlg(page).waitFor({ state: "detached", timeout: 5000 }).catch(() => {}); };
async function checkPage(page, label, tag) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  log(`[${label}] ${tag}: nincs vízszintes oldalgörgetés`, overflow <= 0, `overflow=${overflow}`);
  if (axeSrc) {
    await page.evaluate(axeSrc);
    const v = await page.evaluate(async () => (await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}(${x.nodes.length}):${x.nodes[0].target}`));
    log(`[${label}] ${tag}: axe (WCAG A/AA)`, v.length === 0, v.join("; "));
  } else skip(`[${label}] ${tag}: axe`);
  await page.screenshot({ path: path.join(SHOTS, `v06-${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"] } : {});
  const DESKTOP = { width: 1440, height: 900 }, MOBILE = { width: 390, height: 844 };
  try {
    // ============ 0) Adatbázis nélkül: nincs csendes tartalék ============
    {
      const unconfigured = await startServer(PORT + 1, { ...process.env, NODE_ENV: "production", JG_ENV: "", JG_PGLITE_DIR: "", DATABASE_URL: "" });
      const ctx = await browser.newContext(ctxOpts(DESKTOP));
      const page = await ctx.newPage();
      await page.goto(BASE_UNCONFIGURED + "/", { waitUntil: "networkidle" });
      await page.waitForSelector('[data-testid="infra-notice"]');
      const t = await page.locator('[data-testid="infra-notice"]').innerText();
      log("adatbázis nélkül: „Tartós infrastruktúra összekötésre vár” állapot, nem működő CRM", /Tartós infrastruktúra összekötésre vár/.test(t) && (await page.locator("text=Bejelentkezés").count()) === 0 && (await page.locator('a:has-text("Ügyfelek")').count()) === 0);
      const snap = await fetch(BASE_UNCONFIGURED + "/api/crm/snapshot");
      log("adatbázis nélkül: az API 503-at ad (nincs böngészős vagy memóriás tartalék)", snap.status === 503 && (await snap.json()).state === "not_configured");
      const storageKeys = await page.evaluate(() => [Object.keys(localStorage).length, Object.keys(sessionStorage).length]);
      log("adatbázis nélkül: a böngészőben (local/sessionStorage) nem keletkezik adat", storageKeys[0] === 0 && storageKeys[1] === 0, JSON.stringify(storageKeys));
      await checkPage(page, "desktop", "infrastruktúra hiánya");
      await ctx.close();
      await stop(unconfigured);
    }

    // ============ 1) Felkészítés: migráció + két pilot felhasználó ============
    cli(["migrate"]);
    cli(["user:create", EMAIL_A, "Teszt Pilot Egy"], { JG_USER_PASSWORD: PW_A });
    cli(["user:create", EMAIL_B, "Teszt Pilot Kettő"], { JG_USER_PASSWORD: PW_B });
    server = await startServer(PORT, baseEnv);

    // ============ A) Hitelesítés, üres CRM (desktop) ============
    const ctxA = await browser.newContext(ctxOpts(DESKTOP, { acceptDownloads: true }));
    const pageA = await ctxA.newPage();
    const errors = [];
    pageA.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    pageA.on("pageerror", (e) => errors.push(String(e)));
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      L("bejelentkezés nélkül a belépési űrlap látszik, az ügyfél-adat és a navigáció nem", (await pageA.getByRole("heading", { name: "Bejelentkezés" }).isVisible()) && (await pageA.locator('nav[aria-label^="Fő navigáció"]').count()) === 0);
      L("E9: bejelentkezés nélkül nincs globális kereső és nincs keresési javaslat", (await pageA.getByRole("combobox").count()) === 0 && (await pageA.getByRole("option").count()) === 0);
      await checkPage(pageA, "desktop", "bejelentkezés");
      await pageA.getByLabel("E-mail-cím").fill(EMAIL_A);
      await pageA.getByLabel("Jelszó").fill("hibas-jelszo-12345");
      await pageA.getByRole("button", { name: "Belépés" }).click();
      await pageA.waitForSelector("text=Hibás e-mail-cím vagy jelszó.");
      L("hibás jelszó: általános hibaüzenet, nincs belépés", (await pageA.getByRole("heading", { name: "Bejelentkezés" }).isVisible()) && (await pageA.locator('[data-testid="current-user"]').count()) === 0);
      const unauth = await pageA.request.get(BASE + "/api/crm/snapshot");
      L("munkamenet nélkül a szerver API 401-et ad", unauth.status() === 401);
      const unauthWrite = await pageA.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: "11111111-1111-4111-8111-111111111111", op: "customer.create", args: { input: { type: "individual", name: "Jogosulatlan" } } } });
      L("munkamenet nélkül az írás is 401, és nem keletkezik rekord", unauthWrite.status() === 401);
      await pageA.getByLabel("Jelszó").fill(PW_A);
      await pageA.getByRole("button", { name: "Belépés" }).click();
      await pageA.waitForSelector('[data-testid="current-user"]');
      L("sikeres belépés: a felhasználó neve és a környezet-címke látszik", (await pageA.locator('[data-testid="current-user"]').innerText()) === "Teszt Pilot Egy" && /HELYI/.test(await pageA.locator('[data-testid="environment-label"]').innerText()));
      const cookies = await ctxA.cookies();
      const sess = cookies.find((c) => c.name === "jg_session");
      L("a munkamenet-süti HttpOnly és SameSite=Lax; a JS nem éri el", !!sess && sess.httpOnly && sess.sameSite === "Lax" && !(await pageA.evaluate(() => document.cookie)).includes("jg_session"));
      L("üres CRM: az áttekintés üres állapotot mutat", await pageA.locator("text=Még nincs rögzített ügyfél.").first().isVisible());
      const navText = (await pageA.locator('nav[aria-label^="Fő navigáció"] a:visible').allTextContents()).map((t) => t.trim()).join("|");
      L("főmenü: Áttekintés / Pipeline / Ügyfelek", navText === "Áttekintés|Pipeline|Ügyfelek", navText);
      await pageA.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("üres ügyféllista", await pageA.locator("text=Még nincs rögzített ügyfél.").first().isVisible());
      await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      L("üres pipeline: nincs kártya, üres állapot", (await pageA.locator("article").count()) === 0 && (await pageA.locator("text=Még nincs rögzített ügyfél.").first().isVisible()));
      const emptyStorage = await pageA.evaluate(() => [Object.keys(localStorage), Object.keys(sessionStorage)]);
      L("a böngészőtár üres: az alkalmazás nem tárol üzleti adatot localStorage/sessionStorage-ban", emptyStorage[0].length === 0 && emptyStorage[1].length === 0, JSON.stringify(emptyStorage));

      // ============ B) Ügyfelek létrehozása ============
      await newCustomer(pageA, { name: "Minta Mária" });
      L("magánszemély létrejött csak névvel; az adatlap fejléce: név + státusz egymás mellett", (await pageA.locator("h1:has-text('Minta Mária')").isVisible()) && (await statusSelect(pageA).inputValue()) === "waiting_for_contact");
      const side = pageA.locator(SIDE);
      L("jobb oldali sáv „Kapcsolati adatok”: hiányzó adat visszafogottan „Nincs megadva”", (await side.getByRole("heading", { name: "Kapcsolati adatok" }).isVisible()) && (await side.locator("text=Nincs megadva").count()) === 3, String(await side.locator("text=Nincs megadva").count()));
      L("magánszemélynél nincs „Kapcsolati személy” mező", (await side.locator("dt:has-text('Kapcsolati személy')").count()) === 0);
      await newCustomer(pageA, { company: true, companyName: "Minta Kft.", contact: "Kovács Anna", phone: "+36 30 123 4567", email: "anna@example.test", source: "ajánlás" });
      const sideText = await pageA.locator('aside[aria-labelledby="kapcsolati-adatok-cim"]').innerText();
      L("cég: a kapcsolati személy, telefon, e-mail és adatforrás a jobb oldali sávban látszik", ["Kapcsolati személy", "Kovács Anna", "+36 30 123 4567", "anna@example.test", "ajánlás", "Szerkesztés"].every((x) => sideText.includes(x)), sideText);
      L("a cég cégnév a fejlécben, a régi nagy „Megkeresési információk” panel nincs sehol", (await pageA.locator("h1:has-text('Minta Kft.')").isVisible()) && (await pageA.locator("text=/Megkeresési információk|Megkereshetőség|Tiltakozás rögzítése/").count()) === 0);

      // ============ C) Elrendezés: két oszlop ============
      const geo = await pageA.evaluate(() => {
        const r = (el) => { const b = el.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height, r: b.right }; };
        const aside = document.querySelector('aside[aria-labelledby="kapcsolati-adatok-cim"]');
        const tasks = document.querySelector("#feladatok-lista");
        const head = document.querySelector("#ugyfel");
        return { aside: r(aside), tasks: r(tasks), head: r(head), pos: getComputedStyle(aside).position };
      });
      const total = geo.aside.w + geo.tasks.w;
      L("desktop: kétoszlopos elrendezés - bal főtartalom, jobb oldali sáv ≈30%", geo.aside.x > geo.tasks.r - 1 && Math.abs(geo.aside.w / total - 0.3) < 0.06, JSON.stringify({ ratio: geo.aside.w / total }));
      L("desktop: a fejléc (név + státusz) a két oszlop felett, a sáv a feladatokkal egy sorban", geo.head.y + geo.head.h <= Math.min(geo.aside.y, geo.tasks.y) + 1 && Math.abs(geo.aside.y - geo.tasks.y) < 4);
      L("desktop: a sáv tapad (sticky)", geo.pos === "sticky", geo.pos);
      await checkPage(pageA, "desktop", "céges adatlap");

      // ============ D) Szerkesztés a sávban ============
      await pageA.locator(`${SIDE} button:has-text("Szerkesztés")`).click();
      L("a szerkesztő űrlap a sávban nyílik, nincs duplikált szerkesztő (egy mentés gomb)", (await pageA.locator(`${SIDE} button:has-text("Mentés")`).count()) === 1 && (await pageA.getByRole("button", { name: "Mentés", exact: true }).count()) === 1);
      await pageA.getByLabel(/^Telefonszám/).fill("+36 20 999 8888");
      await pageA.getByLabel(/Beosztás/).fill("ügyvezető");
      await checkPage(pageA, "desktop", "szerkesztés a sávban");
      await pageA.locator(`${SIDE} button:has-text("Mentés")`).click();
      await pageA.waitForSelector(`${SIDE} dd:has-text("+36 20 999 8888")`);
      L("mentés után a sáv a frissített adatot mutatja", (await pageA.locator(SIDE).innerText()).includes("ügyvezető"));
      await pageA.reload({ waitUntil: "networkidle" });
      await pageA.waitForSelector("main h1");
      L("frissítés (reload) után a módosítás megvan: az adat az adatbázisból jön", (await pageA.locator(SIDE).innerText()).includes("+36 20 999 8888"));
      await pageA.locator(`${SIDE} button:has-text("Szerkesztés")`).click();
      await pageA.locator(SIDE).getByLabel(/^E-mail/).fill("nem-email");
      await pageA.locator(`${SIDE} button:has-text("Mentés")`).click();
      L("érvénytelen e-mail: mezőhiba, nincs mentés", await shows(pageA.locator(`${SIDE} >> text=Érvénytelen e-mail-cím`)));
      await pageA.locator(`${SIDE} button:has-text("Mégse")`).click();

      // ============ E) Feladat: Input legördülő ============
      await pageA.click('button:has-text("+ Feladat hozzáadása")');
      const d = dlg(pageA);
      L("új feladat modál: Feladat típusa, Input, Határidő; nincs szabad szöveges Input mező", (await d.getByLabel(/Feladat típusa/).count()) === 1 && (await d.getByLabel(/^Input/).count()) === 1 && (await d.getByLabel(/Határidő/).count()) === 1 && (await d.locator("textarea").count()) === 0);
      L("a feladattípusok az ideiglenes lista szerint", JSON.stringify(await optionTexts(d.getByLabel(/Feladat típusa/))) === JSON.stringify(TYPES));
      L("az Input legördülő lehetőségei az ideiglenes lista szerint", JSON.stringify(await optionTexts(d.getByLabel(/^Input/))) === JSON.stringify(INPUTS));
      L("gombok: „Feladat létrehozása” és „Mégse”", (await d.locator("button[type=submit]").innerText()) === "Feladat létrehozása" && (await d.getByRole("button", { name: "Mégse" }).isVisible()));
      await checkPage(pageA, "desktop", "új feladat modál");
      await d.locator("button[type=submit]").click();
      L("a feladat típusa kötelező", await shows(d.locator("text=A feladat típusának kiválasztása kötelező")));
      await d.getByLabel(/^Input/).selectOption({ label: "Egyéb" });
      L("az „Egyéb” Inputnál rövid, opcionális megjegyzés mező jelenik meg; más értéknél nem", (await d.getByLabel(/Rövid megjegyzés/).isVisible()) && (await (async () => { await d.getByLabel(/^Input/).selectOption({ label: "Visszahívás" }); return d.getByLabel(/Rövid megjegyzés/).count(); })()) === 0);
      await d.getByRole("button", { name: "Mégse" }).click();
      L("„Mégse”: nem jön létre feladat", (await pageA.locator("li[data-task-id]").count()) === 0);
      await addTask(pageA, "Telefonhívás", { input: "Visszahívás", due: dateInput(3) });
      await addTask(pageA, "E-mail");
      await addTask(pageA, "Utánkövetés", { input: "Egyéb", note: "Ajánló szerint" });
      L("három feladat jött létre az aktuális státusz alatt", (await pageA.locator("#feladatok-lista li[data-task-id]").count()) === 3);
      L("a feladat neve a kiválasztott típus neve; az Input a sor második sorában", (await pageA.locator('#feladatok-lista').innerText()).includes("Visszahívás"));
      // ============ M) Közös feladatmodál (CRM-007) ============
      const tr = () => taskRow(pageA, "Telefonhívás");
      const tid = await tr().getAttribute("data-task-id");
      L("R1/M2: a feladatsorban nincs checkbox és nincs lenyíló panel (nincs Output-mező, dátummező a sorban)", (await pageA.getByRole("checkbox").count()) === 0 && (await pageA.locator("#feladatok-lista li[data-task-id] textarea, #feladatok-lista li[data-task-id] input[type=date]").count()) === 0);
      let md = await openTask(tr(), "details");
      L("M1: a „Részletek” gomb valódi modális dialógust nyit, címkézve", (await dlg(pageA).count()) === 1 && (await md.getAttribute("aria-label")) === "Feladat részletei" && (await pageA.evaluate(() => document.querySelector("dialog[open]").matches(":modal"))));
      const mtext = await md.innerText();
      L("M: a modál tartalma: feladat neve, kapcsolódó ügyfél, állapot, státusz, Input, határidő, üres Output", ["Telefonhívás", "Minta Kft.", "Nyitott", "Feldolgozásra vár", "Visszahívás", "Határidő módosítása", "Output"].every((x) => mtext.includes(x)) && (await md.locator("textarea").inputValue()) === "", mtext);
      for (let i = 0; i < 14; i++) await pageA.keyboard.press("Tab");
      L("M10: fókuszcsapda - Tab-bal a fókusz nem kerül a dialóguson kívüli elemre", await pageA.evaluate(() => { const a = document.activeElement; return a === document.body || !!a?.closest("dialog[open]"); }));
      await pageA.keyboard.press("Escape");
      await dlg(pageA).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      L("M9/M10: Escape bezárja; a fókusz visszakerül a megnyitó „Részletek” gombra", (await dlg(pageA).count()) === 0 && (await pageA.evaluate(() => document.activeElement?.textContent?.startsWith("Részletek"))));
      md = await openTask(taskRow(pageA, "Utánkövetés"));
      L("M3: a feladat nevére kattintva ugyanez a modál nyílik; az „Egyéb” Input megjegyzése látszik", (await md.innerText()).includes("Egyéb — Ajánló szerint"));
      await closeDialog(pageA);

      // ============ F) Lezárás: Sikeres / Sikertelen + kötelező Output (CRM-001/002) és következő feladat (CRM-009) ============
      md = await openTask(tr());
      const okBtn = () => md.getByRole("button", { name: "Sikeres lezárás", exact: true });
      const koBtn = () => md.getByRole("button", { name: "Sikertelen lezárás", exact: true });
      const outBox = () => md.getByLabel(/^Output/);
      L("A3/R2: a Sikeres és a Sikertelen gomb látható; nincs harmadik, általános lezáró gomb és nincs Output legördülő", (await okBtn().isVisible()) && (await koBtn().isVisible()) && (await okBtn().evaluate((b) => b.firstChild.textContent.trim())) === "Sikeres" && (await koBtn().evaluate((b) => b.firstChild.textContent.trim())) === "Sikertelen" && (await md.getByRole("button", { name: /^Feladat lezárása/ }).count()) === 0 && (await md.locator("select").count()) === 0);
      L("CRM-002: az Output több soros, címkézett, kötelező szövegmező; a lezáró gombok csoportja címkézett", (await outBox().evaluate((el) => el.tagName)) === "TEXTAREA" && (await outBox().getAttribute("aria-required")) === "true" && (await md.getByRole("group", { name: "Feladat lezárása" }).count()) === 1);
      const order = await md.evaluate((root) => {
        const y = (el) => (el ? el.getBoundingClientRect().y : -1);
        const dt = (t) => [...root.querySelectorAll("dt")].find((x) => x.textContent.trim() === t);
        return { name: y(dt("Feladat")), customer: y(dt("Ügyfél")), input: y(dt("Input")), due: y(root.querySelector("input[type=date]")), output: y(root.querySelector("textarea")), buttons: y([...root.querySelectorAll("button")].find((b) => b.textContent.trim() === "Sikeres lezárás")) };
      });
      L("a modál sorrendje: feladat neve, ügyfél, Input, határidő-módosítás, Output, Sikeres/Sikertelen", order.name >= 0 && order.name < order.customer && order.customer < order.input && order.input < order.due && order.due < order.output && order.output < order.buttons, JSON.stringify(order));
      await checkPage(pageA, "desktop", "feladatmodál (nyitott)");
      const apiSnap = async (p = pageA) => (await (await p.request.get(BASE + "/api/crm/snapshot")).json()).snapshot;
      const apiTask = async (id, p = pageA) => (await apiSnap(p)).tasks.find((t) => t.id === id);
      const before = await statusSelect(pageA).inputValue();
      const taskCount0 = (await apiSnap()).tasks.length;
      await okBtn().click();
      L("A4/R3: üres Outputtal a Sikeres gomb nem zár le: magyar hibaüzenet", await shows(md.locator("text=A feladat lezárásához az Output kitöltése kötelező.")));
      L("A4: a hiba után a fókusz az Output mezőn", (await pageA.evaluate(() => document.activeElement?.tagName)) === "TEXTAREA");
      await koBtn().click();
      L("A4: üres Outputtal a Sikertelen gomb sem zár le", (await shows(md.locator("text=A feladat lezárásához az Output kitöltése kötelező."))) && (await apiTask(tid)).status === "open");
      await outBox().fill("   \n\t   \n");
      await koBtn().click();
      await okBtn().click();
      L("A5: csak whitespace Output nem fogadható el", (await shows(md.locator("text=A feladat lezárásához az Output kitöltése kötelező."))) && (await apiTask(tid)).status === "open" && (await apiTask(tid)).outputs === undefined);
      const TEXT_FAIL = "Az ügyfelet három próbálkozás után\nsem sikerült elérni.";
      await outBox().fill(TEXT_FAIL);
      await pageA.route("**/api/crm/op", (route) => route.abort("connectionrefused"));
      await koBtn().click();
      await md.locator("[role=alert]").filter({ hasText: "A mentés nem sikerült" }).waitFor({ timeout: 8000 }).catch(() => {});
      L("sikertelen mentés: érthető hibaüzenet, a beírt Output megmarad, a feladat nyitott, a modál nyitva", (await md.locator("[role=alert]").filter({ hasText: "A mentés nem sikerült" }).count()) === 1 && (await outBox().inputValue()) === TEXT_FAIL);
      await pageA.unroute("**/api/crm/op");
      L("sikertelen mentés után az adatbázisban nincs lezárás", (await apiTask(tid)).status === "open");
      await koBtn().click();
      await md.getByText("Szeretnél következő feladatot létrehozni?").waitFor({ timeout: 8000 }).catch(() => {});
      L("F2: sikertelen lezárás után ugyanabban a modálban felajánlja a következő feladatot (Új feladat / Most nem)", (await md.getByText("Feladat lezárva — Sikertelen.").count()) === 1 && (await md.getByRole("button", { name: "Új feladat létrehozása" }).isVisible()) && (await md.getByRole("button", { name: "Most nem" }).isVisible()) && (await dlg(pageA).count()) === 1);
      L("A7: kitöltött Output + Sikertelen: sikertelen lezárás", (await apiTask(tid)).status === "done" && (await apiTask(tid)).outputs.at(-1).outcome === "failure");
      L("A8: a lezárás nem módosítja az ügyfél státuszát", (await statusSelect(pageA).inputValue()) === before && (await apiSnap()).customers.find((c) => c.companyName === "Minta Kft.").crmStatus === before);
      L("F8: a következő feladat nem jön létre automatikusan", (await apiSnap()).tasks.length === taskCount0);
      await checkPage(pageA, "desktop", "feladatmodál (következő lépés)");
      await md.getByRole("button", { name: "Most nem" }).click();
      await dlg(pageA).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      L("F3: „Most nem”: a modál bezárul, visszatér a listához, új feladat nem jön létre", (await dlg(pageA).count()) === 0 && (await apiSnap()).tasks.length === taskCount0 && (await tr().innerText()).includes("Lezárva — Sikertelen"));
      md = await openTask(tr());
      let mt = await md.innerText();
      L("lezárt feladat a modálban: minősítés, Output (sortöréssel), lezárás időpontja, rögzítő", mt.includes("Lezárva — Sikertelen") && mt.includes("Az ügyfelet három próbálkozás után\nsem sikerült elérni.") && mt.includes("Rögzítette: Teszt Pilot Egy") && mt.includes("Lezárás időpontja"), mt);
      L("lezárt feladatnál nincs Output-mező és lezáró gomb; az újranyitás elérhető", (await md.locator("textarea").count()) === 0 && (await okBtn().count()) === 0 && (await md.getByRole("button", { name: "Feladat újranyitása" }).isVisible()));
      await checkPage(pageA, "desktop", "feladatmodál (lezárt)");
      await md.getByRole("button", { name: "Feladat újranyitása" }).click();
      await until(async () => (await md.locator("textarea").count()) === 1);
      mt = await md.innerText();
      L("M8/R5: újranyitás a modálban: a feladat nyitott, az előző lezárás eredménye és Outputja megmaradt", (await apiTask(tid)).status === "open" && mt.includes("Korábbi lezárások (1)") && mt.includes("sem sikerült elérni."), mt);
      const TEXT_OK = "Telefonon egyeztettünk, az ügyfél érdeklődik a\nszolgáltatás iránt. Csütörtökön ismét keresni kell.";
      await outBox().fill(TEXT_OK);
      await okBtn().dblclick();
      await md.getByText("Szeretnél következő feladatot létrehozni?").waitFor({ timeout: 8000 }).catch(() => {});
      await settle(pageA);
      const closed = await apiTask(tid);
      const closeActs = (await apiSnap()).activities.filter((a) => a.type === "task_completed" && a.meta && a.meta.taskId === tid);
      L("F1: sikeres lezárás után is felajánlja a következő feladatot", (await md.getByText("Feladat lezárva — Sikeres.").count()) === 1);
      L("A6 + B5/R4: kitöltött Output + Sikeres: sikeres lezárás; az új eredmény hozzáfűződött, a régi megmaradt", JSON.stringify(closed.outputs.map((o) => [o.outcome, o.text])) === JSON.stringify([["failure", TEXT_FAIL], ["success", TEXT_OK]]), JSON.stringify(closed.outputs));
      L("A9: dupla kattintás egyetlen lezárást és egyetlen naplóbejegyzést hoz létre", closed.outputs.length === 2 && closeActs.length === 2);
      await md.getByRole("button", { name: "Új feladat létrehozása" }).click();
      await md.getByRole("heading", { name: "Következő feladat" }).waitFor({ timeout: 5000 }).catch(() => {});
      mt = await md.innerText();
      L("F4: a következő feladat űrlapja ugyanabban a modálban: az ügyfél előre kitöltve és csak olvasható, a felelős a bejelentkezett munkatárs", (await dlg(pageA).count()) === 1 && mt.includes("Ügyfél") && mt.includes("Minta Kft.") && mt.includes("Teszt Pilot Egy (bejelentkezett munkatárs)") && (await md.getByLabel(/^Ügyfél/).count()) === 0);
      L("F5-F7: feladattípus (meglévő lista), Input és határidő megadható", JSON.stringify(await optionTexts(md.getByLabel(/Feladat típusa/))) === JSON.stringify(TYPES) && JSON.stringify(await optionTexts(md.getByLabel(/^Input/))) === JSON.stringify(INPUTS) && (await md.getByLabel(/Határidő/).count()) === 1);
      L("az Output szövege nem kerül automatikusan az új feladatba", !(await md.innerText()).includes("Csütörtökön ismét keresni kell"));
      await md.getByLabel(/Feladat típusa/).selectOption({ label: "Egyéb" });
      await md.getByLabel(/^Input/).selectOption({ label: "Visszahívás" });
      await md.getByLabel(/Határidő/).fill(dateInput(2));
      await pageA.route("**/api/crm/op", (route) => route.abort("connectionrefused"));
      await md.locator("button[type=submit]").click();
      await md.locator("[role=alert]").filter({ hasText: "A mentés nem sikerült" }).waitFor({ timeout: 8000 }).catch(() => {});
      L("F9: az új feladat mentési hibája: érthető hiba, a beírt adatok megmaradnak, a korábbi lezárás megmarad", (await md.locator("[role=alert]").filter({ hasText: "A mentés nem sikerült" }).count()) === 1 && (await md.getByLabel(/Feladat típusa/).inputValue()) === "other" && (await md.getByLabel(/Határidő/).inputValue()) === dateInput(2) && (await apiTask(tid)).status === "done" && (await apiTask(tid)).outputs.length === 2);
      await pageA.unroute("**/api/crm/op");
      await md.locator("button[type=submit]").click();
      await md.getByText("Az új feladat létrehozva").waitFor({ timeout: 8000 }).catch(() => {});
      const created = (await apiSnap()).tasks.filter((t) => t.title === "Egyéb");
      const cust = (await apiSnap()).customers.find((c) => c.companyName === "Minta Kft.");
      L("F: egyértelmű visszajelzés az új feladat mentéséről", (await md.getByRole("status").filter({ hasText: "Az új feladat létrehozva: Egyéb" }).count()) === 1);
      L("F4/F8: pontosan egy új, nyitott feladat ugyanahhoz az ügyfélhez, a választott adatokkal; az Output nem lett Input; a státusz nem változott", created.length === 1 && created[0].customerId === cust.id && created[0].status === "open" && created[0].inputKey === "callback" && created[0].description === undefined && created[0].dueAt === noonIso(dateInput(2)) && cust.crmStatus === before);
      await md.getByRole("button", { name: "Vissza a listához" }).click();
      await dlg(pageA).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      L("F10: az új feladat megjelenik az ügyfél feladatlistájában", (await taskRow(pageA, "Egyéb").count()) === 1);
      L("F11: az új feladat létrehozása az előzményekben", (await pageA.locator("#elozmenyek").innerText()).includes("Feladat létrehozva\nFeladat:") || (await pageA.locator("#elozmenyek li", { hasText: "Feladat létrehozva" }).filter({ hasText: "Egyéb" }).count()) === 1);
      await pageA.reload({ waitUntil: "networkidle" });
      await pageA.waitForSelector("#feladatok-lista");
      md = await openTask(tr());
      mt = await md.innerText();
      L("B1/B2: frissítés után az Output és a lezárás minősítése megmarad", mt.includes("Lezárva — Sikeres") && mt.includes("szolgáltatás iránt. Csütörtökön ismét keresni kell.") && mt.includes("Korábbi lezárások (1)") && mt.includes("Lezárva — Sikertelen"), mt);
      await closeDialog(pageA);
      // A10: a szerver az érvénytelen lezárási kéréseket is elutasítja (a felület megkerülésével küldve).
      const emailId = await taskRow(pageA, "E-mail").getAttribute("data-task-id");
      const rawClose = (input) => pageA.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: randomUUID(), op: "task.close", args: { taskId: emailId, input } } });
      const res = [];
      for (const input of [{ outcome: "success", output: "" }, { outcome: "failure", output: "  \n  " }, { output: "Szöveg minősítés nélkül" }, { outcome: "kiváló", output: "x" }]) res.push((await (await rawClose(input)).json()).result.ok);
      const legacyShape = await rawClose({ outputKey: "completed" });
      L("A10: a szerver elutasítja az üres/whitespace Outputot, a hiányzó/érvénytelen minősítést és a régi legördülős alakot", res.every((x) => x === false) && legacyShape.status() === 400 && (await apiTask(emailId)).status === "open", JSON.stringify(res));

      // ============ C) Átidőzítés (CRM-003) - a modálban ============
      const er = () => taskRow(pageA, "E-mail");
      md = await openTask(er());
      const dueBox = () => md.getByLabel("Határidő módosítása");
      const saveDue = () => md.getByRole("button", { name: "Határidő mentése" });
      await dueBox().fill(dateInput(5));
      L("C: a dátum kiválasztása önmagában nem ment; külön „Határidő mentése” gomb van", (await saveDue().isEnabled()) && (await apiTask(emailId)).dueAt === undefined);
      await saveDue().click();
      await md.getByRole("status").filter({ hasText: "Az új határidő elmentve." }).waitFor({ timeout: 8000 }).catch(() => {});
      L("C1/M4/R6: új határidő megadható és mentődik az adatbázisba (budapesti nap déli 12:00)", (await apiTask(emailId)).dueAt === noonIso(dateInput(5)) && (await md.innerText()).includes(huDate(dateInput(5))));
      L("C2: az átidőzítés után a feladat nyitott marad (nem minősül lezárásnak)", (await apiTask(emailId)).status === "open" && (await apiTask(emailId)).outputs === undefined && (await md.locator("textarea").count()) === 1);
      await pageA.route("**/api/crm/op", (route) => route.abort("connectionrefused"));
      await dueBox().fill(dateInput(6));
      await saveDue().click();
      await md.locator("[role=alert]").filter({ hasText: "A mentés nem sikerült" }).waitFor({ timeout: 8000 }).catch(() => {});
      L("sikertelen átidőzítés: hibaüzenet, a beírt dátum megmarad, a mentett határidő nem változik", (await md.locator("[role=alert]").filter({ hasText: "A mentés nem sikerült" }).count()) === 1 && (await dueBox().inputValue()) === dateInput(6) && (await apiTask(emailId)).dueAt === noonIso(dateInput(5)));
      await pageA.unroute("**/api/crm/op");
      await dueBox().fill(dateInput(0));
      await saveDue().click();
      await md.getByRole("status").filter({ hasText: "Az új határidő elmentve." }).waitFor({ timeout: 8000 }).catch(() => {});
      await closeDialog(pageA);
      await pageA.reload({ waitUntil: "networkidle" });
      await pageA.waitForSelector("#feladatok-lista");
      const todayLabel = huDate(dateInput(0));
      L("C5: a módosított dátum újratöltés után is megmarad", (await er().innerText()).includes(`Határidő: ${todayLabel}`), todayLabel);
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      await pageA.locator("#mai-feladataim").getByRole("button", { name: /^Ma esedékes/ }).click();
      L("C3: az Áttekintés „Mai feladataim” listája a módosított határidőt mutatja", (await pageA.locator("#mai-feladataim li[data-task-id]", { hasText: "E-mail" }).filter({ hasText: "Minta Kft." }).count()) === 1);
      await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      L("C3: a Pipeline-kártya a módosított határidőt mutatja", (await pageA.locator("article", { hasText: "Minta Kft." }).innerText()).includes(`E-mail · ${todayLabel}`));
      await openCustomer(pageA, "Minta Kft.");

      // ============ D) Előzmények (CRM-004) ============
      const hist = pageA.locator("#elozmenyek");
      L("D1: a blokk címe pontosan „Előzmények”; a régi „Napló és korábbi adatok” panel nincs", /^Előzmények\s*\(\d+\)$/.test((await hist.locator("h2").first().innerText()).trim()) && (await pageA.locator("text=Napló és korábbi adatok").count()) === 0);
      L("D3: nem lenyitható panel, alapból látható", (await hist.isVisible()) && (await hist.locator("details, summary").count()) === 0 && (await hist.locator("ol > li").first().isVisible()));
      const ys = await pageA.evaluate(() => Object.fromEntries(["#feladatok-lista", "#korabbi-feladatok", "#elozmenyek", "#jegyzetek"].map((s) => [s, document.querySelector(s)?.getBoundingClientRect().y ?? null])));
      L("D2: sorrend: Feladatok, (Korábbi státuszok feladatai), Előzmények, Ügyféljegyzetek", ys["#feladatok-lista"] < ys["#elozmenyek"] && ys["#elozmenyek"] < ys["#jegyzetek"] && (ys["#korabbi-feladatok"] === null || ys["#korabbi-feladatok"] < ys["#elozmenyek"]), JSON.stringify(ys));
      const ht = await hist.innerText();
      L("D4: sikeres lezárás Outputtal", ht.includes("Feladat lezárva — Sikeres") && ht.includes("szolgáltatás iránt. Csütörtökön ismét keresni kell."));
      L("D5: sikertelen lezárás Outputtal", ht.includes("Feladat lezárva — Sikertelen") && ht.includes("sem sikerült elérni."));
      L("D6: átidőzítés a korábbi és az új határidővel, a rögzítővel", ht.includes("Feladat átidőzítve") && ht.includes("Korábbi határidő:") && new RegExp(`Új határidő:\\s*${todayLabel.replace(/\./g, "\\.")}`).test(ht) && ht.includes("Rögzítette: Teszt Pilot Egy"));
      L("újranyitás és feladat-létrehozás is az előzményekben", ht.includes("Feladat újranyitva") && ht.includes("Feladat létrehozva"));
      const times = await hist.locator("ol > li time").evaluateAll((els) => els.map((e) => Date.parse(e.getAttribute("datetime"))));
      L("időrendi lista: a legfrissebb esemény elöl", times.length > 3 && times.every((t, i) => i === 0 || times[i - 1] >= t));
      const titles = await hist.locator("ol > li h3").allTextContents();
      const count = (t) => titles.filter((x) => x.trim() === t).length;
      const custId = pageA.url().split("/").pop();
      const acts = (await apiSnap()).activities.filter((a) => a.customerId === custId && a.type !== "note");
      L("D8: nincs duplikált esemény: egy-egy lezárási bejegyzés, a lista hossza = a naplózott események száma", count("Feladat lezárva — Sikeres") === 1 && count("Feladat lezárva — Sikertelen") === 1 && count("Feladat átidőzítve") === 2 && titles.length === acts.length, JSON.stringify(titles));
      await checkPage(pageA, "desktop", "előzmények");

      // ============ G) Státuszváltás, korábbi feladatok, pipeline ============
      await statusSelect(pageA).selectOption({ label: "Kapcsolatfelvétel" });
      await until(async () => /— Kapcsolatfelvétel\s*\(/.test(await pageA.locator("#feladatok-lista h2").innerText()));
      L("státuszváltás után az aktuális státusz feladatai üresek, a korábbiak megmaradtak", (await pageA.locator("#feladatok-lista").innerText()).includes("Ennél a státusznál még nincs feladat") && (await pageA.locator("#korabbi-feladatok").innerText()).includes("Telefonhívás"));
      await addTask(pageA, "Online tárgyalás", { input: "Időpont-egyeztetés" });
      L("az új feladat az új státuszhoz kapcsolódik", (await pageA.locator("#feladatok-lista li[data-task-id]").count()) === 1);
      await statusSelect(pageA).selectOption({ label: "Tőke elhelyezve" });
      L("„Tőke elhelyezve”: igazolási párbeszéd nyílik, a státusz még nem változik", (await dlg(pageA).locator("legend:has-text('Igazolás')").isVisible()) && (await statusSelect(pageA).inputValue()) !== "capital_placed");
      await dlg(pageA).locator("button[type=submit]").click();
      L("igazolás nélkül a „Tőke elhelyezve” nem rögzíthető", await shows(dlg(pageA).locator("[role=alert]")));
      await dlg(pageA).getByRole("button", { name: "Mégse" }).click();
      L("a státusz mentése után a pipeline-on egyetlen kártya, a megfelelő oszlopban", await (async () => {
        await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
        const labels = await pageA.locator("section[aria-label] h3").allTextContents();
        return JSON.stringify(labels.map((t) => t.trim())) === JSON.stringify(STATUSES) && (await pageA.locator("article:has-text('Minta Kft.')").count()) === 1 && (await col(pageA, "Kapcsolatfelvétel").locator("article:has-text('Minta Kft.')").count()) === 1 && (await col(pageA, "Feldolgozásra vár").locator("article:has-text('Minta Mária')").count()) === 1;
      })());
      await checkPage(pageA, "desktop", "pipeline");
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      await checkPage(pageA, "desktop", "áttekintés adattal");
      await pageA.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("ügyféllista: két ügyfél", (await pageA.locator("main a[href^='/customers/cust-']").count()) >= 2);
      await checkPage(pageA, "desktop", "ügyféllista");

      // ============ H) Billentyűzet ============
      await openCustomer(pageA, "Minta Mária");
      await pageA.locator('button:has-text("+ Feladat hozzáadása")').focus();
      await pageA.keyboard.press("Enter");
      L("billentyűzet: a feladat-modál Enterrel megnyílik", await dlg(pageA).isVisible());
      await pageA.keyboard.press("Escape");
      await settle(pageA);
      L("billentyűzet: az Esc bezárja a modált, nem jön létre feladat", (await dlg(pageA).count()) === 0 && (await pageA.locator("#feladatok-lista li[data-task-id]").count()) === 0);
      await statusSelect(pageA).focus();
      L("billentyűzet: a státuszválasztó fókuszálható és címkézett", (await pageA.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Kapcsolati státusz");

      // ============ S) Globális kereső a fejlécben (CRM-005) ============
      const search = (p) => p.getByRole("combobox", { name: "Ügyfél keresése" });
      // A látható kereső a közös fejlécben van (desktopon a fejlécsávban, mobilon/tableten a ragadós felső sávban), a fő tartalom felett.
      const inHeader = (p) => p.evaluate(() => {
        const el = [...document.querySelectorAll('[role="combobox"]')].find((x) => x.getClientRects().length > 0);
        const main = document.querySelector("main");
        return !!el && !el.closest("main") && el.getBoundingClientRect().bottom <= main.getBoundingClientRect().top + 1;
      });
      for (const [href, label] of [["/", "Áttekintés"], ["/pipeline", "Pipeline"], ["/customers", "Ügyfelek"]]) {
        await pageA.goto(BASE + href, { waitUntil: "networkidle" });
        L(`E1: a kereső a közös fejlécben van (${label})`, (await search(pageA).isVisible()) && (await inHeader(pageA)));
      }
      await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      L("a Pipeline-ban nincs külön keresőmező; az oszlopok és kártyák változatlanok", (await pageA.locator("main input[type=search]").count()) === 0 && (await pageA.locator("section[aria-label] h3").count()) === 7 && (await pageA.locator("main article").count()) === 2);
      await search(pageA).fill("minta");
      const opts = pageA.getByRole("option");
      await opts.first().waitFor({ timeout: 5000 }).catch(() => {});
      const optTexts = await opts.allInnerTexts();
      L("a találatok egyértelműen azonosíthatók (név, típus, státusz, elérhetőség); ékezet- és kisbetű-független", optTexts.length === 2 && optTexts[0].startsWith("Minta Kft.") && optTexts[0].includes("Cég ·") && optTexts[0].includes("+36 20 999 8888") && optTexts[1].startsWith("Minta Mária") && optTexts[1].includes("Magánszemély"), JSON.stringify(optTexts));
      L("combobox: aria-expanded=true nyitott listánál", (await search(pageA).getAttribute("aria-expanded")) === "true");
      await checkPage(pageA, "desktop", "globális kereső találatokkal");
      await search(pageA).press("ArrowDown");
      await search(pageA).press("ArrowDown");
      L("E7: a nyilakkal kijelölhető találat (aria-activedescendant)", (await pageA.getByRole("option", { selected: true }).innerText()).startsWith("Minta Mária"));
      await search(pageA).press("Enter");
      await pageA.waitForURL("**/customers/cust-*");
      await pageA.waitForSelector("main h1:has-text('Minta Mária')");
      L("E3 + E7: Pipeline oldalról, billentyűzettel (Le, Enter) a megfelelő ügyféladatlap nyílik", (await pageA.locator("main h1").innerText()) === "Minta Mária" && (await search(pageA).inputValue()) === "");
      L("E5: az ügyféladatlapon is elérhető a kereső", (await search(pageA).isVisible()) && (await inHeader(pageA)));
      await search(pageA).fill("kft");
      await opts.first().waitFor({ timeout: 5000 }).catch(() => {});
      await search(pageA).press("Enter");
      await pageA.waitForSelector("main h1:has-text('Minta Kft.')");
      L("E5: ügyféladatlapról egyetlen találatra Enterrel átnavigál", (await pageA.locator("main h1").innerText()) === "Minta Kft.");
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      await search(pageA).fill("Kovács");
      await opts.first().waitFor({ timeout: 5000 }).catch(() => {});
      const viaContact = await opts.first().innerText();
      L("kapcsolati személyre is keres: a cég jelenik meg, a kapcsolati személy feltüntetve", viaContact.startsWith("Minta Kft.") && viaContact.includes("Kapcsolati személy: Kovács Anna"), viaContact);
      await opts.first().click();
      await pageA.waitForSelector("main h1:has-text('Minta Kft.')");
      L("E2 + E6: az Áttekintésről kattintással a megfelelő ügyféladatlap nyílik", pageA.url().includes("/customers/cust-") && (await pageA.locator("main h1").innerText()) === "Minta Kft.");
      await pageA.goto(BASE + "/customers", { waitUntil: "networkidle" });
      await search(pageA).fill("nincs ilyen ügyfél");
      L("E4: az Ügyfelek oldalon használható; nincs találat: magyar üres állapot", await shows(pageA.locator("header >> text=Nincs a keresésnek megfelelő ügyfél.")));
      await search(pageA).fill("minta");
      await opts.first().waitFor({ timeout: 5000 }).catch(() => {});
      await search(pageA).press("Escape");
      L("E7: Escape bezárja a találati listát", (await search(pageA).getAttribute("aria-expanded")) === "false" && !(await opts.first().isVisible()));
      await search(pageA).press("Escape");
      L("második Escape törli a keresőmezőt", (await search(pageA).inputValue()) === "");
      await search(pageA).focus();
      await pageA.keyboard.press("Shift+Tab");
      L("billentyűzet: a kereső Tab-bal elérhető és elhagyható, látható fókusszal", (await pageA.evaluate(() => document.activeElement?.getAttribute("role"))) !== "combobox");
      await pageA.keyboard.press("Tab");
      const focusStyle = await pageA.evaluate(() => { const el = document.activeElement; return el?.getAttribute("role") === "combobox" ? getComputedStyle(el).outlineStyle : "none"; });
      L("látható fókusz a keresőn", focusStyle !== "none", focusStyle);

      // ============ K) Keresés telefonszámra és e-mailre (CRM-012) ============
      const firstHit = async (q) => { await search(pageA).fill(q); await opts.first().waitFor({ timeout: 5000 }).catch(() => {}); return (await opts.allInnerTexts()); };
      await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      for (const q of ["+36 20 999 8888", "36209998888", "06 20 999 8888", "(20) 999-8888"]) {
        const h = await firstHit(q);
        L(`K4/K6/K7: telefonszámra (${q}) a megfelelő ügyfél, egyezés-indoklással`, h.length === 1 && h[0].startsWith("Minta Kft.") && h[0].includes("Egyezés — Telefonszám: +36 20 999 8888"), JSON.stringify(h));
      }
      const he = await firstHit("ANNA@Example.TEST");
      L("K5/K8: e-mail-címre kis- és nagybetűtől függetlenül; egy ügyfél csak egyszer (K10)", he.length === 1 && he[0].startsWith("Minta Kft.") && he[0].includes("Egyezés — E-mail: anna@example.test"), JSON.stringify(he));
      await search(pageA).press("ArrowDown");
      await search(pageA).press("Enter");
      await pageA.waitForSelector("main h1:has-text('Minta Kft.')");
      L("K13: e-mail-találat billentyűzettel megnyitható", (await pageA.locator("main h1").innerText()) === "Minta Kft.");

      // ============ Q) Gyorsműveletek az ügyféladatlapon (CRM-011) ============
      const qa = pageA.getByRole("group", { name: "Gyorsműveletek" });
      const callLink = qa.getByRole("link", { name: /^Hívás/ });
      const mailLink = qa.getByRole("link", { name: /^E-mail/ });
      L("G1-G3: Hívás, E-mail és Új feladat gomb az ügyfél fejlécében", (await qa.isVisible()) && (await pageA.locator("#ugyfel").getByRole("group", { name: "Gyorsműveletek" }).count()) === 1 && (await callLink.isVisible()) && (await mailLink.isVisible()) && (await qa.getByRole("button", { name: "Új feladat" }).isVisible()));
      L("G4/G5: szabványos tel: és mailto: hivatkozás a kapcsolati adatokból", (await callLink.getAttribute("href")) === "tel:+36209998888" && (await mailLink.getAttribute("href")) === "mailto:anna@example.test");
      L("CRM-006/D1: kikapcsolt kapcsolónál nincs „Ügyfél törlése” a felületen", (await pageA.locator("#ugyfel-torlese").count()) === 0 && (await pageA.getByRole("button", { name: "Ügyfél törlése" }).count()) === 0);
      const actsBefore = (await apiSnap()).activities.length;
      await qa.getByRole("button", { name: "Új feladat" }).click();
      L("G9: az „Új feladat” a meglévő feladatfelviteli modált nyitja, az ügyfél előre kiválasztva", (await dlg(pageA).getByRole("heading", { name: "Új feladat" }).isVisible()) && (await dlg(pageA).innerText()).includes("Minta Kft.") && (await dlg(pageA).getByLabel(/Feladat típusa/).count()) === 1);
      await dlg(pageA).getByRole("button", { name: "Mégse" }).click();
      L("G8: a gyorsműveletek használata nem hoz létre naplóbejegyzést (nincs kitalált kapcsolatfelvétel)", (await apiSnap()).activities.length === actsBefore);
      await checkPage(pageA, "desktop", "ügyféladatlap gyorsműveletekkel");

      // ============ T) Mai feladataim (CRM-010) - külön fiktív ügyféllel ============
      await newCustomer(pageA, { name: "Napi Nándor" });
      const napiId = pageA.url().split("/").pop();
      L("G6: hiányzó telefonszám/e-mail: a művelet nem indul, érthető jelzés", (await qa.getByRole("button", { name: "Hívás" }).isDisabled()) && (await qa.innerText()).includes("Nincs megadva telefonszám.") && (await qa.innerText()).includes("Nincs megadva e-mail-cím.") && (await qa.getByRole("link").count()) === 0);
      const apiCreate = async (p, input) => (await (await p.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: randomUUID(), op: "task.create", args: { input } } })).json()).result.value;
      const t3 = await apiCreate(pageA, { customerId: napiId, taskType: "phone_call", dueAt: noonIso(dateInput(-3)) });
      const t1 = await apiCreate(pageA, { customerId: napiId, taskType: "email", dueAt: noonIso(dateInput(-1)) });
      await apiCreate(pageA, { customerId: napiId, taskType: "online_meeting", dueAt: noonIso(dateInput(0)) });
      await apiCreate(pageA, { customerId: napiId, taskType: "follow_up", dueAt: noonIso(dateInput(4)) });
      await apiCreate(pageA, { customerId: napiId, taskType: "follow_up", dueAt: noonIso(dateInput(9)) });
      await apiCreate(pageA, { customerId: napiId, taskType: "other" });
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      const mf = pageA.locator("#mai-feladataim");
      const napiRows = () => mf.locator("li[data-task-id]", { hasText: "Napi Nándor" });
      const filter = (name) => mf.getByRole("button", { name: new RegExp(`^${name}`) });
      L("N: a „Mai feladataim” blokk az Áttekintésen, alapértelmezetten a saját feladatokkal; lejárt feladat esetén azzal kezd", (await mf.getByRole("heading", { name: "Mai feladataim" }).isVisible()) && (await mf.getByRole("button", { name: "Saját feladataim" }).getAttribute("aria-pressed")) === "true" && (await filter("Lejárt").getAttribute("aria-pressed")) === "true");
      const overdueIds = await napiRows().evaluateAll((els) => els.map((e) => e.getAttribute("data-task-id")));
      L("N2/N7: Lejárt szűrő, a legrégebbi határidő elöl", JSON.stringify(overdueIds) === JSON.stringify([t3.id, t1.id]), JSON.stringify(overdueIds));
      L("N8: a sorban az ügyfél neve, a feladat típusa, a határidő és a lejárt jelzés látszik", (await napiRows().first().innerText()).includes("Telefonhívás") && (await napiRows().first().innerText()).includes(`Határidő: ${huDate(dateInput(-3))}`) && (await napiRows().first().innerText()).includes("Lejárt"));
      await filter("Ma esedékes").click();
      L("N3/N11: Ma esedékes (budapesti nap)", JSON.stringify(await napiRows().allInnerTexts().then((a) => a.map((x) => x.split("\n")[0]))) === JSON.stringify(["Online tárgyalás"]));
      await filter("Következő 7 nap").click();
      L("N4: Következő 7 nap (a 9 nap múlvai nem)", JSON.stringify(await napiRows().allInnerTexts().then((a) => a.map((x) => x.split("\n")[0]))) === JSON.stringify(["Utánkövetés"]));
      await filter("Határidő nélkül").click();
      L("N5: Határidő nélkül", JSON.stringify(await napiRows().allInnerTexts().then((a) => a.map((x) => x.split("\n")[0]))) === JSON.stringify(["Egyéb"]));
      L("N6: lezárt feladat nem szerepel a nyitottak között (a Minta Kft. lezárt Telefonhívása)", (await mf.locator("li[data-task-id]", { hasText: "Minta Kft." }).filter({ hasText: "Telefonhívás" }).count()) === 0);
      await checkPage(pageA, "desktop", "Mai feladataim");
      // N9/N10 + telefonos munkafolyamat: a listából modál, Output, lezárás, következő feladat, vissza a frissült listához.
      await filter("Lejárt").click();
      const overdueBefore = await napiRows().count();
      let dm = await openTask(napiRows().first());
      L("M11/N9: a feladat a napi listából a közös modálban nyílik", (await dm.innerText()).includes("Napi Nándor"));
      await dm.getByLabel(/^Output/).fill("Elértem, jövő héten újra hívom.");
      await dm.getByRole("button", { name: "Sikeres lezárás", exact: true }).click();
      await dm.getByRole("button", { name: "Új feladat létrehozása" }).click();
      await dm.getByLabel(/Feladat típusa/).selectOption({ label: "Telefonhívás" });
      await dm.getByLabel(/^Input/).selectOption({ label: "Visszahívás" });
      await dm.getByLabel(/Határidő/).fill(dateInput(0));
      await dm.locator("button[type=submit]").click();
      await dm.getByText("Az új feladat létrehozva").waitFor({ timeout: 8000 }).catch(() => {});
      await dm.getByRole("button", { name: "Vissza a listához" }).click();
      await dlg(pageA).waitFor({ state: "detached", timeout: 5000 }).catch(() => {});
      await settle(pageA);
      L("N10: mentés után a lista frissül: eggyel kevesebb lejárt feladat, ügyféloldalra navigálás nélkül", (await napiRows().count()) === overdueBefore - 1 && pageA.url() === BASE + "/");
      await filter("Ma esedékes").click();
      L("F10/N10: a létrehozott következő feladat a „Ma esedékes” listában", (await napiRows().filter({ hasText: "Telefonhívás" }).count()) === 1);

      // ============ U) Duplikált ügyfél felismerése (CRM-013) ============
      await pageA.goto(BASE + "/customers/new", { waitUntil: "networkidle" });
      await pageA.getByLabel(/^Név/).fill("Duplikátum Dénes");
      L("U10: egyezés nélküli adatnál nincs figyelmeztetés", (await pageA.locator('[data-testid="duplicate-warning"]').count()) === 0);
      await pageA.getByLabel(/^E-mail/).fill("ANNA@example.test");
      const warn = pageA.locator('[data-testid="duplicate-warning"]');
      L("U1: azonos e-mail-cím: figyelmeztetés már gépelés közben, a meglévő ügyfél nevével, típusával, az egyezés okával", (await shows(warn)) && (await warn.innerText()).includes("Lehetséges, hogy ez az ügyfél már szerepel az adatbázisban.") && (await warn.innerText()).includes("Minta Kft.") && (await warn.innerText()).includes("Cég") && (await warn.innerText()).includes("Erős egyezés") && (await warn.innerText()).includes("Azonos e-mail-cím"));
      await pageA.getByLabel(/^Név/).fill("Mária Minta");
      await pageA.getByLabel(/^E-mail/).fill("");
      L("U3: azonos név (szórendtől függetlenül): lehetséges egyezés", (await warn.innerText()).includes("Minta Mária") && (await warn.innerText()).includes("Lehetséges egyezés"));
      await pageA.getByLabel(/^Név/).fill("Duplikátum Dénes");
      await pageA.getByLabel(/^Telefonszám/).fill("06209998888");
      L("U2: azonos telefonszám más formátumban: erős egyezés", (await warn.innerText()).includes("Azonos telefonszám"));
      const openLink = warn.getByRole("link", { name: /^Meglévő ügyfél megnyitása/ });
      L("U5: a meglévő ügyfél adatlapja megnyitható", (await openLink.getAttribute("href")) === `/customers/${cust.id}`);
      await checkPage(pageA, "desktop", "duplikáció-figyelmeztetés");
      const nCust = (await apiSnap()).customers.length;
      await pageA.getByRole("button", { name: "Ügyfél létrehozása", exact: true }).click();
      L("U6/U9: egyezésnél a mentés nem történik meg döntés nélkül; a felület döntést kér", (await shows(warn.getByRole("alert"))) && pageA.url().endsWith("/customers/new") && (await apiSnap()).customers.length === nCust);
      await warn.getByRole("button", { name: "Mégis új ügyfél létrehozása" }).click();
      await pageA.waitForURL("**/customers/cust-*");
      await pageA.waitForSelector("main h1:has-text('Duplikátum Dénes')");
      const after = await apiSnap();
      L("U6/U12: „Mégis új ügyfél létrehozása”: az új rekord létrejön; a meglévő változatlan (U7/U8)", after.customers.length === nCust + 1 && after.customers.find((c) => c.id === cust.id).phone === "+36 20 999 8888" && after.customers.find((c) => c.id === cust.id).email === "anna@example.test");
      L("CRM-008/S1: az új ügyfél alapértelmezett státusza „Feldolgozásra vár”", (await statusSelect(pageA).locator("option:checked").innerText()) === "Feldolgozásra vár");
    }

    // ============ I) Második pilot felhasználó: közös nézet, azonosítható módosító ============
    const ctxB = await browser.newContext(ctxOpts(DESKTOP));
    const pageB = await ctxB.newPage();
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await login(pageB, EMAIL_B, PW_B);
      await pageB.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("két pilot felhasználó: a másik felhasználó ugyanazt az adatot látja", (await pageB.locator("main a:has-text('Minta Mária')").count()) === 1 && (await pageB.locator("main a:has-text('Minta Kft.')").count()) === 1);
      await openCustomer(pageB, "Minta Kft.");
      await addTask(pageB, "Személyes tárgyalás", { input: "Tájékoztatás" });
      await closeTask(pageB, "Személyes tárgyalás", "success", "Tájékoztatót küldtem.\nKöszönte, átnézi.");
      await pageA.goto(BASE + "/customers", { waitUntil: "networkidle" });
      await openCustomer(pageA, "Minta Kft.");
      const dB = await openTask(taskRow(pageA, "Személyes tárgyalás"));
      const t = await dB.innerText();
      L("az első felhasználó látja a másik módosítását (minősítés, Output), a rögzítő a második felhasználó", t.includes("Lezárva — Sikeres") && t.includes("Tájékoztatót küldtem.") && t.includes("Teszt Pilot Kettő"));
      await closeDialog(pageA);
      // N12: a második munkatárs mai feladata nem jelenik meg az első személyes listájában, csak a csapatnézetben.
      const napi = (await (await pageB.request.get(BASE + "/api/crm/snapshot")).json()).snapshot.customers.find((c) => c.displayName === "Napi Nándor");
      await pageB.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: randomUUID(), op: "task.create", args: { input: { customerId: napi.id, taskType: "in_person_meeting", dueAt: noonIso(dateInput(0)) } } } });
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      const mfA = pageA.locator("#mai-feladataim");
      await mfA.getByRole("button", { name: /^Ma esedékes/ }).click();
      L("N12: más munkatárs feladata nem jelenik meg személyes feladatként", (await mfA.locator("li[data-task-id]", { hasText: "Személyes tárgyalás" }).count()) === 0);
      await mfA.getByRole("button", { name: "Csapat összes feladata" }).click();
      await mfA.getByRole("button", { name: /^Ma esedékes/ }).click();
      L("N: a csapatnézetben a másik munkatárs feladata is látszik", (await mfA.locator("li[data-task-id]", { hasText: "Személyes tárgyalás" }).filter({ hasText: "Napi Nándor" }).count()) === 1);
    }
    // Daily-use notes: saved through the API, visible to the second user after reload.
    await openCustomer(pageA, "Minta Kft.");
    await pageA.getByLabel("Új ügyféljegyzet").fill("Pénteken visszahívást kért.\nA kérdéseit előre elküldi.");
    await pageA.getByRole("button", { name: "Jegyzet mentése" }).click();
    await pageA.getByRole("status").filter({ hasText: "A jegyzet elmentve." }).waitFor();
    await pageA.reload({ waitUntil: "networkidle" });
    log("ügyféljegyzet újratöltés után is megmarad", (await pageA.locator("#jegyzetek").innerText()).includes("Pénteken visszahívást kért."));
    await pageB.reload({ waitUntil: "networkidle" });
    log("a második felhasználó látja a jegyzetet és a rögzítőjét", (await pageB.locator("#jegyzetek").innerText()).includes("Teszt Pilot Egy"));
    await pageA.route("**/api/crm/op", (route) => route.abort("connectionrefused"));
    await pageA.getByLabel("Új ügyféljegyzet").fill("Megőrzött piszkozat");
    await pageA.getByRole("button", { name: "Jegyzet mentése" }).click();
    await pageA.getByRole("alert").filter({ hasText: "A mentés nem sikerült" }).waitFor();
    log("sikertelen jegyzetmentés után a piszkozat megmarad", (await pageA.getByLabel("Új ügyféljegyzet").inputValue()) === "Megőrzött piszkozat");
    await pageA.unroute("**/api/crm/op");
    await pageA.getByRole("button", { name: "Jegyzet mentése" }).click();
    await pageA.getByRole("status").filter({ hasText: "A jegyzet elmentve." }).waitFor();
    await pageA.route("**/api/crm/snapshot", (route) => route.abort("connectionrefused"));
    await pageA.reload({ waitUntil: "networkidle" });
    await pageA.getByRole("button", { name: "Újrapróbálás" }).waitFor();
    log("induláskori adathiba nem hagy végtelen betöltésben", await pageA.getByRole("button", { name: "Újrapróbálás" }).isVisible());
    await pageA.unroute("**/api/crm/snapshot");
    await pageA.getByRole("button", { name: "Újrapróbálás" }).click();
    await pageA.getByLabel("Új ügyféljegyzet").waitFor();
    log("újrapróbálás után visszatér az ügyféladatlap", (await pageA.locator("#jegyzetek").innerText()).includes("Megőrzött piszkozat"));
    await ctxB.close();

    // ============ J) Hibakezelés a felületen ============
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await openCustomer(pageA, "Minta Mária");
      const countTasks = async () => (await pageA.request.get(BASE + "/api/crm/snapshot")).json().then((b) => b.snapshot.tasks.length);
      const baseCount = await countTasks();
      await pageA.route("**/api/crm/op", (route) => route.abort("connectionrefused"));
      await pageA.click('button:has-text("+ Feladat hozzáadása")');
      await dlg(pageA).getByLabel(/Feladat típusa/).selectOption({ label: "Telefonhívás" });
      await dlg(pageA).locator("button[type=submit]").click();
      await pageA.waitForSelector("dialog[open] [role=alert]");
      L("hálózati hiba: egyértelmű hibaüzenet, a modál nyitva marad, az adat nem veszik el az űrlapból", (await dlg(pageA).locator("[role=alert]").innerText()).includes("nem sikerült") && (await dlg(pageA).getByLabel(/Feladat típusa/).inputValue()) === "phone_call");
      await pageA.unroute("**/api/crm/op");
      await pageA.route("**/api/crm/op", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "server_error" }) }));
      await dlg(pageA).locator("button[type=submit]").click();
      await until(async () => (await dlg(pageA).locator("[role=alert]").innerText()).includes("szerver hibát jelzett"));
      L("szerverhiba (500): érthető üzenet, nincs csendes siker", (await dlg(pageA).locator("[role=alert]").innerText()).includes("szerver hibát jelzett") && (await countTasks()) === baseCount);
      await pageA.unroute("**/api/crm/op");
      await dlg(pageA).locator("button[type=submit]").click();
      await dlg(pageA).waitFor({ state: "detached" });
      await settle(pageA);
      L("újrapróbálás után a feladat létrejön, és pontosan egy (nincs duplikátum)", (await countTasks()) === baseCount + 1 && (await pageA.locator("#feladatok-lista li[data-task-id]").count()) === 1);
      // kettős küldés
      await pageA.click('button:has-text("+ Feladat hozzáadása")');
      await dlg(pageA).getByLabel(/Feladat típusa/).selectOption({ label: "E-mail" });
      await dlg(pageA).locator("button[type=submit]").dblclick();
      await dlg(pageA).waitFor({ state: "detached" });
      await settle(pageA);
      L("dupla kattintás nem hoz létre két feladatot", (await countTasks()) === baseCount + 2);
      // munkamenet lejárta
      const keep = await ctxA.cookies();
      await ctxA.clearCookies();
      await pageA.click('button:has-text("+ Feladat hozzáadása")');
      await dlg(pageA).getByLabel(/Feladat típusa/).selectOption({ label: "E-mail" });
      await dlg(pageA).locator("button[type=submit]").click();
      await pageA.waitForSelector("text=Bejelentkezés", { timeout: 8000 }).catch(() => {});
      L("lejárt munkamenet: a felület a belépéshez irányít, az adat nem látszik tovább", (await pageA.getByRole("heading", { name: "Bejelentkezés" }).isVisible()) && (await pageA.locator("h1:has-text('Minta Mária')").count()) === 0);
      await ctxA.addCookies(keep);
    }

    // ============ K) Régi böngészős demóadat: nincs automatikus import, nincs törlés ============
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      const legacy = JSON.stringify({ version: 2, customers: [{ id: "cust-1", type: "individual", firstName: "Régi", lastName: "Böngészős", displayName: "Böngészős Régi", contactStatus: "prospect", ownerId: "user-1", source: "teszt", verificationStatus: "demo", createdAt: new Date().toISOString(), updatedAt: new Date().toISOString() }], contacts: [], processes: [], activities: [], tasks: [], contactability: [] });
      const ctxL = await browser.newContext(ctxOpts(DESKTOP, { acceptDownloads: true }));
      await ctxL.addInitScript((v) => { if (!sessionStorage.getItem("e2e-injected")) { sessionStorage.setItem("jg-os-demo-v0.2", v); sessionStorage.setItem("e2e-injected", "1"); } }, legacy);
      const p = await ctxL.newPage();
      await login(p, EMAIL_A, PW_A);
      await p.waitForSelector('[data-testid="legacy-notice"]');
      L("régi böngészős adat: figyelmeztetés az exportlehetőséggel", /1 ügyfél/.test(await p.locator('[data-testid="legacy-notice"]').innerText()));
      await p.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("a régi böngészős ügyfél NEM került automatikusan az adatbázisba", (await p.locator("main a:has-text('Böngészős Régi')").count()) === 0 && !JSON.stringify((await (await p.request.get(BASE + "/api/crm/snapshot")).json()).snapshot.customers).includes("Böngészős"));
      L("a régi böngészős adat nem törlődött automatikusan", (await p.evaluate(() => sessionStorage.getItem("jg-os-demo-v0.2"))) === legacy);
      const [dl] = await Promise.all([p.waitForEvent("download"), p.getByRole("button", { name: /Export \(JSON\)/ }).first().click()]);
      L("a régi böngészős adat JSON-ba exportálható, tartalma azonos", fs.readFileSync(await dl.path(), "utf8") === legacy);
      await checkPage(p, "desktop", "régi adat értesítés");
      await ctxL.close();
    }

    // ============ L) Mobil nézet ============
    {
      const ctxM = await browser.newContext(ctxOpts(MOBILE));
      const m = await ctxM.newPage();
      const L = (n, ok, e) => log(`[mobile] ${n}`, ok, e);
      await login(m, EMAIL_A, PW_A);
      await checkPage(m, "mobile", "áttekintés");
      await openCustomer(m, "Minta Kft.");
      const geo = await m.evaluate(() => {
        const y = (sel) => document.querySelector(sel).getBoundingClientRect().y;
        const x = (sel) => document.querySelector(sel).getBoundingClientRect().x;
        return { h1: y("h1"), status: y('select[aria-label="Kapcsolati státusz"]'), side: y('aside[aria-labelledby="kapcsolati-adatok-cim"]'), tasks: y("#feladatok-lista"), sideX: x('aside[aria-labelledby="kapcsolati-adatok-cim"]'), tasksX: x("#feladatok-lista") };
      });
      L("mobil: egy oszlop, sorrend: név, státusz, kapcsolati adatok, feladatok", geo.h1 < geo.status + 1 && geo.status < geo.side && geo.side < geo.tasks && Math.abs(geo.sideX - geo.tasksX) < 2, JSON.stringify(geo));
      L("mobil: a név mellett/alatt a státusz látszik", await statusSelect(m).isVisible());
      await checkPage(m, "mobile", "céges adatlap");
      await m.locator(`${SIDE} button:has-text("Szerkesztés")`).click();
      await checkPage(m, "mobile", "szerkesztés");
      await m.locator(`${SIDE} button:has-text("Mégse")`).click();
      await m.click('button:has-text("+ Feladat hozzáadása")');
      await checkPage(m, "mobile", "új feladat modál");
      await dlg(m).getByRole("button", { name: "Mégse" }).click();
      const qm = m.getByRole("group", { name: "Gyorsműveletek" });
      const qmBox = await qm.boundingBox();
      L("G: mobilon a gyorsműveletek a képernyőn belül, a név alatt", !!qmBox && qmBox.x >= 0 && qmBox.x + qmBox.width <= 391 && (await qm.getByRole("link", { name: /^Hívás/ }).isVisible()));
      const dmM = await openTask(taskRow(m, "E-mail"));
      const dlgBox = await dmM.boundingBox();
      L("M13: mobilon a feladatmodál a képernyőn belül; Output, Sikeres/Sikertelen és átidőzítés használható", !!dlgBox && dlgBox.x >= 0 && dlgBox.x + dlgBox.width <= 391 && (await dmM.getByLabel(/^Output/).isVisible()) && (await dmM.getByRole("button", { name: "Határidő mentése" }).isVisible()));
      await dmM.getByRole("button", { name: "Sikeres lezárás", exact: true }).scrollIntoViewIfNeeded();
      L("M13: a modál tartalma mobilon görgethető, a lezáró gombok elérhetők", await dmM.getByRole("button", { name: "Sikeres lezárás", exact: true }).isVisible());
      await checkPage(m, "mobile", "feladatmodál");
      await closeDialog(m);
      await m.goto(BASE + "/", { waitUntil: "networkidle" });
      await checkPage(m, "mobile", "Mai feladataim");
      await openCustomer(m, "Minta Kft.");
      await m.locator("#elozmenyek").scrollIntoViewIfNeeded();
      await checkPage(m, "mobile", "előzmények");
      const ms = m.getByRole("combobox", { name: "Ügyfél keresése" });
      await m.locator("#elozmenyek").scrollIntoViewIfNeeded();
      const uncovered = await ms.evaluate((el) => { const b = el.getBoundingClientRect(); return b.top >= 0 && document.elementFromPoint(b.x + b.width / 2, b.y + b.height / 2) === el; });
      L("E8: mobilon a kereső görgetés után is elérhető (ragadós felső sáv), semmi nem takarja", uncovered);
      await ms.fill("Mária");
      await m.getByRole("option").first().waitFor({ timeout: 5000 }).catch(() => {});
      const box = await m.getByRole("option").first().boundingBox();
      L("E8: mobilon a kereső és a találati lista a képernyőn belül marad", !!box && box.x >= 0 && box.x + box.width <= 390 + 1, JSON.stringify(box));
      await checkPage(m, "mobile", "globális kereső");
      await m.getByRole("option").first().click();
      await m.waitForSelector("main h1:has-text('Minta Mária')");
      L("E8: mobilon érintéssel/kattintással a megfelelő ügyféladatlap nyílik", (await m.locator("main h1").innerText()) === "Minta Mária");
      await m.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      await checkPage(m, "mobile", "pipeline");
      await m.goto(BASE + "/customers", { waitUntil: "networkidle" });
      await checkPage(m, "mobile", "ügyféllista");
      await ctxM.close();
    }

    // ============ L2) Tablet (768) és desktop (1280, 1440) ellenőrzés ============
    for (const vp of [{ width: 768, height: 1024, label: "tablet-768" }, { width: 1280, height: 800, label: "desktop-1280" }, { width: 1440, height: 900, label: "desktop-1440" }]) {
      const ctxT = await browser.newContext(ctxOpts({ width: vp.width, height: vp.height }));
      const t = await ctxT.newPage();
      const L = (n, ok, e) => log(`[${vp.label}] ${n}`, ok, e);
      await login(t, EMAIL_A, PW_A);
      await checkPage(t, vp.label, "áttekintés");
      await openCustomer(t, "Minta Kft.");
      await checkPage(t, vp.label, "ügyféladatlap gyorsműveletekkel");
      const dmT = await openTask(taskRow(t, "E-mail"));
      L("a feladatmodál, az Előzmények és a kereső használható", (await dmT.getByRole("button", { name: "Sikertelen lezárás", exact: true }).isVisible()) && (await t.locator("#elozmenyek").count()) === 1 && (await t.getByRole("combobox", { name: "Ügyfél keresése" }).count()) === 1);
      await checkPage(t, vp.label, "feladatmodál");
      await closeDialog(t);
      await t.getByRole("combobox", { name: "Ügyfél keresése" }).fill("minta");
      await t.getByRole("option").first().waitFor({ timeout: 5000 }).catch(() => {});
      await checkPage(t, vp.label, "globális kereső");
      await t.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      await checkPage(t, vp.label, "pipeline");
      await ctxT.close();
    }

    // ============ M) Kijelentkezés ============
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      await pageA.getByRole("button", { name: "Kijelentkezés" }).click();
      await pageA.getByRole("heading", { name: "Bejelentkezés" }).waitFor();
      L("kijelentkezés: a belépési űrlap látszik, az adat nem", (await pageA.locator("text=Minta Mária").count()) === 0);
      L("E9: kijelentkezés után nincs kereső", (await pageA.getByRole("combobox").count()) === 0);
      const after = await pageA.request.get(BASE + "/api/crm/snapshot");
      L("kijelentkezés után az API 401-et ad (a munkamenet a szerveren is megszűnt)", after.status() === 401);
      await pageA.goBack().catch(() => {});
      L("a böngésző „vissza” gombja sem mutat adatot", (await pageA.locator("text=Minta Mária").count()) === 0);
    }
    await ctxA.close();

    // ============ N) Teljes újraindítás: az adat megmarad; meglévő tiltakozási adat megőrzése ============
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      const ctx = await browser.newContext(ctxOpts(DESKTOP));
      const p = await ctx.newPage();
      await login(p, EMAIL_B, PW_B);
      await openCustomer(p, "Minta Mária");
      const customerId = p.url().split("/").pop();
      await ctx.close();
      await stop(server);
      L("a szerverfolyamat leállt (szimulált új telepítés / újraindítás)", server.exitCode !== null || server.signalCode !== null);
      const r = spawnSync(process.execPath, ["--import", "tsx", "e2e/restriction.ts", DB_DIR, customerId], { cwd: ROOT, env: baseEnv, encoding: "utf8" });
      L("meglévő (fiktív) tiltakozási adat a CRM felületén kívül rögzítve az adatbázisban", r.status === 0, r.stderr);
      // Újraindítás a tesztügyfél-törlés kapcsolójával (CRM-006); a korábbi szakaszok kikapcsolt kapcsolóval futottak.
      server = await startServer(PORT, { ...baseEnv, JG_TEST_CUSTOMER_DELETE_ENABLED: "true" });
      const ctx2 = await browser.newContext(ctxOpts(DESKTOP));
      const q = await ctx2.newPage();
      await login(q, EMAIL_B, PW_B);
      await q.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("újraindítás és új munkamenet után minden ügyfél megvan", (await q.locator("main a:has-text('Minta Mária')").count()) === 1 && (await q.locator("main a:has-text('Minta Kft.')").count()) === 1);
      await openCustomer(q, "Minta Kft.");
      const text = await q.locator("#feladatok-lista").innerText();
      const earlier = await q.locator("#korabbi-feladatok").innerText();
      L("újraindítás után a feladatok, Input/Output értékek és státusz-hozzárendelések is megvannak", (earlier + text).includes("Telefonhívás") && (earlier + text).includes("Online tárgyalás") && (await statusSelect(q).inputValue()) === "contact");
      const hq = await q.locator("#elozmenyek").innerText();
      L("B3: újraindítás, kijelentkezés és új belépés után a lezárás minősítése és Outputja visszaolvasható", hq.includes("Feladat lezárva — Sikeres") && hq.includes("Csütörtökön ismét keresni kell.") && hq.includes("Feladat lezárva — Sikertelen") && hq.includes("sem sikerült elérni.") && hq.includes("Feladat átidőzítve"));
      const dq = await openTask(taskRow(q, "Telefonhívás"));
      L("B3: a lezárt feladat modáljában is visszaolvasható (minősítés + Output)", (await dq.innerText()).includes("Lezárva — Sikeres") && (await dq.innerText()).includes("Csütörtökön ismét keresni kell."));
      await closeDialog(q);
      await openCustomer(q, "Minta Mária");
      L("a korábban rögzített tiltakozás/korlátozás megmaradt: rövid jelzés az adatlapon", await q.locator("main >> text=Megkeresés korlátozva").first().isVisible());
      L("a régi nagy megkereshetőségi panel/mátrix és a hosszú figyelmeztetés nincs a felületen", (await q.locator("text=/Megkeresési információk|Megkereshetőség|Marketing|Tiltott|korlátozás rögzítése/").count()) === 0);
      await statusSelect(q).selectOption({ label: "Kapcsolatfelvétel" });
      await q.waitForSelector("text=/van rögzítve/");
      L("a korlátozás továbbra is érvényesül: kimenő kapcsolatfelvételi státusz nem választható, a státusz nem változik", (await statusSelect(q).inputValue()) === "waiting_for_contact");
      await pageA.close().catch(() => {});
      await checkPage(q, "desktop", "korlátozott ügyfél adatlapja");
      await q.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      L("a korlátozás jelzése a pipeline-kártyán", (await q.locator("article:has-text('Megkeresés korlátozva')").count()) === 1);
      // ============ G7) Gyorsműveletek korlátozott ügyfélnél (CRM-011) ============
      await openCustomer(q, "Minta Mária");
      await q.locator(`${SIDE} button:has-text("Szerkesztés")`).click();
      await q.getByLabel(/^Telefonszám/).fill("+36 70 555 1212");
      await q.locator(`${SIDE} button:has-text("Mentés")`).click();
      await q.waitForSelector(`${SIDE} dd:has-text("+36 70 555 1212")`);
      const qaR = q.getByRole("group", { name: "Gyorsműveletek" });
      L("G7: rögzített tiltakozásnál a Hívás nem indítható (nincs tel: hivatkozás), az ok látható", (await qaR.getByRole("link").count()) === 0 && (await qaR.getByRole("button", { name: "Hívás" }).isDisabled()) && (await qaR.innerText()).includes("van rögzítve: kimenő megkeresés nem indítható."));

      // ============ CRM-006) Tesztügyfél eltávolítása - a szerver bekapcsolt kapcsolóval fut ============
      const apiQ = async () => (await (await q.request.get(BASE + "/api/crm/snapshot")).json()).snapshot;
      await q.goto(BASE + "/", { waitUntil: "networkidle" });
      const custCount = async () => Number((await q.locator("ul.grid li").nth(2).locator("span").first().innerText()).trim());
      const countBefore = await custCount();
      await openCustomer(q, "Napi Nándor");
      const napiId2 = q.url().split("/").pop();
      L("D1/D2: bekapcsolt kapcsolóval és bejelentkezve megjelenik az „Ügyfél törlése”", await q.getByRole("button", { name: "Ügyfél törlése" }).isVisible());
      await q.getByRole("button", { name: "Ügyfél törlése" }).click();
      const dd = q.getByRole("dialog", { name: "Ügyfél törlése" });
      L("D3: megerősítő modál az ügyfél nevével; a gomb a „TÖRLÉS” beírásáig tiltott", (await dd.innerText()).includes("Napi Nándor") && (await dd.locator("button[type=submit]").isDisabled()));
      await checkPage(q, "desktop", "ügyfél törlése modál");
      await dd.getByLabel(/A megerősítéshez írd be/).fill("torles");
      L("D3: hibás megerősítő szóval sem engedi", await dd.locator("button[type=submit]").isDisabled());
      await dd.getByRole("button", { name: "Mégse" }).click();
      L("D4: „Mégse”: nincs módosítás", (await dlg(q).count()) === 0 && (await apiQ()).customers.some((c) => c.id === napiId2));
      await q.getByRole("button", { name: "Ügyfél törlése" }).click();
      await dd.getByLabel(/A megerősítéshez írd be/).fill("TÖRLÉS");
      await dd.locator("button[type=submit]").click();
      await q.waitForURL("**/customers");
      L("D5: a törlés után visszajelzés az Ügyfelek oldalon", await shows(q.getByRole("status").filter({ hasText: "Az ügyfél eltávolítva az aktív CRM-ből." })));
      L("D6: az ügyfél eltűnt az aktív ügyféllistából", (await q.locator("main a:has-text('Napi Nándor')").count()) === 0 && (await q.locator("main a:has-text('Minta Kft.')").count()) === 1);
      await q.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      L("D6: a Pipeline-ban sincs kártyája", (await q.locator("article:has-text('Napi Nándor')").count()) === 0);
      await q.goto(BASE + "/", { waitUntil: "networkidle" });
      L("D7: a Dashboard ügyfélszámlálója eggyel csökkent", (await custCount()) === countBefore - 1, `${countBefore} -> ${await custCount()}`);
      await q.locator("#mai-feladataim").getByRole("button", { name: "Csapat összes feladata" }).click();
      L("D9: a feladatlistákban (csapatnézet is) nincs feladata", (await q.locator("#mai-feladataim li[data-task-id]", { hasText: "Napi Nándor" }).count()) === 0);
      await q.getByRole("combobox", { name: "Ügyfél keresése" }).fill("Napi Nándor");
      L("D8/K11: a globális keresőben nem jelenik meg", await shows(q.locator("header >> text=Nincs a keresésnek megfelelő ügyfél.")));
      await q.goto(`${BASE}/customers/${napiId2}`, { waitUntil: "networkidle" });
      L("D12: közvetlen hivatkozással sem nyitható meg aktív ügyfélként", await shows(q.locator("text=Az ügyfél nem található")));
      const forced = await q.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: randomUUID(), op: "note.create", args: { customerId: napiId2, text: "Tiltott jegyzet" } } });
      L("D12: az API megkerülésével sem menthető jegyzet/feladat a törölt ügyfélhez", (await forced.json()).result.ok === false);
      const forcedTask = await q.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: randomUUID(), op: "task.create", args: { input: { customerId: napiId2, taskType: "email" } } } });
      L("D12: … és feladat sem", (await forcedTask.json()).result.ok === false);
      await ctx2.close();
      // D10 + adminisztratív visszaállítás: a szerver leállítása után (a helyi PGlite-könyvtárat egyszerre egy folyamat használhatja).
      await stop(server);
      const removed = spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", "customer:list-removed"], { cwd: ROOT, env: baseEnv, encoding: "utf8" });
      L("D10: az eltávolított rekord a táblákban megmaradt (üzemeltetői lista: azonosító, név nélkül)", removed.status === 0 && removed.stdout.includes(napiId2) && !removed.stdout.includes("Napi Nándor"), removed.stderr.slice(-300));
      const restoredCli = spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", "customer:restore", napiId2, EMAIL_B], { cwd: ROOT, env: baseEnv, encoding: "utf8" });
      L("visszaállítás: az üzemeltetői parancs auditáltan visszaállítja az ügyfelet", restoredCli.status === 0 && restoredCli.stdout.includes(`Visszaállítva: ${napiId2}`), restoredCli.stderr.slice(-300));
      server = await startServer(PORT, baseEnv);
      const ctx3 = await browser.newContext(ctxOpts(DESKTOP));
      const q3 = await ctx3.newPage();
      await login(q3, EMAIL_B, PW_B);
      await q3.goto(`${BASE}/customers/${napiId2}`, { waitUntil: "networkidle" });
      await q3.waitForSelector("main h1:has-text('Napi Nándor')", { timeout: 8000 }).catch(() => {});
      L("D10: visszaállítás után az ügyfél, a feladatai és az előzményei újra elérhetők", (await q3.locator("main h1").innerText().catch(() => "")) === "Napi Nándor" && (await q3.locator("#elozmenyek").innerText()).includes("Feladat lezárva — Sikeres") && (await q3.locator("#feladatok-lista li[data-task-id]").count()) >= 4);
      await ctx3.close();
    }

    L_END(errors);
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

function L_END(errors) {
  log("nincs kezeletlen böngészőoldali konzolhiba", errors.length === 0, errors.slice(0, 3).join(" | "));
}

