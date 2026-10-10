/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v0.3 — E2E és akadálymentességi ellenőrzés (Playwright).
 *
 * Használat (a repó gyökeréből):
 *   npm run build && npx next start -p 3100 &      # éles build
 *   node e2e/v0.3.e2e.cjs                           # BASE_URL=http://localhost:3100
 *
 * Nincs új függőség: a Playwright-ot (és opcionálisan az axe-core-t) a környezetből oldja fel:
 *   require("playwright") -> PLAYWRIGHT_PATH -> /opt/node22/lib/node_modules/playwright
 *   axe-core: AXE_PATH vagy require.resolve("axe-core/axe.min.js"); ha nincs, az a11y lépések "SKIPPED"-ként jelennek meg
 *   (NEM sikeresként).
 * Minden teszt üres CRM-ből indul, kizárólag fiktív adatot használ, és a UI-n keresztül hozza létre az adatot.
 * Képernyőképek: e2e/shots/ (gitignore-olt).
 */
const fs = require("fs");
const path = require("path");

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

const BASE = process.env.BASE_URL || "http://localhost:3100";
const SHOTS = path.join(__dirname, "shots");
fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
let skipped = 0;
const log = (name, ok, extra = "") => { results.push({ name, ok: !!ok }); console.log(ok ? "PASS" : "FAIL", name, ok ? "" : extra); };
const skip = (name) => { skipped += 1; console.log("SKIPPED", name, "(axe-core nem érhető el)"); };

const KEY = "jg-os-demo-v0.2";
const dlg = (page) => page.locator("dialog[open]");
const col = (page, label) => page.locator(`section[aria-label^="${label} ("]`);
const colCount = async (page, label) => col(page, label).locator("article").count();
const storage = (page) => page.evaluate((k) => { const r = sessionStorage.getItem(k); return r ? JSON.parse(r) : null; }, KEY);
async function ready(page, p) { await page.goto(BASE + p, { waitUntil: "networkidle" }); await page.waitForSelector("main h1"); }
async function settle(page) { await page.waitForTimeout(350); }

// Kézzel összeállított (fiktív) v0.2 snapshot injektálása a böngészőtárba, a felhasználó által létrehozott adat szimulálására.
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const snap = (o) => ({ version: 2, customers: [], contacts: [], processes: [], activities: [], tasks: [], contactability: [], ...o });
const cust = (o) => ({ contactStatus: "prospect", ownerId: "user-1", source: "teszt", verificationStatus: "demo", createdAt: iso(-5), updatedAt: iso(-5), ...o });
const proc = (o) => ({ type: "outbound_outreach", status: "pending_outreach", closure: { state: "active" }, channel: "phone", source: "other", ownerId: "user-1", createdAt: iso(-3), updatedAt: iso(-3), ...o });
const kont = (o) => ({ isPrimaryContact: false, createdAt: iso(-4), updatedAt: iso(-4), ...o });
async function newCtx(browser, vp, injected) {
  const ctx = await browser.newContext({ viewport: vp, acceptDownloads: true });
  if (injected) await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("e2e-injected")) { sessionStorage.setItem(k, v); sessionStorage.setItem("e2e-injected", "1"); } }, [KEY, JSON.stringify(injected)]);
  return ctx;
}

