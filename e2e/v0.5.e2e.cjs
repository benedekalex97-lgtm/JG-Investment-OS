/* eslint-disable @typescript-eslint/no-require-imports -- CommonJS futtatható szkript, nincs build-lépés */
/**
 * JG Investment OS v0.5 (egyszerű CRM: ügyfél → státusz → feladat) — E2E és akadálymentességi ellenőrzés (Playwright).
 *
 * Használat (a repó gyökeréből):
 *   npm run build && npx next start -p 3100 &      # éles build
 *   npm run e2e                                      # BASE_URL=http://localhost:3100
 *
 * Nincs új függőség: a Playwright-ot (és opcionálisan az axe-core-t) a környezetből oldja fel:
 *   require("playwright") -> PLAYWRIGHT_PATH -> /opt/node22/lib/node_modules/playwright
 *   axe-core: AXE_PATH vagy require.resolve("axe-core/axe.min.js"); ha nincs, az a11y lépések "SKIPPED"-ként jelennek meg
 *   (NEM sikeresként).
 * Minden teszt üres CRM-ből indul, kizárólag fiktív adatot használ, és a UI-n keresztül hozza létre az adatot. A régi
 * (v0.3) adatmodell megőrzését kézzel összeállított, fiktív snapshot injektálásával ellenőrzi.
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

const KEY = "jg-os-demo-v0.2"; // az adatmodell tárolókulcsa változatlan (a v0.5 ugyanazt a snapshotot használja)
const STATUSES = ["Kapcsolatfelvételre vár", "Kapcsolatfelvétel", "Kapcsolatépítés", "Online/Személyes tárgyalás", "Számlanyitás", "Tőke elhelyezve", "Elvesztett"];
const dlg = (page) => page.locator("dialog[open]");
const storage = (page) => page.evaluate((k) => { const r = sessionStorage.getItem(k); return r ? JSON.parse(r) : null; }, KEY);
const rawStorage = (page) => page.evaluate((k) => sessionStorage.getItem(k), KEY);
const statusSelect = (page) => page.getByLabel("Aktuális státusz");
async function ready(page, p) { await page.goto(BASE + p, { waitUntil: "networkidle" }); await page.waitForSelector("main h1"); }
const settle = (page) => page.waitForTimeout(350);
const pad = (n) => String(n).padStart(2, "0");
const dateInput = (offsetDays) => { const d = new Date(); d.setDate(d.getDate() + offsetDays); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`; };

// Kézzel összeállított (fiktív) régi (v0.2/v0.3) snapshot injektálása a böngészőtárba.
const iso = (d) => new Date(Date.now() + d * 86400000).toISOString();
const snap = (o) => ({ version: 2, customers: [], contacts: [], processes: [], activities: [], tasks: [], contactability: [], ...o });
const cust = (o) => ({ contactStatus: "prospect", ownerId: "user-1", source: "teszt", verificationStatus: "demo", createdAt: iso(-5), updatedAt: iso(-5), ...o });
const proc = (o) => ({ type: "outbound_outreach", status: "pending_outreach", closure: { state: "active" }, channel: "phone", source: "other", ownerId: "user-1", createdAt: iso(-3), updatedAt: iso(-3), ...o });
const kont = (o) => ({ isPrimaryContact: false, createdAt: iso(-4), updatedAt: iso(-4), ...o });
const legacyTask = (o) => ({ assigneeId: "user-1", status: "open", createdAt: iso(-3), ...o });
async function newCtx(browser, vp, injected) {
  const ctx = await browser.newContext({ viewport: vp, acceptDownloads: true });
  if (injected) await ctx.addInitScript(([k, v]) => { if (!sessionStorage.getItem("e2e-injected")) { sessionStorage.setItem(k, v); sessionStorage.setItem("e2e-injected", "1"); } }, [KEY, JSON.stringify(injected)]);
  return ctx;
}
async function checkPage(page, label, tag) {
  const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  log(`[${label}] ${tag}: nincs vízszintes oldalgörgetés`, overflow <= 0, `overflow=${overflow}`);
  if (axeSrc) {
    await page.evaluate(axeSrc);
    const v = await page.evaluate(async () => (await axe.run({ runOnly: ["wcag2a", "wcag2aa", "wcag21aa"] })).violations.map((x) => `${x.id}(${x.nodes.length}):${x.nodes[0].target}`));
    log(`[${label}] ${tag}: axe (WCAG A/AA)`, v.length === 0, v.join("; "));
  } else skip(`[${label}] ${tag}: axe`);
  await page.screenshot({ path: path.join(SHOTS, `${label}-${tag.replace(/[^a-z0-9]+/gi, "_")}.png`), fullPage: true });
}
async function addTask(page, title, due) {
  await page.click('button:has-text("+ Feladat hozzáadása")');
  await page.getByLabel(/Feladat megnevezése/).fill(title);
  if (due) await page.getByLabel(/Határidő \(opcionális\)/).fill(due);
  await page.click('form button[type=submit]:has-text("Feladat hozzáadása")');
  await settle(page);
}
const taskRow = (page, title) => page.locator("li", { has: page.getByRole("checkbox", { name: `Elvégezve: ${title}` }) }).first();
const col = (page, label) => page.locator(`section[aria-label^="${label} ("]`);

(async () => {
  const browser = await chromium.launch();
  for (const [label, vp] of [["desktop", { width: 1440, height: 900 }], ["mobile", { width: 390, height: 844 }]]) {
    const L = (n, ok, e) => log(`[${label}] ${n}`, ok, e);

    // ============ A) Üres CRM, első ügyfél, hét státusz, feladatok, pipeline ============
    {
      const ctx = await newCtx(browser, vp);
      const page = await ctx.newPage();
      const errors = [];
      page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
      page.on("pageerror", (e) => errors.push(String(e)));

      // 1. Üres CRM
      await ready(page, "/");
      L("üres CRM: az áttekintés üres állapotot mutat, statisztika nélkül", (await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible()) && (await page.locator("text=Mai feladatok").count()) === 0);
      await checkPage(page, label, "üres áttekintés");
      const navText = (await page.locator('nav[aria-label^="Fő navigáció"] a:visible').allTextContents()).map((t) => t.trim()).join("|");
      L("főmenü: Áttekintés / Pipeline / Ügyfelek", navText === "Áttekintés|Pipeline|Ügyfelek", navText);
      await ready(page, "/customers");
      L("üres ügyféllista: „Még nincs rögzített ügyfél.” és „+ Első ügyfél hozzáadása”", (await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible()) && (await page.locator('main a:has-text("+ Első ügyfél hozzáadása")').first().isVisible()));
      L("„+ Új ügyfél” gomb a fejlécben", await page.locator('main a:has-text("+ Új ügyfél")').first().isVisible());
      await checkPage(page, label, "üres ügyféllista");
      await ready(page, "/pipeline");
      L("üres pipeline: nincs kártya, üres állapot", (await page.locator("article").count()) === 0 && (await page.locator("text=Még nincs rögzített ügyfél.").first().isVisible()));
      const st0 = await storage(page);
      L("nincs automatikus fiktív seed a tárban", !st0 || st0.customers.length === 0);

      // 2. Magánszemély létrehozása (csak név), 3. cég létrehozása
      await ready(page, "/customers");
      await page.click('main a:has-text("+ Első ügyfél hozzáadása")');
      await page.waitForURL("**/customers/new");
      L("új ügyfél űrlap: nincs kezdő folyamat, felelős vagy folyamatválasztó mező", (await page.locator("text=/Kezdő folyamat|Folyamat indítása|Felelős/").count()) === 0);
      await page.click('button:has-text("Ügyfél létrehozása")');
      L("új ügyfél: a név kötelező, a telefon/e-mail nem", (await page.locator("text=Név megadása kötelező").first().isVisible()) && (await page.locator("text=/Telefonszám megadása kötelező/").count()) === 0);
      await page.getByLabel(/^Név/).fill("Minta Mária");
      await page.click('button:has-text("Ügyfél létrehozása")');
      await page.waitForURL("**/customers/cust-*");
      L("magánszemély létrejött telefon és e-mail nélkül, adatlap nyílt", await page.locator("h1:has-text('Minta Mária')").isVisible());
      const personUrl = page.url();
      L("alapértelmezett státusz: Kapcsolatfelvételre vár", (await statusSelect(page).inputValue()) === "waiting_for_contact" && (await statusSelect(page).locator("option:checked").innerText()) === "Kapcsolatfelvételre vár");
      const optLabels = (await statusSelect(page).locator("option").allTextContents()).map((t) => t.trim());
      L("pontosan hét státusz, a jóváhagyott sorrendben és megnevezéssel", JSON.stringify(optLabels) === JSON.stringify(STATUSES), optLabels.join("|"));
      const main = await page.locator("main").innerText();
      L("az adatlapon nincs folyamat-UI, állapotválasztó vagy kapcsolattartó modul", !/Új folyamat|Folyamatkártya|Kezdő folyamat|Állapot|Nyitott\b.*▾|Kapcsolattartók \(|Kapcsolattartó hozzáadása/.test(main) && (await page.locator("select", { hasText: "Nyitott" }).count()) === 0, main.slice(0, 300));
      L("az adatlap szerkezete: Ügyféladatok / Kapcsolati státusz / Feladatok", (await page.locator("h2:has-text('Ügyféladatok')").count()) === 1 && (await page.locator("h2:has-text('Kapcsolati státusz')").count()) === 1 && (await page.locator("h2:has-text('Feladatok — Kapcsolatfelvételre vár')").count()) === 1);
      await checkPage(page, label, "magánszemély adatlap");

      await ready(page, "/customers/new");
      await page.click("label:has-text('Cég')");
      await page.click('button:has-text("Ügyfél létrehozása")');
      L("cég: a cégnév kötelező", await page.locator("text=Cégnév megadása kötelező").first().isVisible());
      await page.getByLabel("Cégnév").fill("QA Teszt Kft.");
      await page.getByLabel("Kapcsolati személy neve (ha ismert)").fill("Kapcsolat Kata");
      await page.getByLabel("Beosztás / szerepkör (opcionális)").fill("Irodavezető");
      await page.getByLabel(/Telefonszám/).fill("+36 1 555 0100");
      await page.getByLabel(/Adatforrás/).fill("ajánlás");
      await page.click('button:has-text("Ügyfél létrehozása")');
      await page.waitForURL("**/customers/cust-*");
      const companyUrl = page.url();
      const details = await page.locator("#ugyfel").innerText();
      L("cég létrejött: cégnév, kapcsolati személy (szerep), telefon, adatforrás az adatlapon", /QA Teszt Kft\./.test(details) && /Kapcsolat Kata \(Irodavezető\)/.test(details) && /\+36 1 555 0100/.test(details) && /ajánlás/.test(details), details);
      L("nincs kötelező „Ügyvezető”/„Tulajdonos” szerep", (await page.locator("main >> text=/Ügyvezető|Tulajdonos/").count()) === 0);
      await checkPage(page, label, "céges adatlap");
      // szerkesztés
      await page.click('button:has-text("Szerkesztés")');
      await page.locator("#ugyfel").getByLabel("E-mail").fill("iroda@minta-ceg.example");
      await page.locator("#ugyfel").getByLabel("Cégnév").fill("");
      await page.click('button:has-text("Mentés")');
      L("szerkesztés: üres cégnév hibát ad", await page.locator("text=Cégnév megadása kötelező").first().isVisible());
      await page.locator("#ugyfel").getByLabel("Cégnév").fill("QA Teszt Kft. (szerk.)");
      await page.click('button:has-text("Mentés")');
      await settle(page);
      const edited = await page.locator("#ugyfel").innerText();
      L("az alapadatok szerkeszthetők, mentés után frissülnek", /QA Teszt Kft\. \(szerk\.\)/.test(edited) && /iroda@minta-ceg\.example/.test(edited));
      L("szerkesztés után egyetlen kapcsolattartói rekord marad (frissült, nem duplikálódott)", (await storage(page)).contacts.length === 1);

      // 4-6. Feladatok és státuszváltás a magánszemélynél
      await page.goto(personUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("main h1");
      await addTask(page, "Visszahívás");
      await addTask(page, "Bemutatkozó beszélgetés", dateInput(3));
      L("feladat hozzáadva (megnevezés kötelező, határidő opcionális), az aktuális státusz alatt", (await taskRow(page, "Visszahívás").isVisible()) && (await taskRow(page, "Bemutatkozó beszélgetés").innerText()).includes("Határidő:") && (await taskRow(page, "Visszahívás").innerText()).includes("Nincs határidő"));
      await page.click('button:has-text("+ Feladat hozzáadása")');
      await page.click('form button[type=submit]:has-text("Feladat hozzáadása")');
      L("feladat megnevezés nélkül hibát ad", await page.locator("text=Feladat címe megadása kötelező").first().isVisible());
      await page.click('form button:has-text("Mégse")');
      L("nincs külön feladat-állapotválasztó („Állapot: Nyitott” legördülő)", (await page.locator('main select option:text-is("Nyitott")').count()) === 0 && (await page.locator("text=/^Állapot/").count()) === 0);
      await taskRow(page, "Bemutatkozó beszélgetés").getByRole("checkbox").check();
      await settle(page);
      L("a feladat checkboxszal elvégezhető", await taskRow(page, "Bemutatkozó beszélgetés").getByRole("checkbox").isChecked());
      await taskRow(page, "Bemutatkozó beszélgetés").getByRole("checkbox").uncheck();
      await settle(page);
      L("a feladat visszanyitható", !(await taskRow(page, "Bemutatkozó beszélgetés").getByRole("checkbox").isChecked()));
      await taskRow(page, "Bemutatkozó beszélgetés").getByRole("checkbox").check();
      await settle(page);
      const stBefore = await storage(page);
      L("a feladat az ügyfélhez és az aktuális státuszhoz kötött (nincs folyamathoz kötés)", stBefore.tasks.every((t) => t.crmStatus === "waiting_for_contact" && !t.processId) && stBefore.tasks.length === 2);

      // státuszváltás: relationship
      await statusSelect(page).selectOption("relationship");
      await settle(page);
      L("státusz kézi módosítása; a feladatblokk az új státuszra vált", (await statusSelect(page).inputValue()) === "relationship" && (await page.locator("h2:has-text('Feladatok — Kapcsolatépítés')").count()) === 1);
      const stAfter = await storage(page);
      L("a státuszváltás nem töröl, nem pipál ki és nem hoz létre feladatot, nem hoz létre folyamatot", JSON.stringify(stAfter.tasks) === JSON.stringify(stBefore.tasks) && stAfter.processes.length === 0);
      L("korábbi státusz feladatai megőrizve, visszanézhetők, a nyitott jól látható", (await page.locator("summary:has-text('Korábbi státuszok feladatai')").isVisible()) && (await page.locator("summary:has-text('1 nyitott')").isVisible()) && (await page.locator('#korabbi-feladatok details').getAttribute("open")) !== null);
      L("a korábbi csoport a státusz nevével jelenik meg, a pipák állapota megmaradt", (await page.locator('section[aria-label="Korábbi státusz: Kapcsolatfelvételre vár"]').isVisible()) && (await taskRow(page, "Bemutatkozó beszélgetés").getByRole("checkbox").isChecked()) && !(await taskRow(page, "Visszahívás").getByRole("checkbox").isChecked()));
      L("új státusznál még nincs feladat; nem jött létre automatikusan", (await page.locator("text=Ennél a státusznál még nincs feladat").first().isVisible()));
      await addTask(page, "Következő egyeztetés");
      L("az új feladat az éppen aktuális státuszhoz kapcsolódik (státuszválasztás nélkül)", (await storage(page)).tasks.find((t) => t.title === "Következő egyeztetés").crmStatus === "relationship");
      await checkPage(page, label, "adatlap korábbi feladatokkal");
      await statusSelect(page).selectOption("meeting");
      await settle(page);
      L("nem lineáris váltás (ugrás) és két korábbi státusz csoportja", (await page.locator('section[aria-label^="Korábbi státusz:"]').count()) === 2 && (await page.locator("h2:has-text('Feladatok — Online/Személyes tárgyalás')").count()) === 1);
      await statusSelect(page).selectOption("waiting_for_contact");
      await settle(page);
      L("visszalépés: az egykori státusz feladatai újra az aktuálisak", await taskRow(page, "Visszahívás").isVisible() && (await page.locator("h2:has-text('Feladatok — Kapcsolatfelvételre vár')").count()) === 1);
      L("a státuszváltások naplózottak", (await storage(page)).activities.filter((a) => a.type === "crm_status_change").length === 3);

      // 8-9. Pipeline
      await ready(page, "/pipeline");
      const colLabels = (await page.locator('section[aria-label$=")"] h3').allTextContents()).map((t) => t.trim());
      L("pipeline: a hét státusz oszlopai, jóváhagyott sorrendben", JSON.stringify(colLabels) === JSON.stringify(STATUSES), colLabels.join("|"));
      L("pipeline: két ügyfél = két kártya, egy ügyfél egy kártya", (await page.locator("article").count()) === 2 && (await page.locator("article:has-text('Minta Mária')").count()) === 1);
      L("pipeline: a kártya az ügyfél státuszának oszlopában van, oszloponkénti darabszámmal", (await col(page, "Kapcsolatfelvételre vár").locator("article").count()) === 2 && (await col(page, "Kapcsolatfelvételre vár").locator("header .rounded-full").first().innerText()).trim() === "2");
      const card = await page.locator("article:has-text('Minta Mária')").innerText();
      L("kártya: ügyfél neve és a következő nyitott feladat", /Minta Mária/.test(card) && /Következő feladat: (Visszahívás|Következő egyeztetés)/.test(card), card);
      L("pipeline: nincs folyamat, fázis, drag-and-drop vagy státuszváltó a kártyán", (await page.locator("article button, article select").count()) === 0 && (await page.locator("h2:has-text('Kapcsolatépítés')").count()) === 0 && (await page.locator("[draggable=true]").count()) === 0);
      const region = await page.locator('[role=region][aria-label^="Pipeline"]').evaluate((el) => ({ sw: el.scrollWidth, cw: el.clientWidth }));
      L(label === "desktop" ? "desktop pipeline: vízszintesen görgethető táblanézet" : "mobil pipeline: vízszintesen görgethető a régión belül", region.sw > region.cw, JSON.stringify(region));
      await checkPage(page, label, "pipeline");
      await page.getByLabel(/Keresés/).fill("QA Teszt");
      await settle(page);
      L("pipeline keresés", (await page.locator("article").count()) === 1);
      await page.getByLabel(/Keresés/).fill("Kata");
      await settle(page);
      L("pipeline keresés a kapcsolati személy nevére is", (await page.locator("article:has-text('QA Teszt')").count()) === 1);
      await page.getByLabel(/Keresés/).fill("");
      // kártya -> adatlap -> státusz -> pipeline szinkron
      await page.locator("article:has-text('Minta Mária') a").click();
      await page.waitForURL("**/customers/cust-*");
      L("kártyára kattintva az ügyféladatlap nyílik", await page.locator("h1:has-text('Minta Mária')").isVisible());
      await statusSelect(page).selectOption("account_opening");
      await settle(page);
      await ready(page, "/pipeline");
      L("az adatlapon váltott státusz azonnal látszik a pipeline-on (egy kártya)", (await col(page, "Számlanyitás").locator("article:has-text('Minta Mária')").count()) === 1 && (await page.locator("article:has-text('Minta Mária')").count()) === 1);
      await page.locator("article:has-text('Minta Mária') a").click();
      await page.waitForURL("**/customers/cust-*");
      await statusSelect(page).selectOption("lost");
      await settle(page);
      await ready(page, "/pipeline");
      L("Elvesztett státusz: az ügyfél nem törlődik, a saját oszlopában marad", (await col(page, "Elvesztett").locator("article:has-text('Minta Mária')").count()) === 1);
      await ready(page, "/customers");
      L("az Elvesztett ügyfél az Ügyfelek listában is megvan", (await page.locator("tbody tr").count()) === 2 && (await page.locator("tbody tr:has-text('Minta Mária'):has-text('Elvesztett')").count()) === 1);
      await ready(page, "/customers");
      await page.getByLabel("Kapcsolati státusz").selectOption("lost");
      await settle(page);
      L("ügyféllista szűrés kapcsolati státuszra", (await page.locator("tbody tr").count()) === 1);

      // Tőke elhelyezve igazolási kontroll
      await page.goto(companyUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("main h1");
      await statusSelect(page).selectOption("capital_placed");
      L("„Tőke elhelyezve”: igazolási párbeszéd nyílik, a figyelmeztetés látható, számlaadat nem kérhető", (await dlg(page).locator("text=Ne rögzíts számlaszámot").first().isVisible()) && (await dlg(page).locator("input:not([type=checkbox])").count()) === 0);
      await dlg(page).locator('button[type=submit]').click();
      L("igazolás nélkül nem rögzíthető", await dlg(page).locator("text=csak igazolási forrással").first().isVisible());
      await dlg(page).locator("select").selectOption("provider_notification");
      await dlg(page).locator('button[type=submit]').click();
      L("a compliance tudomásulvétele nélkül nem rögzíthető", await dlg(page).locator("text=tudomásulvétele kötelező").first().isVisible());
      await page.keyboard.press("Escape");
      await settle(page);
      L("mégse esetén a státusz nem változott", (await statusSelect(page).inputValue()) === "waiting_for_contact");
      await statusSelect(page).selectOption("capital_placed");
      await dlg(page).locator("select").selectOption("provider_notification");
      await dlg(page).getByRole("checkbox").check();
      await dlg(page).locator('button[type=submit]').click();
      await settle(page);
      L("érvényes igazolással a „Tőke elhelyezve” rögzül", (await statusSelect(page).inputValue()) === "capital_placed");
      await page.locator("summary:has-text('Napló és korábbi adatok')").click();
      L("szimulált szolgáltatói mérföldkőként naplózva (forrás, szimulált jelzés)", await page.locator("#naplo li", { hasText: "Szimulált szolgáltatói mérföldkő: Tőke elhelyezve" }).first().isVisible());
      L("a „Tőke elhelyezve” után a státusz váltható marad (nincs zsákutca)", (await statusSelect(page).locator("option").count()) === 7);

      // Áttekintés adattal
      await page.goto(personUrl, { waitUntil: "networkidle" });
      await page.waitForSelector("main h1");
      await statusSelect(page).selectOption("waiting_for_contact");
      await addTask(page, "Mai teendő", dateInput(0));
      await addTask(page, "Lejárt teendő", dateInput(-2));
      await ready(page, "/");
      const ov = await page.locator("main").innerText();
      L("áttekintés: csak mai feladatok, lejárt feladatok és ügyfelek száma", /Mai feladatok/.test(ov) && /Lejárt feladatok/.test(ov) && /Ügyfelek/.test(ov) && !/Aktív folyamatok|Új érdeklődések|Számlanyitás|Pipeline/.test(ov), ov.slice(0, 200));
      L("áttekintés: a mai és a lejárt feladat itt is checkboxszal elvégezhető", (await taskRow(page, "Mai teendő").isVisible()) && (await taskRow(page, "Lejárt teendő").locator("text=Lejárt").first().isVisible()));
      await taskRow(page, "Lejárt teendő").getByRole("checkbox").click();
      await settle(page);
      L("az elvégzett lejárt feladat kikerül a lejártak közül", (await page.locator("li", { hasText: "Lejárt teendő" }).count()) === 0);
      await checkPage(page, label, "áttekintés adattal");

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

      // Perzisztencia, törlés
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

    // ============ B) Régi (v0.3) adatok megőrzése ============
    {
      const data = snap({
        customers: [
          cust({ id: "cust-k3j9x0ab", type: "company", companyName: "Régi Többkapcsolatos Kft.", email: "ceg@minta-ceg.example", phone: "+36 1 555 0200", contactStatus: "existing_verified" }),
          cust({ id: "cust-m4n5p6q7", type: "individual", firstName: "Béla", lastName: "Régi", displayName: "Régi Béla", phone: "+36 30 555 0300" }),
        ],
        contacts: [
          kont({ id: "kont-aaaa1111", companyId: "cust-k3j9x0ab", firstName: "Első", lastName: "Elsődleges", position: "Ügyvezető", phone: "+36 20 555 0001", isPrimaryContact: true, createdAt: iso(-10) }),
          kont({ id: "kont-bbbb2222", companyId: "cust-k3j9x0ab", firstName: "Második", lastName: "Másik", position: "Pénzügy", phone: "+36 20 555 0002", createdAt: iso(-9) }),
          kont({ id: "kont-cccc3333", companyId: "cust-k3j9x0ab", firstName: "Harmadik", lastName: "Harmad", createdAt: iso(-8) }),
        ],
        processes: [proc({ id: "proc-dddd4444", customerId: "cust-k3j9x0ab", companyContactId: "kont-bbbb2222", title: "Régi pénzügyi egyeztetés", status: "account_opening" })],
        tasks: [
          legacyTask({ id: "task-eeee5555", customerId: "cust-k3j9x0ab", processId: "proc-dddd4444", companyContactId: "kont-bbbb2222", title: "Régi nyitott feladat", dueAt: iso(2), status: "in_progress" }),
          legacyTask({ id: "task-ffff6666", customerId: "cust-k3j9x0ab", title: "Régi elvégzett feladat", dueAt: iso(-5), status: "done", completedAt: iso(-4) }),
        ],
        activities: [{ id: "act-gggg7777", customerId: "cust-k3j9x0ab", processId: "proc-dddd4444", companyContactId: "kont-bbbb2222", type: "call", occurredAt: iso(-2), summary: "Régi hívás a pénzügyi kapcsolattartóval.", recordedBy: "user-1" }],
      });
      const ctx = await newCtx(browser, vp, data);
      const page = await ctx.newPage();
      await ready(page, "/customers");
      const before = await rawStorage(page);
      L("régi adat: az ügyfelek megjelennek, nincs értesítés vagy törlés", (await page.locator("tbody tr").count()) === 2);
      L("régi adat: státusz nélküli ügyfelek az alapértelmezett státusszal olvashatók (nincs kitalált megfeleltetés)", (await page.locator("tbody tr:has-text('Kapcsolatfelvételre vár')").count()) === 2);
      await page.locator("tbody tr:has-text('Régi Többkapcsolatos') a").click();
      await page.waitForSelector("main h1");
      const d = await page.locator("#ugyfel").innerText();
      L("régi cég: az elsődleges kapcsolati személy az adatlap felső részében", /Elsődleges Első \(Ügyvezető\)/.test(d) && /\+36 1 555 0200/.test(d), d);
      await page.locator("summary:has-text('További kapcsolattartók')").click();
      L("a további kapcsolattartók elérhetők külön modul nélkül", (await page.locator("details:has-text('Másik Második')").first().isVisible()) && (await page.locator("details:has-text('Harmad Harmadik')").first().isVisible()));
      L("a régi (státusz nélküli) feladatok megmaradtak: nyitott jól látható, az elvégzett pipálva", (await page.locator("summary:has-text('1 nyitott')").isVisible()) && (await taskRow(page, "Régi nyitott feladat").isVisible()) && (await taskRow(page, "Régi elvégzett feladat").getByRole("checkbox").isChecked()) && !(await taskRow(page, "Régi nyitott feladat").getByRole("checkbox").isChecked()));
      L("a régi feladatok kitalált státusz nélkül, külön csoportban", await page.locator("section[aria-label='Státuszhoz nem rendelt (régi) feladatok']").isVisible());
      await page.locator("summary:has-text('Napló és korábbi adatok')").click();
      L("a régi folyamat csak olvasható archívumként látszik, a régi napló is", (await page.locator("#naplo li:has-text('Régi hívás')").first().isVisible()) && (await page.locator("#naplo >> text=Régi pénzügyi egyeztetés · Számlanyitás folyamatban").first().isVisible()));
      L("nincs folyamat-UI (új folyamat, státusz váltása, lezárás, újranyitás)", (await page.locator("button:has-text('Új folyamat'), button:has-text('Státusz váltása'), button:has-text('Lezárás'), button:has-text('Újranyitás')").count()) === 0);
      await checkPage(page, label, "régi adatú céges adatlap");
      L("megtekintés/navigáció nem írta át a tárolt adatot (nincs csendes módosítás)", (await rawStorage(page)) === before);
      // a felhasználó által kezdeményezett státuszváltás csak a státuszmezőt érinti
      await statusSelect(page).selectOption("meeting");
      await settle(page);
      const after = await storage(page);
      const orig = JSON.parse(before);
      L("státuszváltás a régi ügyfélnél: csak a státusz (és a napló) változik; folyamat, feladat, kapcsolattartó változatlan", JSON.stringify(after.processes) === JSON.stringify(orig.processes) && JSON.stringify(after.tasks) === JSON.stringify(orig.tasks) && JSON.stringify(after.contacts) === JSON.stringify(orig.contacts) && after.customers.find((c) => c.id === "cust-k3j9x0ab").crmStatus === "meeting" && after.customers.find((c) => c.id === "cust-m4n5p6q7").crmStatus === undefined);
      L("a régi négyértékű kapcsolati besorolás sem veszett el", after.customers.find((c) => c.id === "cust-k3j9x0ab").contactStatus === "existing_verified");
      await ctx.close();
    }

    // ============ C) Tiltakozás megőrzése ============
    {
      const data = snap({
        customers: [cust({ id: "cust-r1r2r3r4", type: "individual", firstName: "Tiltó", lastName: "Teszt", displayName: "Teszt Tiltó", phone: "+36 30 555 0301", restriction: { kind: "objection", note: "Fiktív tiltakozás.", recordedAt: iso(-20), recordedBy: "user-1" } })],
      });
      const ctx = await newCtx(browser, vp, data);
      const page = await ctx.newPage();
      await ready(page, "/customers/cust-r1r2r3r4");
      L("tiltakozás: jól látható figyelmeztetés az adatlapon és a listán/pipeline-on", await page.locator('[role=alert]:has-text("Tiltakozás rögzítve")').first().isVisible());
      await statusSelect(page).selectOption("contact");
      await settle(page);
      L("tiltakozás: a kimenő kapcsolatfelvételi státusz nem választható, a státusz nem változott", (await page.locator("text=Tiltakozás van rögzítve").first().isVisible()) && (await statusSelect(page).inputValue()) === "waiting_for_contact");
      await statusSelect(page).selectOption("lost");
      await settle(page);
      L("tiltakozás: más státusz (Elvesztett) választható", (await statusSelect(page).inputValue()) === "lost");
      await ready(page, "/pipeline");
      L("tiltakozás jelzése a pipeline-kártyán", (await page.locator("article:has-text('Tiltakozás')").count()) === 1);
      await ready(page, "/customers/cust-r1r2r3r4");
      await page.locator("summary:has-text('Megkeresési információk és korlátozás')").click();
      L("a megkeresési információk elérhetők, de összecsukva vannak alapból", (await page.locator("text=nem igazolja a megkeresés jogszerűségét").first().isVisible()) && (await page.locator("button:has-text('Korlátozás kezelése')").isVisible()));
      await ctx.close();
    }

    // ============ D) Korábbi demóadat (v0.2 seed) explicit kezelése ============
    {
      const data = snap({
        customers: [
          cust({ id: "cust-1", type: "individual", firstName: "Demó", lastName: "Egy", displayName: "Egy Demó", phone: "+36 30 555 0401" }),
          cust({ id: "cust-k1l2m3n4", type: "individual", firstName: "Kézzel", lastName: "Létrehozott", displayName: "Létrehozott Kézzel", phone: "+36 30 555 0403" }),
        ],
      });
      const ctx = await newCtx(browser, vp, data);
      const page = await ctx.newPage();
      await ready(page, "/customers");
      L("korábbi demóadat felismerve: értesítés, nincs csendes törlés", (await page.locator("text=korábbi, fiktív demóadat maradt").first().isVisible()) && (await page.locator("tbody tr").count()) === 2);
      await page.click('button:has-text("Demóadat eltávolítása…")');
      L("törlés előtt jelzi a demó-tárolás korlátait", (await dlg(page).locator("text=sessionStorage").first().isVisible()) && (await dlg(page).locator("text=nem alkalmas valós ügyféladatok tárolására").first().isVisible()));
      await dlg(page).locator('button:has-text("Mégse")').click();
      L("„Mégse” után semmi nem törlődött", (await storage(page)).customers.length === 2);
      await page.click('button:has-text("Demóadat eltávolítása…")');
      await dlg(page).locator('button:has-text("Demóadat eltávolítása")').last().click();
      await settle(page);
      const st = await storage(page);
      L("megerősítés után csak a demó ügyfél törlődött, a kézzel létrehozott megmaradt", JSON.stringify(st.customers.map((c) => c.id)) === JSON.stringify(["cust-k1l2m3n4"]));
      await ctx.close();
    }
  }
  await browser.close();
  const fails = results.filter((r) => !r.ok);
  console.log(`\n${results.length - fails.length}/${results.length} PASS${skipped ? `, ${skipped} SKIPPED (axe-core hiányzik)` : ""}`);
  process.exitCode = fails.length ? 1 : 0;
})().catch((e) => { console.error("SCRIPT HIBA", e.message.split("\n").slice(0, 10).join("\n")); process.exit(2); });
