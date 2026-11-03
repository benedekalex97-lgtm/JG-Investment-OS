# JG Investment OS — v1.1

Belső, ügyfélközpontú CRM a JG Investment Plus Kft. számára: **ügyfél → Pipeline-státusz → a státuszhoz kötött feladatok**, napi feladatlistával, ügyféltörténettel, globális keresővel, Excel/CSV importtal és exporttal, valamint adminisztrációs Beállításokkal.
Tartós PostgreSQL-tárolás (Neon), Google-belépés, szerveroldali jogosultság (FORCE RLS + műveletszintű jogok).

## Állapot (2026-11-03)

| | |
|---|---|
| **Production** | v1.1 — `main` @ `2023e28` (PR #10 + PR #11), https://jg-investment-os.vercel.app |
| Előző éles verziók | v1.0 (`baf1e90`), v0.9 (`028e46d`) — Vercel rollback-jelöltek |
| Séma | A v1.1 alkalmazás a `0001`–`0009` migrációkat igényli; régebbi sémán `schema_outdated` (503) választ ad. |
| Belépés | Productionben kizárólag Google (OpenID Connect, PKCE, csak előre felvett, aktív felhasználó). |

- A GitHub alapértelmezett ága még a `feature/jg-os-foundation-v0.1` (a kézi Neon workflow-k miatt, lásd lent); az aktuális alkalmazáskód a `main`-en van.
- A korábbi, egymásra épülő PR-ek (#2, #6, #7, #8) tartalma már a `main`-ben van.
- Éles migráció, deployment, jogosultság-kiosztás és bármely kapcsoló bekapcsolása csak külön tulajdonosi jóváhagyással történik.

## Funkciók

### Napi CRM (v0.9, CRM-001–013)
- **Ügyfelek:** magánszemély és cég, kapcsolattartók, tartós ügyféljegyzetek; rögzített tiltakozás/megkeresési korlátozás mellett a kimenő megkeresés tiltott.
- **Pipeline:** alapból hét státusz (Feldolgozásra vár → Kapcsolatfelvétel → Kapcsolatépítés → Online/Személyes tárgyalás → Számlanyitás → Tőke elhelyezve, illetve Elvesztett); v1.1-től a Beállításokban bővíthető.
- **Feladatok:** egységes feladatmodál; lezárás **Sikeres / Sikertelen** gombbal és kötelező szöveges Outputtal; átidőzítés; újranyitás; lezáráskor opcionális következő feladat.
- **Mai feladataim:** a munkatárs nyitott feladatai budapesti nap szerint (Lejárt / Ma esedékes / Következő 7 nap / Határidő nélkül), opcionális csapatnézettel.
- **Előzmények** az adatlapon; **globális kereső** a fejlécben (név, cégnév, kapcsolattartó, telefonszám, e-mail).
- **Gyorsműveletek:** Hívás, E-mail, Új feladat. **Duplikáció-figyelmeztetés** új ügyfél felvitelekor.
- **Tesztügyfél eltávolítása** logikai törléssel, szerveroldali kapcsolóval (`JG_TEST_CUSTOMER_DELETE_ENABLED`, alapból ki).

### Adatkezelés (v1.0, CRM-014–020) — Beállítások › Adatkezelés
- **Import:** Excel (.xlsx) / CSV lépéses varázsló: oszlop-megfeleltetés, soronkénti validáció, előnézet, duplikáció-döntés, hibajegyzék, importnapló. Az importált ügyfél mindig „Feldolgozásra vár” státuszba kerül.
- **Véglegesítési kapu:** az import csak `JG_CUSTOMER_IMPORT_ENABLED=true`, ellenőrzött (`verified`) adatforrás és elfogadott nyilatkozat mellett ment adatot; kikapcsolt kapunál csak az előnézet működik. Alapból minden környezetben ki van kapcsolva.
- **Export:** szűrt CSV/XLSX ügyfélexport képletinjekció elleni védelemmel és exportnaplóval.
- **Fájlbiztonság:** makró, külső hivatkozás, XXE, zip-bomba és átnevezett fájl elutasítva; korlátok: 4 MB, 5000 sor, 50 oszlop.
- **Mentés:** titkosított (AES-256-GCM), integritás-ellenőrzött logikai mentés és izolált visszaállítás üres adatbázisba — csak az üzemeltetői CLI-ből.

### Beállítások (v1.1, SET-001–009)
- **Beállítások menü** jogosultság szerinti almenüvel és áttekintő oldallal.
- **Konfigurálható katalógusok:** Pipeline-státuszok, feladattípusok és feladat Input-opciók (új elem, átnevezés, sorrend húzással vagy billentyűzettel, szín, archiválás, újraaktiválás). A konfiguráció egyetlen forrása az adatbázis.
- **Védett rendszerelemek:** a hét beépített státusz (és a beépített feladattípusok, Input-opciók) nem archiválható, csak átnevezhető; a „Számlanyitás” és a „Tőke elhelyezve” neve zárolt. Az üzleti szabályok a státusz jelentéséhez kötöttek, ezért átnevezés után is érvényesek: korlátozott ügyfélnél nem választható kimenő megkeresési státusz, a „Tőke elhelyezve” igazolást igényel. Új státusz mindig egyszerű munkafolyamat-lépés.
- **Felhasználók és jogosultságok:** jogkiosztás a felületen (módosítás → előnézet → megerősítés); önjogosítás tiltva, az utolsó felhasználókezelő admin védett. Új fiók létrehozása továbbra is csak CLI-ből.
- **Változásnapló:** hozzáfűző, nem módosítható beállítási audit (régi → új érték, siker/elutasítás).

### Jogosultságok

| Jog | Mire ad lehetőséget |
|---|---|
| (nincs) | Napi CRM: ügyfelek, Pipeline, feladatok |
| `crm.customer.import` / `crm.import.history.read` | Import, importsablon / importelőzmények |
| `crm.customer.export` | Ügyféllista-export |
| `crm.settings.manage` | Pipeline-státuszok, feladattípusok, Input-opciók |
| `crm.users.manage` | Más felhasználók jogainak kiosztása és visszavonása |
| `crm.settings.audit.read` | Beállítási változásnapló |

Minden jogot a szerver kérésenként, frissen ellenőriz (fail-closed). A régi `users.role = 'admin'` nem ad jogot. Mentés, visszaállítás és migráció nem CRM-jog: csak a tulajdonosi kapcsolattal futó CLI-ből érhető el.

Nem része: befektetési tanácsadás, portfóliókezelés, K&H/Patria-szinkron, e-mail-küldés vagy Gmail-integráció, marketingautomatizáció, egyéni ügyfélmezők, értesítések, riportok.

## Helyi indítás

Node.js 22 szükséges.

```bash
npm install
cp .env.example .env.local          # JG_ENV=local, JG_PGLITE_DIR=.data/pg (helyi, fájl alapú PostgreSQL)
JG_USER_PASSWORD='<min. 12 karakter>' npm run db -- user:create egy@example.test "Teszt Egy"   # a dev szerver álljon le közben
JG_OPERATOR="helyi" npm run db -- permission:grant egy@example.test crm.settings.manage         # opcionális: Beállítások kipróbálása
npm run dev                         # http://localhost:3000
```

Helyben jelszavas belépés működik; `JG_ENV=production` vagy `JG_AUTH_MODE=google` mellett csak Google-belépés.

## Ellenőrzés és tesztek

```bash
npm run typecheck && npm run lint && npm test -- --run && npm run build
npm run e2e                                    # v0.6–v0.9 CRM + v1.0 adatkezelés (Playwright, saját szerverrel, ideiglenes adatbázissal)
node e2e/v1.1-settings.e2e.cjs                 # v1.1 Beállítások
node e2e/google-login.e2e.cjs                  # Google-belépés, fiktív OAuth-konfigurációval
JG_TEST_DATABASE_URL=postgres://…/postgres npm test -- --run   # valódi, izolált PostgreSQL ellen (eldobható adatbázisokkal)
```

A v1.1 kiadási futás: PGlite 425 sikeres / 20 kihagyott; natív PostgreSQL 18.4 és 18.6 (CI) 582/582; E2E: CRM 293/293, adatkezelés 69/69, Beállítások 93/93 (390–1440 px, axe WCAG 2.1 A/AA), Google-belépés 3/3. Kizárólag fiktív adattal.

## Környezeti változók

Sablon: `.env.example`. Valós érték soha nem kerülhet a repóba, és DB-/JG-változó nem lehet `NEXT_PUBLIC_` előtagú.

| Változó | Szerep |
|---|---|
| `JG_ENV` | Kötelező környezetcímke: `local` / `preview` / `production`; egyeznie kell az adatbázis `meta.environment` értékével. |
| `DATABASE_URL` | PostgreSQL kapcsolat (`sslmode=require`). Az alkalmazás a futási szerepkörrel csatlakozik, a CLI a tulajdonossal. |
| `JG_PGLITE_DIR` | Csak helyben: fájl alapú PostgreSQL könyvtár. Vercelen tilos. |
| `JG_AUTH_MODE`, `JG_APP_URL`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET` | Google-belépés (Productionben kötelező). |
| `JG_CUSTOMER_IMPORT_ENABLED` | Import véglegesítési kapuja; alapból ki, Productionben csak compliance-/DPO-jóváhagyás után kapcsolható be. |
| `JG_TEST_CUSTOMER_DELETE_ENABLED` | Tesztügyfél-eltávolítás; csak a pontos `true` kapcsolja be. |
| `JG_IMPORT_MAX_*`, `JG_IMPORT_PREVIEWS_PER_HOUR`, `JG_EXPORT_PER_HOUR` | Import/export korlátok felülírása (alapértékek: `docs/V1.0-DATA-OPERATIONS.md`). |
| `JG_OPERATOR`, `JG_CONFIRM_PRODUCTION` | CLI: üzemeltető neve a naplóhoz; éles műveletnél kötelező megerősítés (`yes`). |
| `JG_BACKUP_KEY_FILE` / `JG_BACKUP_KEY` | Mentési kulcs (32 bájt; kulcsfájl ajánlott, 0600, a mentésektől külön tárolva). |
| `JG_PRODUCTION_DB_HOSTS`, `JG_AUTO_MIGRATE` | Opcionális védelem / helyi automatikus migráció. |

## Üzemeltetés (`npm run db -- …`)

A parancsok a tulajdonosi kapcsolattal futnak (`DATABASE_URL`), és ellenőrzik az adatbázis környezetcímkéjét. Éles környezetben `JG_CONFIRM_PRODUCTION=yes` is kell.

| Parancs | Mit csinál |
|---|---|
| `status` / `migrate` | Sémaállapot / verziózott, additív migrációk futtatása |
| `user:create`, `user:set-password`, `user:activate`, `user:deactivate` | CRM-felhasználók kezelése (nincs önregisztráció) |
| `permission:grant`, `permission:revoke`, `permission:list` | CRM-jogok kiosztása, visszavonása, listája (`JG_OPERATOR` kell, naplózott) |
| `runtime-role:provision` | Legkisebb jogosultságú futási szerepkör létrehozása / jelszócsere |
| `customer:list-removed`, `customer:restore` | Logikailag eltávolított ügyfelek listája és auditált visszaállítása |
| `backup:keygen`, `backup`, `backup:inspect`, `backup:verify` | Mentési kulcs, titkosított mentés, metaadat és integritás ellenőrzése |
| `restore:check`, `restore` | Visszaállítás előfeltételeinek ellenőrzése; visszaállítás kizárólag üres, frissen migrált adatbázisba |

**Kiadási sorrend:** friss Neon ág/snapshot + titkosított mentés → `migrate` → deployment → jogosultság-kiosztás → füstteszt. A migrációk additívak, a korábbi alkalmazásverzió az újabb sémán is fut, ezért az alkalmazás-rollback (Vercel) séma-visszabontás nélkül lehetséges. A v1.1 séma-visszagörgetése (`scripts/sql/v1.1-schema-rollback.sql`) csak végső eset, külön jóváhagyással. Részletek: `docs/V1.1-ADMIN-SETTINGS.md` 17–19. és `docs/V1.0-DATA-OPERATIONS.md` 20–22. fejezet.

## Adatbázis-migrációk

| Migráció | Verzió | Tartalom |
|---|---|---|
| `0001_init` | v0.6 | Alapséma, `jg_app` szerepkör, FORCE RLS |
| `0002_google_auth` | v0.8 | Google-identitások, OAuth-folyamatok |
| `0003_task_outcome` | v0.9 | Feladatlezárás minősítése (Sikeres/Sikertelen) |
| `0004_test_customer_soft_delete` | v0.9 | Ügyfél logikai törlése |
| `0005_crm_data_permissions` | v1.0 | `user_permissions`, `app_has_permission()`, `ops_log` |
| `0006_crm_import_jobs` | v1.0 | Importnapló (`import_jobs`, `import_results`) |
| `0007_crm_settings_permissions` | v1.1 | Adminjogok, soft revoke, `settings_audit` |
| `0008_crm_config_catalogs` | v1.1 | Pipeline-, feladattípus- és Input-katalógusok |
| `0009_dynamic_crm_statuses` | v1.1 | Státusz/típus/Input mezők idegen kulccsal a katalógusokra |

## Deployment és CI

- **Vercel:** a `vercel.json` globálisan tiltja az automatikus Git-deploymentet; minden Preview/Production telepítés kézi, jóváhagyott lépés.
- **`qa-native-postgres.yml`:** a teljes tesztcsomag izolált, eldobható PostgreSQL 18.6 konténeren (titok és megosztott adatbázis nélkül); kézzel is indítható.
- **Neon Preview workflow-k** (csak kézi `workflow_dispatch`, rögzített commitot futtatnak, megerősítő szöveget kérnek):
  `jg-neon-preview-migration.yml` (séma / migráció), `jg-neon-preview-admin.yml` (pilot felhasználó), `jg-neon-preview-runtime-role.yml` (futási szerepkör; ez csak az alapértelmezett ágon van).
  A `workflow_dispatch` csak az alapértelmezett ágon (`feature/jg-os-foundation-v0.1`) lévő workflow-kkal indítható.

## Stack

Next.js 16 (App Router) + React 19 + TypeScript + Tailwind CSS v4 + Zod 4; PostgreSQL (`pg`, Neon; helyben és tesztben PGlite); Google OIDC (`openid-client`); Vitest + Playwright. Az XLSX/CSV/ZIP kezelés saját kód a Node `zlib` és `crypto` moduljaira építve (nincs külön táblázatkezelő függőség).

## Struktúra

| Réteg | Hely |
|---|---|
| Domain: típusok, beépített konfiguráció, státuszszabályok, validáció | `src/domain/types.ts`, `config.ts`, `constants.ts`, `workflow.ts`, `schemas.ts` |
| Domain: keresés, duplikáció, előzmények, import-validáció, budapesti idő | `src/domain/logic.ts`, `duplicates.ts`, `history.ts`, `data-import.ts`, `time.ts` |
| Közös tartományi műveletek (a szerver is ezt futtatja) | `src/data/repository.ts` |
| Kliens: távoli repository és store | `src/data/remote.ts`, `store.tsx` |
| Szerver: DB-meghajtók, migrációk, környezetcímke, futási szerepkör | `src/server/db/**` |
| Szerver: hitelesítés (Google, jelszó, munkamenet) | `src/server/auth/**` |
| Szerver: CRM-műveletek, API | `src/server/crm/**`, `src/server/http/**` |
| Szerver: import, export, fájlkezelés, jogok | `src/server/data/**` |
| Szerver: Beállítások (katalógusok, felhasználói jogok) | `src/server/settings/**` |
| Szerver: mentés, titkosítás, üzemeltetési napló, kapcsolók | `src/server/backup*.ts`, `ops-log.ts`, `features.ts` |
| Üzemeltetői CLI, séma-rollback | `scripts/db.ts`, `scripts/sql/v1.1-schema-rollback.sql` |
| UI-komponensek, app shell, globális kereső | `src/components/**` |
| Oldalak: Áttekintés, Ügyfelek, Pipeline, Beállítások (`/settings/**`) | `src/app/**` |
| Tesztek | `tests/**` (unit + szerver-integráció), `e2e/**` (böngésző) |

## Dokumentáció

Aktuális:
- `docs/V1.1-ADMIN-SETTINGS.md` — **v1.1 Beállítások: jogosultsági modell, katalógusok, rendszerstátuszok, migráció, mentés, release, rollback, nyitott döntések**
- `docs/V1.0-DATA-OPERATIONS.md` — **v1.0 import, export, jogosultságok, titkosított mentés és visszaállítás, adatvédelmi kapuk**
- `docs/V0.9-DAILY-OPERATIONS-COMPLETION.md`, `docs/V0.9-TASK-HISTORY-SEARCH.md` — v0.9 napi működés (CRM-001–013)
- `docs/V0.8-GOOGLE-PRODUCTION.md` — Google-belépés, éles környezet
- `docs/V0.6-PERSISTENCE.md` — architektúra, adatmodell, hitelesítés/RLS alapok
- `docs/V0.6.2-NEON-VERCEL.md`, `docs/V0.6.1-NEON-ACTIONS.md` — Neon Preview és Vercel előkészítés
- `e2e/README.md` — böngészős tesztek

Történeti (részben felülírva):
- `docs/V0.6-UX.md`, `docs/V0.6-CONTACTABILITY-AUDIT.md`, `docs/V0.5-SIMPLE-CRM.md`, `docs/V0.3-UX.md`, `docs/V0.2-WORKFLOW.md`
- `docs/DEMO-LIMITATIONS.md`, `docs/INTEGRATION-BOUNDARIES.md`, `docs/PRODUCTION-PLAN.md`
