/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v0.6 (tartós adattárolás, bejelentkezés, feladat Input/Output legördülők, jobb oldali kapcsolati adatok) — E2E és
 * akadálymentességi ellenőrzés (Playwright).
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

const STATUSES = ["Kapcsolatfelvételre vár", "Kapcsolatfelvétel", "Kapcsolatépítés", "Online/Személyes tárgyalás", "Számlanyitás", "Tőke elhelyezve", "Elvesztett"];
const INPUTS = ["Első megkeresés", "Visszahívás", "Időpont-egyeztetés", "Tájékoztatás", "Utánkövetés", "Egyéb"];
const OUTPUTS = ["Feladat elvégezve", "Nem sikerült elérni", "Kapcsolat létrejött", "Visszahívást kért", "Időpont egyeztetve", "Információ elküldve", "További egyeztetés szükséges", "Nem érdeklődik", "Egyéb"];
const TYPES = ["Telefonhívás", "E-mail", "Online tárgyalás", "Személyes tárgyalás", "Utánkövetés", "Egyéb"];

// ----------------------------------------------------------------- szerverkezelés
const baseEnv = { ...process.env, JG_ENV: "local", JG_PGLITE_DIR: DB_DIR, NODE_ENV: "production" };
const tsx = path.join(ROOT, "node_modules", ".bin", "tsx");
function cli(args, extraEnv = {}) {
  const r = spawnSync(tsx, ["scripts/db.ts", ...args], { cwd: ROOT, env: { ...baseEnv, ...extraEnv }, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`db ${args.join(" ")} sikertelen: ${r.stderr}`);
  return r.stdout;
}
let server = null;
async function startServer(port, env) {
  const child = spawn(process.execPath, [path.join(ROOT, "node_modules", "next", "dist", "bin", "next"), "start", "-p", String(port)], { cwd: ROOT, env, stdio: ["ignore", "pipe", "pipe"] });
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
const dateInput = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };
const statusSelect = (page) => page.getByLabel("Kapcsolati státusz");
const taskRow = (page, title) => page.locator("li", { has: page.getByRole("checkbox", { name: `Elvégezve: ${title}` }) }).first();
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
  await page.click('button:has-text("Ügyfél létrehozása")');
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
async function closeTask(page, title, output, note) {
  await taskRow(page, title).getByRole("checkbox").click();
  await dlg(page).getByLabel(/^Output/).selectOption({ label: output });
  if (note) await dlg(page).getByLabel(/Rövid megjegyzés/).fill(note);
  await dlg(page).locator("button[type=submit]").click();
  await dlg(page).waitFor({ state: "detached", timeout: 8000 }).catch(() => {});
  await settle(page);
}
async function openDetails(row) {
  const btn = row.getByRole("button", { name: "Részletek" });
  if ((await btn.getAttribute("aria-expanded")) !== "true") await btn.click();
}
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
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote", "--single-process"] } : {});
  const DESKTOP = { width: 1440, height: 900 }, MOBILE = { width: 390, height: 844 };
  try {
    // ============ 0) Adatbázis nélkül: nincs csendes tartalék ============
    {
      const unconfigured = await startServer(PORT + 1, { ...process.env, NODE_ENV: "production", JG_ENV: "", JG_PGLITE_DIR: "", DATABASE_URL: "" });
      const ctx = await browser.newContext({ viewport: DESKTOP });
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
    const ctxA = await browser.newContext({ viewport: DESKTOP, acceptDownloads: true });
    const pageA = await ctxA.newPage();
    const errors = [];
    pageA.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    pageA.on("pageerror", (e) => errors.push(String(e)));
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      L("bejelentkezés nélkül a belépési űrlap látszik, az ügyfél-adat és a navigáció nem", (await pageA.getByRole("heading", { name: "Bejelentkezés" }).isVisible()) && (await pageA.locator('nav[aria-label^="Fő navigáció"]').count()) === 0);
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
      L("a szerkesztő űrlap a sávban nyílik, nincs duplikált szerkesztő (egy mentés gomb)", (await pageA.locator(`${SIDE} button:has-text("Mentés")`).count()) === 1 && (await pageA.locator('main button:has-text("Mentés")').count()) === 1);
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
      await pageA.getByLabel(/^E-mail/).fill("nem-email");
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
      L("„Mégse”: nem jön létre feladat", (await pageA.locator("li:has(input[type=checkbox])").count()) === 0);
      await addTask(pageA, "Telefonhívás", { input: "Visszahívás", due: dateInput(3) });
      await addTask(pageA, "E-mail");
      await addTask(pageA, "Utánkövetés", { input: "Egyéb", note: "Ajánló szerint" });
      L("három feladat jött létre az aktuális státusz alatt", (await pageA.locator('#feladatok-lista input[type=checkbox]').count()) === 3);
      L("a feladat neve a kiválasztott típus neve; az Input a sor második sorában", (await pageA.locator('#feladatok-lista').innerText()).includes("Visszahívás"));
      const row = taskRow(pageA, "Telefonhívás");
      await openDetails(row);
      L("részletek: Input a legördülő értékéből, határidő, „még nincs lezárva”", (await row.innerText()).includes("Visszahívás") && (await row.innerText()).includes("— még nincs lezárva —"));
      await openDetails(taskRow(pageA, "Utánkövetés"));
      L("az „Egyéb” Input megjegyzése megjelenik", (await taskRow(pageA, "Utánkövetés").innerText()).includes("Egyéb — Ajánló szerint"));

      // ============ F) Lezárás ============
      await taskRow(pageA, "Telefonhívás").getByRole("checkbox").click();
      const c = dlg(pageA);
      L("lezáró modál: csak olvasható feladatnév és Input, Output legördülő (kötelező)", (await c.locator("text=Feladat").first().isVisible()) && (await c.locator("p:has-text('Telefonhívás')").count()) === 1 && (await c.locator("p:has-text('Visszahívás')").count()) === 1 && (await c.getByLabel(/^Output/).count()) === 1 && (await c.locator("textarea").count()) === 0);
      L("az Output legördülő lehetőségei az ideiglenes lista szerint", JSON.stringify(await optionTexts(c.getByLabel(/^Output/))) === JSON.stringify(OUTPUTS));
      L("a lezáró modál gombja „Feladat lezárása”", (await c.locator("button[type=submit]").innerText()) === "Feladat lezárása");
      await checkPage(pageA, "desktop", "feladat lezárása modál");
      await c.locator("button[type=submit]").click();
      L("Output nélkül a lezárás blokkolt: hibaüzenet, a modál nyitva, a feladat nyitott", (await shows(c.locator("text=Az Output kiválasztása kötelező"))) && (await taskRow(pageA, "Telefonhívás").getByRole("checkbox").isChecked()) === false);
      await c.getByLabel(/^Output/).selectOption({ label: "Egyéb" });
      L("az „Egyéb” Outputnál rövid, opcionális megjegyzés mező", await c.getByLabel(/Rövid megjegyzés/).isVisible());
      await c.getByLabel(/^Output/).selectOption({ label: "Nem sikerült elérni" });
      L("más Outputnál nincs megjegyzés mező", (await c.getByLabel(/Rövid megjegyzés/).count()) === 0);
      await c.getByRole("button", { name: "Mégse" }).click();
      L("„Mégse” után a feladat nyitott marad", (await taskRow(pageA, "Telefonhívás").getByRole("checkbox").isChecked()) === false);
      const before = await statusSelect(pageA).inputValue();
      await closeTask(pageA, "Telefonhívás", "Nem sikerült elérni");
      L("egyetlen kiválasztott Output elég a lezáráshoz", await taskRow(pageA, "Telefonhívás").getByRole("checkbox").isChecked());
      L("a lezárás nem módosítja az ügyfél státuszát", (await statusSelect(pageA).inputValue()) === before);
      await openDetails(taskRow(pageA, "Telefonhívás"));
      L("a rögzített Output és a rögzítő látszik", (await taskRow(pageA, "Telefonhívás").innerText()).includes("Nem sikerült elérni") && (await taskRow(pageA, "Telefonhívás").innerText()).includes("Teszt Pilot Egy"));
      // újranyitás + újabb lezárás: előzmény
      await taskRow(pageA, "Telefonhívás").getByRole("checkbox").click();
      await until(async () => !(await taskRow(pageA, "Telefonhívás").getByRole("checkbox").isChecked()));
      L("a pipa kivétele újranyitja a feladatot", (await taskRow(pageA, "Telefonhívás").getByRole("checkbox").isChecked()) === false);
      await closeTask(pageA, "Telefonhívás", "Egyéb", "Levélben válaszolt");
      await openDetails(taskRow(pageA, "Telefonhívás"));
      const txt = await taskRow(pageA, "Telefonhívás").innerText();
      L("újrazárás után az aktuális eredmény az új, a korábbi lezárás előzményként megmarad", txt.includes("Egyéb — Levélben válaszolt") && txt.includes("Korábbi lezárások eredménye (1)"));
      await pageA.reload({ waitUntil: "networkidle" });
      await pageA.waitForSelector("#feladatok-lista");
      await openDetails(taskRow(pageA, "Telefonhívás"));
      await taskRow(pageA, "Telefonhívás").locator("summary").click();
      L("az eredmény-előzmény frissítés után is megvan (adatbázisból)", (await taskRow(pageA, "Telefonhívás").innerText()).includes("Nem sikerült elérni"));
      // határidő módosítás / törlés
      await taskRow(pageA, "E-mail").getByRole("button", { name: "Részletek" }).click();
      await taskRow(pageA, "E-mail").getByLabel("Határidő módosítása").fill(dateInput(5));
      await until(async () => (await taskRow(pageA, "E-mail").innerText()).includes("Határidő:"));
      L("a határidő utólag megadható és mentődik", (await taskRow(pageA, "E-mail").innerText()).includes("Határidő:"));

      // ============ G) Státuszváltás, korábbi feladatok, pipeline ============
      await statusSelect(pageA).selectOption({ label: "Kapcsolatfelvétel" });
      await until(async () => /— Kapcsolatfelvétel\s*\(/.test(await pageA.locator("#feladatok-lista h2").innerText()));
      L("státuszváltás után az aktuális státusz feladatai üresek, a korábbiak megmaradtak", (await pageA.locator("#feladatok-lista").innerText()).includes("Ennél a státusznál még nincs feladat") && (await pageA.locator("#korabbi-feladatok").innerText()).includes("Telefonhívás"));
      await addTask(pageA, "Online tárgyalás", { input: "Időpont-egyeztetés" });
      L("az új feladat az új státuszhoz kapcsolódik", (await pageA.locator("#feladatok-lista input[type=checkbox]").count()) === 1);
      await statusSelect(pageA).selectOption({ label: "Tőke elhelyezve" });
      L("„Tőke elhelyezve”: igazolási párbeszéd nyílik, a státusz még nem változik", (await dlg(pageA).locator("legend:has-text('Igazolás')").isVisible()) && (await statusSelect(pageA).inputValue()) !== "capital_placed");
      await dlg(pageA).locator("button[type=submit]").click();
      L("igazolás nélkül a „Tőke elhelyezve” nem rögzíthető", await shows(dlg(pageA).locator("[role=alert]")));
      await dlg(pageA).getByRole("button", { name: "Mégse" }).click();
      L("a státusz mentése után a pipeline-on egyetlen kártya, a megfelelő oszlopban", await (async () => {
        await pageA.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
        const labels = await pageA.locator("section[aria-label] h3").allTextContents();
        return JSON.stringify(labels.map((t) => t.trim())) === JSON.stringify(STATUSES) && (await pageA.locator("article:has-text('Minta Kft.')").count()) === 1 && (await col(pageA, "Kapcsolatfelvétel").locator("article:has-text('Minta Kft.')").count()) === 1 && (await col(pageA, "Kapcsolatfelvételre vár").locator("article:has-text('Minta Mária')").count()) === 1;
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
      L("billentyűzet: az Esc bezárja a modált, nem jön létre feladat", (await dlg(pageA).count()) === 0 && (await pageA.locator("#feladatok-lista input[type=checkbox]").count()) === 0);
      await statusSelect(pageA).focus();
      L("billentyűzet: a státuszválasztó fókuszálható és címkézett", (await pageA.evaluate(() => document.activeElement?.getAttribute("aria-label"))) === "Kapcsolati státusz");
    }

    // ============ I) Második pilot felhasználó: közös nézet, azonosítható módosító ============
    const ctxB = await browser.newContext({ viewport: DESKTOP });
    const pageB = await ctxB.newPage();
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await login(pageB, EMAIL_B, PW_B);
      await pageB.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("két pilot felhasználó: a másik felhasználó ugyanazt az adatot látja", (await pageB.locator("main a:has-text('Minta Mária')").count()) === 1 && (await pageB.locator("main a:has-text('Minta Kft.')").count()) === 1);
      await openCustomer(pageB, "Minta Kft.");
      await addTask(pageB, "Személyes tárgyalás", { input: "Tájékoztatás" });
      await closeTask(pageB, "Személyes tárgyalás", "Információ elküldve");
      await pageA.goto(BASE + "/customers", { waitUntil: "networkidle" });
      await openCustomer(pageA, "Minta Kft.");
      const r = taskRow(pageA, "Személyes tárgyalás");
      await openDetails(r);
      const t = await r.innerText();
      L("az első felhasználó látja a másik módosítását, a rögzítő a második felhasználó", t.includes("Információ elküldve") && t.includes("Teszt Pilot Kettő"));
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
      L("újrapróbálás után a feladat létrejön, és pontosan egy (nincs duplikátum)", (await countTasks()) === baseCount + 1 && (await pageA.locator("#feladatok-lista input[type=checkbox]").count()) === 1);
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
      const ctxL = await browser.newContext({ viewport: DESKTOP, acceptDownloads: true });
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
      const ctxM = await browser.newContext({ viewport: MOBILE });
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
      await taskRow(m, "E-mail").getByRole("checkbox").click();
      await checkPage(m, "mobile", "feladat lezárása modál");
      await dlg(m).getByRole("button", { name: "Mégse" }).click();
      await m.goto(BASE + "/pipeline", { waitUntil: "networkidle" });
      await checkPage(m, "mobile", "pipeline");
      await m.goto(BASE + "/customers", { waitUntil: "networkidle" });
      await checkPage(m, "mobile", "ügyféllista");
      await ctxM.close();
    }

    // ============ M) Kijelentkezés ============
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      await pageA.goto(BASE + "/", { waitUntil: "networkidle" });
      await pageA.getByRole("button", { name: "Kijelentkezés" }).click();
      await pageA.getByRole("heading", { name: "Bejelentkezés" }).waitFor();
      L("kijelentkezés: a belépési űrlap látszik, az adat nem", (await pageA.locator("text=Minta Mária").count()) === 0);
      const after = await pageA.request.get(BASE + "/api/crm/snapshot");
      L("kijelentkezés után az API 401-et ad (a munkamenet a szerveren is megszűnt)", after.status() === 401);
      await pageA.goBack().catch(() => {});
      L("a böngésző „vissza” gombja sem mutat adatot", (await pageA.locator("text=Minta Mária").count()) === 0);
    }
    await ctxA.close();

    // ============ N) Teljes újraindítás: az adat megmarad; meglévő tiltakozási adat megőrzése ============
    {
      const L = (n, ok, e) => log(`[desktop] ${n}`, ok, e);
      const ctx = await browser.newContext({ viewport: DESKTOP });
      const p = await ctx.newPage();
      await login(p, EMAIL_B, PW_B);
      await openCustomer(p, "Minta Mária");
      const customerId = p.url().split("/").pop();
      await ctx.close();
      await stop(server);
      L("a szerverfolyamat leállt (szimulált új telepítés / újraindítás)", server.exitCode !== null || server.signalCode !== null);
      const r = spawnSync(tsx, ["e2e/restriction.ts", DB_DIR, customerId], { cwd: ROOT, env: baseEnv, encoding: "utf8" });
      L("meglévő (fiktív) tiltakozási adat a CRM felületén kívül rögzítve az adatbázisban", r.status === 0, r.stderr);
      server = await startServer(PORT, baseEnv);
      const ctx2 = await browser.newContext({ viewport: DESKTOP });
      const q = await ctx2.newPage();
      await login(q, EMAIL_B, PW_B);
      await q.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("újraindítás és új munkamenet után minden ügyfél megvan", (await q.locator("main a:has-text('Minta Mária')").count()) === 1 && (await q.locator("main a:has-text('Minta Kft.')").count()) === 1);
      await openCustomer(q, "Minta Kft.");
      const text = await q.locator("#feladatok-lista").innerText();
      const earlier = await q.locator("#korabbi-feladatok").innerText();
      L("újraindítás után a feladatok, Input/Output értékek és státusz-hozzárendelések is megvannak", (earlier + text).includes("Telefonhívás") && (earlier + text).includes("Online tárgyalás") && (await statusSelect(q).inputValue()) === "contact");
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
      await ctx2.close();
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

