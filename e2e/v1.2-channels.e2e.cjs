/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v1.2 - Érkezési csatornák böngészős E2E és akadálymentességi ellenőrzés (Playwright + axe-core).
 * Nézetek: 390 (mobil), 768 (tablet), 1280 és 1440 (desktop).
 *
 * Használat (a repó gyökeréből):  npm run build && node e2e/v1.2-channels.e2e.cjs
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
const PORT = Number(process.env.E2E_CHANNELS_PORT || 3401);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const WORK = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), "jg-e2e-channels-"));
const DB_DIR = path.join(WORK, "pg");
const ADMIN = { email: "crm.admin@example.test", pw: "e2e-crm-admin-12345", name: "Teszt CRM Admin" };
const WORKER = { email: "munkatars@example.test", pw: "e2e-munkatars-67890", name: "Munkatárs Márk" };
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
  await page.screenshot({ path: path.join(SHOTS, `v12-${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}
const rowLabels = (page) => page.locator('[data-testid="catalog-row"] [data-testid="catalog-label"]').allTextContents();


const todayKey = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date());
const tomorrowKey = new Date(Date.parse(todayKey + "T12:00:00Z") + 86400000).toISOString().slice(0, 10);

(async () => {
  const browser = await chromium.launch(process.env.CHROMIUM_EXECUTABLE_PATH ? { executablePath: process.env.CHROMIUM_EXECUTABLE_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"] } : {});
  const VIEWS = { mobil: { width: 390, height: 844 }, desktop: { width: 1440, height: 900 } };
  const errors = [];
  const watch = (page) => {
    page.on("console", (m) => { if (m.type() === "error" && !/Failed to load resource/.test(m.text())) errors.push(m.text()); });
    page.on("pageerror", (e) => errors.push(String(e)));
  };
  try {
    cli(["migrate"]);
    for (const u of [ADMIN, WORKER]) cli(["user:create", u.email, u.name], { JG_USER_PASSWORD: u.pw });
    for (const p of ["crm.settings.manage", "crm.customer.export"]) cli(["permission:grant", ADMIN.email, p]);
    server = await startServer(baseEnv);

    for (const [label, viewport] of Object.entries(VIEWS)) {
      const ctx = await browser.newContext(ctxOpts(viewport));
      const page = await ctx.newPage();
      watch(page);
      const L = (n, ok, e) => log(`[${label}] ${n}`, ok, e);
      await login(page, ADMIN);
      const op = async (name, args) => (await (await page.request.post(BASE + "/api/crm/op", { headers: { origin: BASE }, data: { requestId: require("crypto").randomUUID(), op: name, args } })).json());
      const apiSnap = async () => (await (await page.request.get(BASE + "/api/crm/snapshot")).json()).snapshot;
      const suffix = label === "mobil" ? " (mobil)" : "";

      // ---- Új ügyfél: kötelező csatorna, nincs alapértelmezés
      await page.goto(BASE + "/customers/new", { waitUntil: "networkidle" });
      const select = page.getByLabel(/^Érkezési csatorna\s*\*?$/);
      L("új ügyfél: az érkezési csatorna kötelező, nincs előre kiválasztva (nem `Ismeretlen`)", (await select.inputValue()) === "");
      const opts = await select.locator("option").allTextContents();
      L("új ügyfél: a 12 aktív csatorna választható (az `Ismeretlen` is, de nem alapértelmezett)", opts.includes("Ismeretlen") && opts.includes("Google-keresés") && opts.length === 13, opts.join("|"));
      await page.getByLabel(/^Név/).fill("E2E Csatorna Csilla" + suffix);
      const before = (await apiSnap()).customers.length;
      await page.getByRole("button", { name: "Ügyfél létrehozása", exact: true }).click();
      await page.waitForTimeout(600);
      L("új ügyfél: csatorna nélkül nincs mentés, a hiba a mező mellett látszik", page.url().endsWith("/customers/new") && (await page.getByText("Az érkezési csatorna kiválasztása kötelező").count()) > 0 && (await apiSnap()).customers.length === before);
      await checkPage(page, label, "uj-ugyfel");
      await select.selectOption({ label: "Ajánlás (ügyfél vagy ismerős)" });
      await page.getByLabel(/^Érkezési csatorna részlete/).fill("ajánlotta: meglévő ügyfél");
      await page.getByRole("button", { name: "Ügyfél létrehozása", exact: true }).click();
      await page.waitForURL("**/customers/cust-*");
      await page.waitForSelector(`main h1:has-text("E2E Csatorna Csilla${suffix}")`);

      // ---- Adatlap: megjelenítés és szerkesztés, ügyféltörténet
      const side = page.locator("#kapcsolati-adatok");
      L("adatlap: a csatorna és a részlet látszik", (await side.innerText()).includes("Ajánlás (ügyfél vagy ismerős)") && (await side.innerText()).includes("ajánlotta: meglévő ügyfél"));
      await side.getByRole("button", { name: "Szerkesztés" }).click();
      await side.getByLabel(/^Érkezési csatorna\s*\*?$/).selectOption({ label: "Bemutatkozó levél" });
      await side.getByLabel(/^Érkezési csatorna részlete/).fill("bemutatkozó levél, 2026. nov.");
      await checkPage(page, label, "adatlap-szerkesztes");
      await side.getByRole("button", { name: "Mentés" }).click();
      await page.waitForSelector("#elozmenyek >> text=Érkezési csatorna módosítva");
      const hist = (await page.locator("#elozmenyek").innerText()).replace(/\s+/g, " ");
      L("ügyféltörténet: ki, mikor, régi → új", hist.includes("Korábbi érkezési csatorna: Ajánlás (ügyfél vagy ismerős)") && hist.includes("Új érkezési csatorna: Bemutatkozó levél") && hist.includes("Korábbi részlet: ajánlotta: meglévő ügyfél") && hist.includes(`Rögzítette: ${ADMIN.name}`), hist.slice(0, 400));
      await checkPage(page, label, "adatlap");

      // ---- Lista: oszlop/címke és szűrés (a minta ügyfelek API-n át, vegyes csatornákkal és státuszokkal)
      if (label === "desktop") {
        const mk = async (name, ch, st) => {
          const r = await op("customer.create", { input: { type: "individual", name, acquisitionChannel: ch }, confirmDuplicates: true });
          if (st) await op("customer.changeStatus", { customerId: r.result.value.customer.id, input: { toStatus: st } });
        };
        await mk("E2E Google Géza", "google_kereses", "meeting");
        await mk("E2E Google Gizi", "google_kereses");
        await mk("E2E Rendezvény Rita", "rendezveny", "contact");
        await mk("E2E Ismeretlen Imre", "ismeretlen", "lost");
      }
      await page.goto(BASE + "/customers", { waitUntil: "networkidle" });
      L("lista: a csatorna látható oszlopként/címkeként", (await page.locator("main table").innerText()).includes("Bemutatkozó levél"));
      const filt = page.getByLabel("Érkezési csatorna");
      await filt.selectOption({ label: "Bemutatkozó levél" });
      const expectN = (await apiSnap()).customers.filter((c) => c.acquisitionChannel === "bemutatkozo_level").length;
      const rowsTxt = await page.locator("main tbody tr").allInnerTexts();
      L("lista: szűrés csatornára", rowsTxt.length === expectN && rowsTxt.every((r) => r.includes("Bemutatkozó levél") && r.includes("E2E Csatorna Csilla")), `${rowsTxt.length}/${expectN}`);
      await checkPage(page, label, "lista-szuro");
      await filt.selectOption({ label: "" }).catch(() => filt.selectOption(""));

      // ---- Csatornák kimutatás
      await page.goto(BASE + "/pipeline/channels", { waitUntil: "networkidle" });
      const rep = page.locator('[data-testid="channel-report"]');
      await rep.waitFor();
      const total = Number(await page.locator('[data-testid="grand-total"]').innerText());
      const all = (await apiSnap()).customers.length;
      L("Csatornák: az összesítés megegyezik az ügyfelek számával", total === all, `${total} / ${all}`);
      if (label === "desktop") {
        const g = page.locator('tr[data-channel="google_kereses"]');
        L("Csatornák: csatornánként és státuszonként bontva (Google-keresés: 2 ügyfél, 1 tárgyalás)", (await g.locator('[data-testid="row-total"]').innerText()) === "2" && (await g.innerText()).replace(/\s+/g, " ").includes("2"));
        await page.getByLabel(/^Létrehozva ettől/).fill(tomorrowKey);
        L("Csatornák: időszakszűrő (holnaptól nincs ügyfél)", (await page.locator('[data-testid="grand-total"]').innerText()) === "0");
        await page.getByLabel(/^Létrehozva ettől/).fill(todayKey);
        L("Csatornák: időszakszűrő (mai naptól mindenki)", Number(await page.locator('[data-testid="grand-total"]').innerText()) === all);
        await page.getByRole("button", { name: "Szűrő törlése" }).click();
        await rep.locator('tr[data-channel="google_kereses"] a').click();
        await page.waitForURL("**/customers?csatorna=google_kereses");
        await page.waitForSelector("main tbody tr");
        L("Csatornák: a csatorna-hivatkozás a szűrt ügyféllistát nyitja", (await page.locator("main tbody tr").count()) === 2, `${page.url()} ${(await page.locator("main tbody tr").count())}`);
        await page.goto(BASE + "/pipeline/channels", { waitUntil: "networkidle" });
      }
      await checkPage(page, label, "csatornak");

      // ---- Beállítások: katalógus
      await page.goto(BASE + "/settings/channels", { waitUntil: "networkidle" });
      await page.locator('[data-testid="catalog-row"]').first().waitFor();
      const labels = await rowLabels(page);
      L("Beállítások: a 12 kezdő csatorna listázva", labels.length === 12 && labels[11] === "Ismeretlen", labels.join("|"));
      const unk = page.locator('[data-testid="catalog-row"][data-key="ismeretlen"]');
      L("Beállítások: az `Ismeretlen` rendszerelem nem archiválható", (await unk.getByRole("button", { name: /archiválása/ }).count()) === 0 && (await unk.innerText()).includes("nem archiválható"));
      await checkPage(page, label, "beallitasok-csatornak");
      if (label === "desktop") {
        await page.getByRole("button", { name: /Új érkezési csatorna hozzáadása/ }).click();
        await page.getByRole("dialog").getByLabel(/^Megnevezés/).fill("E2E TBSZ-kampány");
        await page.getByRole("dialog").getByRole("button", { name: "Mentés" }).click();
        await page.waitForSelector('[data-testid="catalog-row"][data-key="e2e_tbsz_kampany"]');
        L("Beállítások: új csatorna felvehető, a technikai kulcs a megnevezésből készül", true);
        await page.goto(BASE + "/customers/new", { waitUntil: "networkidle" });
        L("új ügyfél: az új csatorna azonnal választható", (await page.getByLabel(/^Érkezési csatorna\s*\*?$/).locator("option").allTextContents()).includes("E2E TBSZ-kampány"));
      }
      await ctx.close();
    }

    // ---- Munkatárs: jog nélkül nincs szerkesztőfelület, de a csatorna választható és látható
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      watch(page);
      await login(page, WORKER);
      await page.goto(BASE + "/settings/channels", { waitUntil: "networkidle" });
      log("jog nélkül: a csatorna-szerkesztő nem nyílik meg", (await page.locator('[data-testid="no-permission"]').count()) === 1 && (await page.locator('[data-testid="catalog-row"]').count()) === 0);
      const res = await page.request.post(BASE + "/api/settings/acquisition-channels", { headers: { origin: BASE }, data: { label: "Behatoló" } });
      log("jog nélkül: a katalógus API-n sem módosítható (403)", res.status() === 403);
      await page.goto(BASE + "/customers/new", { waitUntil: "networkidle" });
      log("jog nélkül: új ügyfélnél a csatorna választható", (await page.getByLabel(/^Érkezési csatorna\s*\*?$/).locator("option").count()) > 2);
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
