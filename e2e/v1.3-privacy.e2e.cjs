/* eslint-disable @typescript-eslint/no-require-imports */
/**
 * JG Investment OS v1.3 - Adatvédelem (GDPR) böngészős E2E és akadálymentességi ellenőrzés (Playwright + axe-core).
 *
 * Saját `next start` szervert indít ideiglenes PGlite adatbázissal (éles vagy külső adatbázishoz soha nem kapcsolódik), a jogokat az
 * üzemeltetői CLI osztja ki. Ellenőrzi: biztonsági fejlécek (CSP, HSTS, COOP, X-Powered-By hiánya), CSP-sértés nélküli működés,
 * munkatárs-tiltás (felület + API), érintetti kérelem rögzítése, adatkivonat letöltése (JSON), végleges törlés megerősítéssel,
 * megőrzési és tájékoztató fül, 390 és 1440 px nézet, axe (WCAG 2.1 A/AA). Kizárólag fiktív adat.
 *
 * Futtatás: npm run build && node e2e/v1.3-privacy.e2e.cjs   (port: E2E_PRIVACY_PORT, alapértelmezés 3501)
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const { randomUUID } = require("crypto");
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
const PORT = Number(process.env.E2E_PRIVACY_PORT || 3501);
const BASE = `http://127.0.0.1:${PORT}`;
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const WORK = fs.mkdtempSync(path.join(process.env.E2E_TMP || os.tmpdir(), "jg-e2e-privacy-"));
const DB_DIR = path.join(WORK, "pg");
const DPO = { email: "adatvedelem@example.test", pw: "e2e-adatvedelem-12345", name: "Adatvédelmi Dóra" };
const WORKER = { email: "munkatars@example.test", pw: "e2e-munkatars-67890", name: "Munkatárs Márk" };
const HELPER = { email: "helyettes@example.test", pw: "e2e-helyettes-13579", name: "Helyettes Hédi" };
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

const ctxOpts = (viewport) => ({ viewport, timezoneId: TZ, acceptDownloads: true });
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
  await page.screenshot({ path: path.join(SHOTS, `v13-${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}
/** CRM-művelet a böngésző munkamenetével (azonos eredet, mint a felületről). */
const op = (page, name, args) => page.evaluate(async ([n, a, id]) => {
  const r = await fetch("/api/crm/op", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ requestId: id, op: n, args: a }) });
  return r.json();
}, [name, args, randomUUID()]);

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
    for (const u of [DPO, WORKER, HELPER]) cli(["user:create", u.email, u.name], { JG_USER_PASSWORD: u.pw });
    for (const p of ["crm.privacy.manage", "crm.privacy.erase"]) cli(["permission:grant", DPO.email, p]);
    cli(["permission:grant", HELPER.email, "crm.privacy.manage"]);
    server = await startServer(baseEnv);

    // ============ H: biztonsági fejlécek ============
    {
      const r = await fetch(`${BASE}/`);
      const csp = r.headers.get("content-security-policy") || "";
      log("H1: CSP - csak saját eredet, keretbe ágyazás és plugin tiltva", /default-src 'self'/.test(csp) && /frame-ancestors 'none'/.test(csp) && /object-src 'none'/.test(csp) && !/unsafe-eval/.test(csp), csp);
      log("H2: HSTS, COOP, CORP, noindex", /max-age=63072000/.test(r.headers.get("strict-transport-security") || "") && r.headers.get("cross-origin-opener-policy") === "same-origin" && r.headers.get("cross-origin-resource-policy") === "same-origin" && /noindex/.test(r.headers.get("x-robots-tag") || ""));
      log("H3: nincs X-Powered-By (technológia-felfedés)", r.headers.get("x-powered-by") === null);
    }

    // ============ W: munkatárs - nincs hozzáférés ============
    {
      const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const page = await ctx.newPage();
      watch(page);
      await login(page, WORKER);
      const api = await page.evaluate(async () => (await fetch("/api/privacy/requests")).status);
      log("W1: munkatárs: az adatvédelmi API 403", api === 403, String(api));
      await page.goto(BASE + "/settings/privacy", { waitUntil: "networkidle" });
      const visible = await page.getByText("Új kérelem rögzítése").count();
      log("W2: munkatárs: az Adatvédelem oldal tartalma nem jelenik meg", visible === 0);
      await ctx.close();
    }

    // ============ D: adatvédelmi felelős - teljes folyamat ============
    const ctx = await browser.newContext(ctxOpts(VIEWS.desktop));
    const page = await ctx.newPage();
    watch(page);
    await login(page, DPO);
    const created = await op(page, "customer.create", { input: { type: "company", acquisitionChannel: "egyeb", companyName: "Fiktív Érintett Kft.", contactName: "Teszt Kapcsolat", phone: "+36 1 555 0101", email: "erintett@example.test" } });
    const customerId = created.result?.value?.customer?.id;
    log("D0: fiktív ügyfél létrehozva", Boolean(customerId), JSON.stringify(created.result).slice(0, 200));
    await op(page, "note.create", { customerId, text: "Fiktív jegyzet a kivonathoz" });

    await page.goto(BASE + "/settings/privacy", { waitUntil: "networkidle" });
    log("D1: a Beállítások menüben megjelenik az Adatvédelem", (await page.getByRole("navigation", { name: "Beállítások" }).getByRole("link", { name: "Adatvédelem" }).count()) === 1);
    await page.getByText("Nyitott kérelem").first().waitFor();
    await checkPage(page, "desktop", "ures");

    // Hozzáférési kérelem a felületen.
    const addRequest = async (kind, verified, pg = page) => {
      await pg.getByRole("button", { name: "Új kérelem rögzítése" }).click();
      const dlg = pg.getByRole("dialog");
      await dlg.getByLabel("Kérelem típusa").selectOption(kind);
      await dlg.getByLabel("Ügyfél keresése (név, e-mail, telefonszám)").fill("Fiktív Érintett");
      await dlg.getByRole("button", { name: "Fiktív Érintett Kft." }).click();
      if (verified) await dlg.getByLabel(/személyazonossága ellenőrzött/).check();
      await dlg.getByRole("button", { name: "Kérelem rögzítése" }).click();
      await pg.getByText("A kérelem rögzítve.").waitFor();
    };
    await addRequest("access", true);
    const items = page.locator('[data-testid="privacy-request"]');
    await items.first().waitFor();
    log("D2: a hozzáférési kérelem megjelenik határidővel", (await items.count()) === 1 && /Hozzáférés \(15\. cikk\)/.test(await items.first().textContent()));
    await checkPage(page, "desktop", "kerelem");

    const [dl] = await Promise.all([page.waitForEvent("download"), items.first().getByRole("button", { name: "Adatkivonat letöltése (JSON)" }).click()]);
    const file = await dl.path();
    const rep = JSON.parse(fs.readFileSync(file, "utf8"));
    log("D3: az adatkivonat letölthető és teljes (név, elérhetőség, jegyzet, tájékoztató)", rep.format === "jg-os-gdpr-access-report" && rep.subject.name === "Fiktív Érintett Kft." && rep.subject.email === "erintett@example.test" && JSON.stringify(rep.history).includes("Fiktív jegyzet") && rep.processing.purposes.length > 0, JSON.stringify(rep.subject));
    log("D4: a kivonat fájlneve személyes adatot nem tartalmaz", /^JG_Adatkivonat_pr-[0-9a-f]{16}_\d{4}-\d{2}-\d{2}\.json$/.test(dl.suggestedFilename()), dl.suggestedFilename());

    // Négy-szem elv: a saját maga által rögzített törlési kérelmet a vezető sem hajthatja végre.
    await addRequest("erasure", false);
    const own = items.filter({ hasText: "Törlés (17. cikk)" }).first();
    await own.getByRole("button", { name: "Személyazonosság ellenőrizve" }).click();
    await page.getByText("Az azonosítás rögzítve.").waitFor();
    const ownItem = items.filter({ hasText: "Törlés (17. cikk)" }).first();
    log("D4b: négy-szem elv - a saját törlési kérelemnél nincs törlés gomb, magyarázat látszik",
      (await ownItem.getByTestId("four-eyes-note").count()) === 1 && (await ownItem.getByRole("button", { name: "Végleges törlés…" }).count()) === 0);

    // A helyettes rögzíti (azonosítva) a törlési kérelmet, a törlési jogú vezető hajtja végre, beírt megerősítéssel.
    {
      const hctx = await browser.newContext(ctxOpts(VIEWS.desktop));
      const hp = await hctx.newPage();
      watch(hp);
      await login(hp, HELPER);
      await hp.goto(BASE + "/settings/privacy", { waitUntil: "networkidle" });
      await addRequest("erasure", true, hp);
      log("D4c: a törlési jog nélküli helyettesnél nincs végleges törlés gomb", (await hp.getByRole("button", { name: "Végleges törlés…" }).count()) === 0);
      await hctx.close();
    }
    await page.reload({ waitUntil: "networkidle" });
    await items.first().waitFor();
    await items.filter({ hasText: "Helyettes Hédi" }).filter({ hasText: "Törlés (17. cikk)" }).first().getByRole("button", { name: "Végleges törlés…" }).click();
    const dlg = page.getByRole("dialog");
    const btn = dlg.getByRole("button", { name: "Végleges törlés", exact: true });
    log("D5: a végleges törlés gombja a megerősítő szó nélkül nem aktív", await btn.isDisabled());
    await checkPage(page, "desktop", "torles_megerosites");
    await dlg.getByLabel(/A megerősítéshez írd be/).fill("VÉGLEGES TÖRLÉS");
    await btn.click();
    await page.getByText(/véglegesen anonimizálva/).waitFor();
    const snap = await page.evaluate(async () => (await (await fetch("/api/crm/snapshot")).json()).snapshot);
    log("D6: a törölt ügyfél eltűnt az aktív CRM-ből", !snap.customers.some((c) => c.id === customerId));
    await page.goto(BASE + `/customers/${customerId}`, { waitUntil: "networkidle" });
    log("D7: a törölt ügyfél adatlapja nem érhető el, és a név nem jelenik meg", (await page.getByText("Fiktív Érintett Kft.").count()) === 0);

    await page.goto(BASE + "/settings/privacy", { waitUntil: "networkidle" });
    await page.getByLabel("Szűrés").selectOption("");
    await page.locator('[data-testid="privacy-request"]').first().waitFor();
    const all = await page.locator('[data-testid="privacy-request"]').allTextContents();
    log("D8: a teljesített törlési kérelem a nyilvántartásban marad, az ügyfél „Törölt ügyfél”", all.some((t) => /Törlés \(17\. cikk\)/.test(t) && /Teljesítve/.test(t) && /Törölt ügyfél/.test(t)), all.join(" | ").slice(0, 300));
    await page.getByRole("tab", { name: "Megőrzés" }).click();
    await page.getByText("Felülvizsgálandó ügyfelek").first().waitFor();
    await checkPage(page, "desktop", "megorzes");
    await page.getByRole("tab", { name: "Adatkezelési tájékoztató" }).click();
    await page.getByText("Az érintett jogai").waitFor();
    await checkPage(page, "desktop", "tajekoztato");
    await ctx.close();

    // ============ M: mobil nézet ============
    {
      const m = await browser.newContext(ctxOpts(VIEWS.mobil));
      const mp = await m.newPage();
      watch(mp);
      await login(mp, DPO);
      await mp.goto(BASE + "/settings/privacy", { waitUntil: "networkidle" });
      await mp.getByText("Nyitott kérelem").first().waitFor();
      await mp.getByLabel("Szűrés").selectOption("");
      await mp.locator('[data-testid="privacy-request"]').first().waitFor();
      await checkPage(mp, "mobil", "kerelmek");
      await mp.getByRole("button", { name: "Új kérelem rögzítése" }).click();
      await mp.getByRole("dialog").waitFor();
      await checkPage(mp, "mobil", "uj_kerelem");
      await m.close();
    }

    log("nincs kezeletlen böngészőoldali konzolhiba (CSP-sértés sem)", errors.length === 0, errors.slice(0, 3).join(" | "));
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
