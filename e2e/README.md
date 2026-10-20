# E2E (Playwright) — v0.6–v1.0 (CRM-001–020)

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
- v0.9 napi működés (CRM-006–013): feladatmodál, következő feladat, Mai feladataim, gyorsműveletek, telefon/e-mail keresés, duplikáció-figyelmeztetés, tesztügyfél eltávolítása (az újraindított szerver `JG_TEST_CUSTOMER_DELETE_ENABLED=true` kapcsolóval fut). Minden böngészőkontextus `Europe/Budapest` időzónában.
- Google-belépés regresszió: `node e2e/google-login.e2e.cjs` (fiktív OAuth-konfiguráció, valódi Google-fiók nélkül).
- Integrációs tesztek valódi PostgreSQL ellen: `JG_TEST_DATABASE_URL=postgres://…/postgres npx vitest run tests/server` (admin jogú kapcsolat; teszt-adatbázist hoz létre és töröl).
- v1.0 Adatkezelés (CRM-014–018): `node e2e/v1.0-data.e2e.cjs` (az `npm run e2e` mindkét csomagot futtatja; külön: `npm run e2e:data`). Saját szerver az `E2E_DATA_PORT` (alapértelmezés 3201) porton, ideiglenes PGlite adatbázissal; a jogokat az üzemeltetői CLI osztja ki és vonja vissza. Munkatárs-tiltás (felület + API), teljes importvarázsló (sablon, előnézet, hibajegyzék, döntés, véglegesítés), importelőzmények, CSV/XLSX export, jogvisszavonás a meglévő munkamenetre, 390/768/1280/1440 px nézetek és axe (WCAG A/AA).