async function checkPage(page, label, p, tag) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  log(`[${label}] ${tag}: nincs vízszintes oldalgörgetés`, overflow <= 0, `overflow=${overflow}`);
  if (axeSrc) {
    await page.evaluate(axeSrc);
    const v = await page.evaluate(async () => (await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}(${x.nodes.length}):${x.nodes[0].target}`));
    log(`[${label}] ${tag}: axe (WCAG A/AA)`, v.length === 0, v.join("; "));
  } else skip(`[${label}] ${tag}: axe`);
  await page.screenshot({ path: path.join(SHOTS, `${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}

(async () => {
  const browser = await chromium.launch();
  for (const [label, vp] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const L = (n, ok, e) => log(`[${label}] ${n}`, ok, e);

    // ============ A) Üres CRM, első ügyfél, pipeline, szinkron ============
    {
      const ctx = await newCtx(browser, vp);
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));

      await ready(page, "/");
      L("üres CRM: az áttekintés üres állapotot mutat", await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible());
      L("üres CRM: nincs félrevezető statisztika", (await page.locator("text=Mai feladatok").count()) === 0 && (await page.locator("text=Aktív folyamatok").count()) === 0);
      L("üres CRM: első ügyfél CTA az áttekintésen", await page.locator('a:has-text("+ Első ügyfél hozzáadása")').first().isVisible());
      await checkPage(page, label, "/", "üres áttekintés");
      const navText = (await page.locator('nav[aria-label^="Fő navigáció"] a:visible').allTextContents()).map((t) => t.trim()).join("|");
      L("főmenü: Áttekintés / Pipeline / Ügyfelek", navText === "Áttekintés|Pipeline|Ügyfelek", navText);
      L("nincs külön Ügyek/Feladatok/Tevékenységek/Kapcsolattartók főmenü", (await page.locator("a:visible", { hasText: /^(Ügyek|Feladatok|Tevékenységek|Kapcsolattartók)$/ }).count()) === 0);

      await ready(page, "/customers");
      L("üres ügyféllista: „Még nincs rögzített ügyfél.”", await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible());
      L("üres ügyféllista: „+ Első ügyfél hozzáadása” CTA", await page.locator('main a:has-text("+ Első ügyfél hozzáadása")').first().isVisible());
      L("„+ Új ügyfél” gomb a fejlécben", await page.locator('main a:has-text("+ Új ügyfél")').first().isVisible());
      L("üres ügyféllista: nincs fiktív sor", (await page.locator("tbody tr").count()) === 0);
      await checkPage(page, label, "/customers", "üres ügyféllista");
      await ready(page, "/pipeline");
      L("üres pipeline: „Még nincs aktív értékesítési folyamat.”", await page.locator("text=Még nincs aktív értékesítési folyamat.").first().isVisible());
      L("üres pipeline: nincs kártya", (await page.locator("article").count()) === 0);
      await checkPage(page, label, "/pipeline", "üres pipeline");
      const st0 = await storage(page);
      L("nincs automatikus fiktív seed a tárban", !st0 || st0.customers.length === 0);

      // Első ügyfél az üres állapotból
      await ready(page, "/customers");
      await page.click('main a:has-text("+ Első ügyfél hozzáadása")');
      await page.waitForURL("**/customers/new");
      await page.click('button:has-text("Ügyfél létrehozása")');
      L("magánszemély űrlap: kötelező mezők hibája (név, telefon)", (await page.locator("text=Vezetéknév megadása kötelező").first().isVisible()) && (await page.locator("text=Telefonszám megadása kötelező").first().isVisible()));
      L("magánszemély űrlapon nincs cégnév és az e-mail nem kötelező", (await page.getByLabel("Cégnév").count()) === 0 && (await page.getByLabel("E-mail (opcionális)").count()) === 1);
      await page.getByLabel("Vezetéknév").fill("QAbejövő");
      await page.getByLabel("Keresztnév").fill("Anna");
      await page.getByLabel("Telefonszám").fill("+36 30 555 0101");
      await page.getByLabel("Folyamat indítása").selectOption("inbound_inquiry");
      await page.click('button:has-text("Ügyfél létrehozása")');
      await page.waitForURL("**/customers/cust-*");
      L("első ügyfél létrejött és megnyílt az adatlap", await page.locator("h1:has-text('QAbejövő Anna')").isVisible());
      await settle(page);
      await ready(page, "/customers");
      L("az ügyfél megjelent az Ügyfelek listában", await page.locator("tbody tr:has-text('QAbejövő Anna')").count() === 1);

      // Cég kapcsolati személlyel
      await ready(page, "/customers/new");
      await page.click("label:has-text('Cég')");
      await page.click('button:has-text("Ügyfél létrehozása")');
      L("cég űrlap: cégnév, kapcsolati személy neve és telefon kötelező", (await page.locator("text=Cégnév megadása kötelező").first().isVisible()) && (await page.locator("text=Telefonszám megadása kötelező").first().isVisible()));
      L("cég űrlapon nincs többes kapcsolattartó-felvétel", (await page.locator('button:has-text("Kapcsolattartó hozzáadása")').count()) === 0);
      await page.getByLabel("Cégnév").fill("QA Teszt Kft.");
      await page.getByLabel("Kapcsolati személy vezetékneve").fill("Kapcsolat");
      await page.getByLabel("Kapcsolati személy keresztneve").fill("Kata");
      await page.getByLabel("Telefonszám").fill("+36 1 555 0100");
      await page.getByLabel("Folyamat indítása").selectOption("outbound_outreach");
      await page.getByLabel("Rövid megnevezés").fill("QA kimenő megkeresés");
      await page.click('button:has-text("Ügyfél létrehozása")');
      await page.waitForURL("**/customers/cust-*");
      const companyUrl = page.url();
      L("cég létrejött", await page.locator("h1:has-text('QA Teszt Kft.')").isVisible());
      L("céges adatlap: CÉGADATOK / KAPCSOLATI ADATOK / NYILVÁNTARTÁSI ADATOK blokkok", (await page.locator('section[aria-label="Cégadatok"]').count()) === 1 && (await page.locator('section[aria-label="Kapcsolati adatok"]').count()) === 1 && (await page.locator('section[aria-label="Nyilvántartási adatok"]').count()) === 1);
      const contactBlock = await page.locator('section[aria-label="Kapcsolati adatok"]').innerText();
      L("a kapcsolati személy adatai a cégadatlap felső részében láthatók", /Kapcsolat Kata/.test(contactBlock) && /\+36 1 555 0100/.test(contactBlock) && /Beosztás \/ szerepkör/.test(contactBlock), contactBlock);
      L("nincs külön „Kapcsolattartók” szekció és „Kapcsolattartó hozzáadása” gomb", (await page.locator("h2:has-text('Kapcsolattartók')").count()) === 0 && (await page.locator('button:has-text("Kapcsolattartó hozzáadása")').count()) === 0);
      L("nincs kötelező „Ügyvezető/Tulajdonos” szerep a felületen", (await page.locator("main >> text=/Ügyvezető|Tulajdonos/").count()) === 0);
      await checkPage(page, label, "/customers/new-company-profile", "céges adatlap");

      // Szerkesztés
      await page.click('button:has-text("Szerkesztés")');
      await page.getByLabel("Telefonszám").fill("+36 1 555 0777");
      await page.getByLabel("Beosztás / szerepkör (opcionális)").fill("Irodavezető");
      await page.getByLabel("Cégnév").fill("");
      await page.click('button:has-text("Mentés")');
      L("szerkesztés: üres cégnév hibát ad, az adat nem sérül", await page.locator("text=Cégnév megadása kötelező").first().isVisible());
      await page.getByLabel("Cégnév").fill("QA Teszt Kft. (szerk.)");
      await page.click('button:has-text("Mentés")');
      await settle(page);
      const after = await page.locator("main").innerText();
      L("az ügyféladatlap szerkeszthető és mentés után frissül", after.includes("QA Teszt Kft. (szerk.)") && after.includes("+36 1 555 0777") && after.includes("Irodavezető"));
      L("szerkesztés után továbbra is egyetlen kapcsolattartó-rekord (az elsődleges frissült)", (await storage(page)).contacts.filter((k) => k.companyId === companyUrl.split("/").pop()).length === 1);

      // Pipeline megjelenítés és több folyamat egy ügyfélnél
      await page.click('main button:has-text("Új folyamat") >> nth=0');
      await dlg(page).getByLabel("Folyamattípus").selectOption("inbound_inquiry");
      await dlg(page).getByLabel("Rövid megnevezés").fill("QA második folyamat");
      await dlg(page).locator('button[type=submit]').click();
      await settle(page);
      await ready(page, "/pipeline");
      L("pipeline: Megkeresésre vár (1), Új érdeklődés (2)", (await colCount(page, "Megkeresésre vár")) === 1 && (await colCount(page, "Új érdeklődés")) === 2, `${await colCount(page, "Megkeresésre vár")}/${await colCount(page, "Új érdeklődés")}`);
      L("pipeline: egy ügyfél több kártyával (két aktív folyamat)", (await page.locator("article:has-text('QA Teszt Kft.')").count()) === 2);
      L("pipeline: oszloponkénti darabszám látható", (await col(page, "Új érdeklődés").locator("header .rounded-full").first().innerText()).trim() === "2");
      const cardText = await page.locator("article:has-text('QA kimenő megkeresés')").innerText();
      L("kártya: ügyfél, folyamat, státusz, felelős, következő teendő, utolsó aktivitás", /QA Teszt Kft/.test(cardText) && /QA kimenő megkeresés/.test(cardText) && /Megkeresésre vár/.test(cardText) && /Felelős: Teszt Admin/.test(cardText) && /Következő teendő/.test(cardText) && /Utolsó aktivitás/.test(cardText), cardText);
      L("pipeline: két fázis fejléc (Kapcsolatépítés / Értékesítés)", (await page.locator("h2:has-text('Kapcsolatépítés')").count()) === 1 && (await page.locator("h2:has-text('Értékesítés')").count()) === 1);
      if (label === "desktop") {
        const scroll = await page.locator('[role=region][aria-label^="Értékesítési pipeline"]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
        L("desktop Kanban: vízszintesen görgethető, minden oszlop látható a tartalomban", scroll.sw > scroll.cw, JSON.stringify(scroll));
      } else {
        const scroll = await page.locator('[role=region][aria-label^="Értékesítési pipeline"]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
        L("mobil Kanban: vízszintesen görgethető a régión belül, az oldal nem", scroll.sw > scroll.cw);
      }
      await checkPage(page, label, "/pipeline", "pipeline kártyákkal");

      // Kártya -> ügyféladatlap, folyamat fókusz
      await page.locator("article:has-text('QA második folyamat') a").first().click();
      await page.waitForURL("**/customers/cust-*");
      await page.waitForSelector("li[id^=folyamat-]");
      await settle(page);
      const focusInfo = await page.evaluate(() => ({ id: document.activeElement?.id, hash: location.hash }));
      L("kártya → ügyféladatlap: a megfelelő folyamat fókuszált", focusInfo.hash.startsWith("#folyamat-") && focusInfo.id === focusInfo.hash.slice(1), JSON.stringify(focusInfo));
      L("a fókuszált folyamat a második folyamat", (await page.locator(`li[id="${focusInfo.id}"]`).innerText()).includes("QA második folyamat"));

      // Státuszváltás szinkron: adatlapról -> pipeline, pipeline-ból -> adatlap
      const procLi = page.locator(`li[id="${focusInfo.id}"]`);
      await procLi.locator('button:has-text("Státusz váltása")').click();
      await dlg(page).locator('button[type=submit]').click();
      await settle(page);
      await ready(page, "/pipeline");
      L("adatlapon váltott státusz azonnal látszik a pipeline-on", (await colCount(page, "Új érdeklődés")) === 1 && (await colCount(page, "Kapcsolatfelvétel folyamatban")) === 1);
      const card = page.locator("article:has-text('QA második folyamat')");
      await card.locator('button:has-text("Státusz váltása")').click();
      L("a státuszváltó modál a nyitott folyamat nevét kínálja és billentyűzettel elérhető", await dlg(page).locator("select").first().isVisible());
      await dlg(page).locator("select").first().selectOption("needs_assessment");
      await dlg(page).locator('button[type=submit]').click();
      L("előreugrás indoklás nélkül elutasítva a pipeline-ból is", await dlg(page).locator("text=Előreugráshoz indoklás szükséges").first().isVisible());
      await dlg(page).locator("select").first().selectOption("account_opening");
      await dlg(page).getByLabel("Indoklás").fill("Teszt: ugrás.");
      await dlg(page).locator('button[type=submit]').click();
      L("szolgáltatói mérföldkő igazolás nélkül elutasítva a pipeline-ból is", await dlg(page).locator("text=Szolgáltatói mérföldkő csak").first().isVisible());
      L("a mérföldkő-igazolás figyelmeztetése látható, számlaadat nem kérhető", (await dlg(page).locator("text=Ne rögzíts számlaszámot").first().isVisible()) && (await dlg(page).locator("input:not([type=checkbox])").count()) === 0);
      await dlg(page).locator("select").nth(1).selectOption("provider_notification");
      await dlg(page).getByRole("checkbox").check();
      await dlg(page).locator('button[type=submit]').click();
      await settle(page);
      L("pipeline-ban váltott státusz átmozgatja a kártyát (Számlanyitás folyamatban)", (await colCount(page, "Számlanyitás folyamatban")) === 1 && (await colCount(page, "Kapcsolatfelvétel folyamatban")) === 0);
      await page.locator("article:has-text('QA második folyamat') a").first().click();
      await page.waitForURL("**/customers/cust-*");
      await settle(page);
      L("a pipeline-ban váltott státusz az adatlapon is megjelenik, naplózva (szimulált mérföldkő)", (await page.locator("li[id^=folyamat-]:has-text('QA második folyamat') >> text=Számlanyitás folyamatban").first().isVisible()) && (await page.locator("#aktivitas li", { hasText: "Szimulált szolgáltatói mérföldkő: Számlanyitás folyamatban" }).first().isVisible()) && (await page.locator("#aktivitas li", { hasText: "Indok: Teszt: ugrás." }).first().isVisible()));

      // Pipeline keresés/szűrés + lezárt külön
      await ready(page, "/pipeline");
      await page.getByLabel(/Keresés/).fill("QAbejövő");
      await settle(page);
      L("pipeline keresés ügyfélnévre", (await page.locator("article").count()) === 1);
      await page.getByLabel(/Keresés/).fill("Kapcsolat");
      await settle(page);
      L("pipeline keresés a kapcsolati személy nevére is", (await page.locator("article").count()) >= 2);
      await page.getByLabel(/Keresés/).fill("");
      await page.getByLabel("Felelős").selectOption("user-2");
      await settle(page);
      L("pipeline felelős szerinti szűrés", (await page.locator("article").count()) === 0);
      await page.getByLabel("Felelős").selectOption("");
      await ready(page, "/customers");
      await page.locator("tbody tr:has-text('QAbejövő') a").click();
      await page.waitForSelector("li[id^=folyamat-]");
      await page.locator('li[id^=folyamat-] button:has-text("Lezárás")').click();
      await dlg(page).locator("select").first().selectOption("unreachable");
      await dlg(page).locator('button[type=submit]').click();
      await settle(page);
      await ready(page, "/pipeline");
      L("lezárt folyamat nem kártya a pipeline-on, hanem a lezártak között", (await page.locator("article:has-text('QAbejövő')").count()) === 0 && (await page.locator("summary:has-text('Lezárt folyamatok (1)')").count()) === 1);
      await page.locator("summary:has-text('Lezárt folyamatok')").click();
      L("a lezárt folyamat visszakereshető és az adatlapra visz", await page.locator("#lezart a:has-text('Bejövő érdeklődés')").first().isVisible());

      // Billentyűzet
      await ready(page, "/pipeline");
      const focusable = await page.locator("article a").first().evaluate((el) => (el.focus(), document.activeElement === el));
      L("billentyűzet: a kártya linkje fókuszálható", focusable);
      await page.keyboard.press("Enter");
      await page.waitForURL("**/customers/cust-*");
      L("billentyűzet: Enter megnyitja az ügyféladatlapot", true);
      await ready(page, "/");
      await page.keyboard.press("Tab");
      L("billentyűzet: skip link fókuszálható", await page.evaluate(() => document.activeElement?.textContent?.includes("Ugrás")));

      // Perzisztencia és munkamenet törlése
      await page.reload({ waitUntil: "networkidle" });
      await ready(page, "/customers");
      L("munkamenet-perzisztencia: a létrehozott ügyfelek frissítés után is megvannak", (await page.locator("tbody tr").count()) === 2);
      L("nincs konzolhiba", errors.length === 0, errors.slice(0, 3).join(" | "));
      page.once("dialog", (d) => d.accept());
      await page.click('button:has-text("Munkamenet törlése")');
      await settle(page);
      L("explicit „Munkamenet törlése” (megerősítéssel) üres CRM-et ad", await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible());
      await ctx.close();
    }

    // ============ B) Kapcsolattartók és hivatkozások megőrzése (több kapcsolattartós cég) ============
    {
      const data = snap({
        customers: [cust({ id: "cust-k3j9x0ab", type: "company", companyName: "Többkapcsolatos Kft.", email: "ceg@minta-ceg.example", phone: "+36 1 555 0200" })],
        contacts: [
          kont({ id: "kont-aaaa1111", companyId: "cust-k3j9x0ab", firstName: "Első", lastName: "Elsődleges", position: "Ügyvezető", phone: "+36 20 555 0001", email: "elso@minta-ceg.example", isPrimaryContact: true, createdAt: iso(-10) }),
          kont({ id: "kont-bbbb2222", companyId: "cust-k3j9x0ab", firstName: "Második", lastName: "Másik", position: "Pénzügy", phone: "+36 20 555 0002", createdAt: iso(-9) }),
          kont({ id: "kont-cccc3333", companyId: "cust-k3j9x0ab", firstName: "Harmadik", lastName: "Harmad", phone: "+36 20 555 0003", createdAt: iso(-8) }),
        ],
        processes: [proc({ id: "proc-dddd4444", customerId: "cust-k3j9x0ab", companyContactId: "kont-bbbb2222", title: "Pénzügyi egyeztetés", status: "contact_established" })],
        activities: [{ id: "act-eeee5555", customerId: "cust-k3j9x0ab", processId: "proc-dddd4444", companyContactId: "kont-bbbb2222", type: "call", occurredAt: iso(-2), summary: "Hívás a pénzügyi kapcsolattartóval.", recordedBy: "user-1" }],
      });
      const ctx = await newCtx(browser, vp, data);
      const page = await ctx.newPage();
      await ready(page, "/customers/cust-k3j9x0ab");
      const block = await page.locator('section[aria-label="Kapcsolati adatok"]').innerText();
      L("meglévő több kapcsolattartós cég: az elsődleges kapcsolati személy látszik", /Elsődleges Első/.test(block) && /Ügyvezető/.test(block) && /\+36 20 555 0001/.test(block), block);
      L("a további kapcsolattartók elérhetők külön modul nélkül", await page.locator("summary:has-text('További kapcsolattartók a cégnél (2)')").isVisible());
      await page.locator("summary:has-text('További kapcsolattartók')").click();
      L("a további kapcsolattartók adatai láthatók", (await page.locator("details:has-text('Másik Második')").first().isVisible()) && (await page.locator("details:has-text('Harmad Harmadik')").first().isVisible()));
      L("a kapcsolattartóhoz kötött aktivitás megjeleníti a kapcsolattartó nevét", await page.locator("#aktivitas li:has-text('Kapcsolattartó: Másik Második')").first().isVisible());
      await checkPage(page, label, "/customers/multi-contact", "több kapcsolattartós cég");
      // Elsődleges szerkesztése: azonosító és a többi kapcsolattartó megmarad
      await page.click('button:has-text("Szerkesztés")');
      await page.getByLabel("Telefonszám").fill("+36 20 555 0999");
      await page.click('button:has-text("Mentés")');
      await settle(page);
      let st = await storage(page);
      L("mentés után mind a 3 CompanyContact rekord megvan, azonosítók változatlanok", st.contacts.length === 3 && ["kont-aaaa1111", "kont-bbbb2222", "kont-cccc3333"].every((id) => st.contacts.some((k) => k.id === id)));
      L("a folyamat és az aktivitás kapcsolattartó-hivatkozása érvényes maradt", st.processes[0].companyContactId === "kont-bbbb2222" && st.activities[0].companyContactId === "kont-bbbb2222");
      L("az elsődleges telefonszáma frissült", st.contacts.find((k) => k.id === "kont-aaaa1111").phone === "+36 20 555 0999");
      // Másik kijelölése elsődlegesnek
      await page.locator("summary:has-text('További kapcsolattartók')").click();
      await page.locator('button[aria-label^="Másik Második kijelölése"]').click();
      await settle(page);
      st = await storage(page);
      const primaries = st.contacts.filter((k) => k.isPrimaryContact).map((k) => k.id);
      L("elsődlegesnek jelölés után pontosan egy elsődleges van, és a felület is azt mutatja", primaries.length === 1 && primaries[0] === "kont-bbbb2222" && /Másik Második/.test(await page.locator('section[aria-label="Kapcsolati adatok"]').innerText()));
      await ctx.close();
    }

    // ============ C) Tiltakozás megőrzése ============
    {
      const data = snap({
        customers: [cust({ id: "cust-r1r2r3r4", type: "individual", firstName: "Tiltó", lastName: "Teszt", displayName: "Teszt Tiltó", phone: "+36 30 555 0301", contactStatus: "archived", restriction: { kind: "objection", note: "Fiktív tiltakozás.", recordedAt: iso(-20), recordedBy: "user-1" } })],
      });
      const ctx = await newCtx(browser, vp, data);
      const page = await ctx.newPage();
      await ready(page, "/customers/cust-r1r2r3r4");
      L("tiltakozás: jól látható figyelmeztetés az adatlapon", await page.locator('[role=alert]:has-text("Tiltakozás rögzítve")').first().isVisible());
      await page.click('main button:has-text("Új folyamat") >> nth=0');
      await dlg(page).getByLabel("Folyamattípus").selectOption("outbound_outreach");
      await dlg(page).getByLabel("Rövid megnevezés").fill("tiltott");
      await dlg(page).locator('button[type=submit]').click();
      L("tiltakozás: a kimenő kapcsolatépítés indítása blokkolt", await dlg(page).locator("text=Kimenő kapcsolatépítés nem indítható").first().isVisible());
      await page.keyboard.press("Escape");
      await ready(page, "/customers");
      L("tiltakozás jelölés az ügyféllistán is látszik", await page.locator("tbody tr:has-text('Tiltakozás')").count() === 1);
      await ctx.close();
    }

    // ============ D) Korábbi demóadat biztonságos kezelése ============
    {
      const data = snap({
        customers: [
          cust({ id: "cust-1", type: "individual", firstName: "Demó", lastName: "Egy", displayName: "Egy Demó", phone: "+36 30 555 0401" }),
          cust({ id: "cust-2", type: "individual", firstName: "Demó", lastName: "Kettő", displayName: "Kettő Demó", phone: "+36 30 555 0402" }),
          cust({ id: "cust-k1l2m3n4", type: "individual", firstName: "Kézzel", lastName: "Létrehozott", displayName: "Létrehozott Kézzel", phone: "+36 30 555 0403" }),
        ],
        processes: [proc({ id: "proc-1", customerId: "cust-1", title: "Demó folyamat" })],
        tasks: [{ id: "task-q1w2e3r4", customerId: "cust-2", title: "Kézzel felvett feladat egy demó ügyfélnél", assigneeId: "user-1", dueAt: iso(2), status: "open", createdAt: iso(-1) }],
      });
      const ctx = await newCtx(browser, vp, data);
      const page = await ctx.newPage();
      await ready(page, "/customers");
      L("korábbi demóadat felismerve: értesítés, nincs csendes törlés", (await page.locator("text=korábbi, fiktív demóadat maradt (2 ügyfél)").first().isVisible()) && (await page.locator("tbody tr").count()) === 3);
      await page.click('button:has-text("Demóadat eltávolítása…")');
      L("törlés előtt jelzi a demó-tárolás korlátait", (await dlg(page).locator("text=sessionStorage").first().isVisible()) && (await dlg(page).locator("text=nem alkalmas valós ügyféladatok tárolására").first().isVisible()));
      L("jelzi, mi törlődik és mi marad (kézzel létrehozott rekorddal rendelkező demó ügyfél)", (await dlg(page).locator("text=Megmarad").first().isVisible()) && (await dlg(page).locator("strong", { hasText: "1" }).count()) >= 1);
      const [dl] = await Promise.all([page.waitForEvent("download"), dlg(page).locator('button:has-text("Exportálás")').click()]);
      L("törlés előtt az adat exportálható", dl.suggestedFilename().startsWith("jg-os-demo-v0.3-export"));
      await dlg(page).locator('button:has-text("Mégse")').click();
      L("„Mégse” után semmi nem törlődött", (await storage(page)).customers.length === 3);
      await page.click('button:has-text("Demóadat eltávolítása…")');
      await dlg(page).locator('button:has-text("Demóadat eltávolítása")').last().click();
      await settle(page);
      const st = await storage(page);
      const ids = st.customers.map((c) => c.id).sort();
      L("megerősítés után csak a tisztán demó ügyfél törlődött; a kézzel létrehozott és a kézzel bővített megmaradt", JSON.stringify(ids) === JSON.stringify(["cust-2", "cust-k1l2m3n4"]) && st.tasks.length === 1 && st.processes.length === 0, JSON.stringify(ids));
      L("a törlésről visszajelzés látszik", await page.locator("text=Demóadat eltávolítva: 1 ügyfél").first().isVisible());
      await ctx.close();
    }

    // ============ E) v0.1 adat érintetlen marad ============
    {
      const ctx = await browser.newContext({ viewport: vp });
      await ctx.addInitScript(() => { if (!sessionStorage.getItem("e2e-legacy")) { sessionStorage.setItem("jg-os-demo-v0.1", '{"customers":[{"id":"x"}]}'); sessionStorage.setItem("e2e-legacy", "1"); } });
      const page = await ctx.newPage();
      await ready(page, "/");
      L("v0.1 adat: értesítés látszik, a tár érintetlen, a CRM üres", (await page.locator("text=v0.1-es demóadat van").first().isVisible()) && (await page.evaluate(() => sessionStorage.getItem("jg-os-demo-v0.1"))) !== null && (await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible()));
      await ctx.close();
    }
  }
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} PASS${skipped ? `, ${skipped} SKIPPED (axe-core hiányzik)` : ""}`);
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.error("SCRIPT HIBA", e.message.split("\n").slice(0, 10).join("\n")); process.exit(2); });
