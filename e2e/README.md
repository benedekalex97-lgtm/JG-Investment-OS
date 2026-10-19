# E2E (Playwright) — v0.6–v0.9

```bash
npm run build
npm run e2e                      # saját szervert indít (E2E_PORT, alapértelmezés 3101) ideiglenes PGlite adatbázissal
```

- Az E2E saját `next start` szervert indít egy ideiglenes, fájl alapú helyi PostgreSQL (PGlite) könyvtárral, migrál, két fiktív pilot felhasználót hoz létre a `db` CLI-vel, majd Playwrighttal teszteli a felületet — beleértve a szerver teljes leállítását és újraindítását (tartósság), a második felhasználó közös nézetét, a hibakezelést (hálózati/500 hiba, duplikált küldés, lejárt munkamenet), a régi böngészős adat kezelését és a hiányzó adatbázis állapotát. Éles vagy külső adatbázishoz soha nem kapcsolódik.
- Nincs új függőség. A Playwrightot a környezetből keresi (`require("playwright")`, `PLAYWRIGHT_PATH`, majd a globális telepítés).
- Akadálymentesség (axe-core, WCAG 2.0/2.1 A és AA): `AXE_PATH` az `axe.min.js` fájlra, vagy telepített `axe-core`. Ha nincs, a lépések **SKIPPED**-ként jelennek meg, nem sikeresként.
- `e2e/restriction.ts`: teszt-segédszkript — egy már meglévő (fiktív) tiltakozási nyilvántartást szimulál az adatbázisban, a CRM felületén kívül.
- Nézetek: mobil 390 px, tablet 768 px, desktop 1280 és 1440 px. Képernyőképek: `e2e/shots/` (gitignore-olt).
- v0.9: Sikeres/Sikertelen lezárás kötelező szöveges Outputtal (A1–A10), adatmegőrzés (B1–B5), átidőzítés (C1–C5), Előzmények (D1–D8), globális kereső (E1–E9). A régi v0.8 adatok olvashatóságát (B6) az integrációs tesztek ellenőrzik (`tests/server/legacy.test.ts`).
- Google-belépés regresszió: `node e2e/google-login.e2e.cjs` (fiktív OAuth-konfiguráció, valódi Google-fiók nélkül).
- Integrációs tesztek valódi PostgreSQL ellen: `JG_TEST_DATABASE_URL=postgres://…/postgres npx vitest run tests/server` (admin jogú kapcsolat; teszt-adatbázist hoz létre és töröl).
