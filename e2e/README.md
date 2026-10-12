# E2E (Playwright) — v0.6

```bash
npm run build
npm run e2e                      # saját szervert indít (E2E_PORT, alapértelmezés 3101) ideiglenes PGlite adatbázissal
```

- Az E2E saját `next start` szervert indít egy ideiglenes, fájl alapú helyi PostgreSQL (PGlite) könyvtárral, migrál, két fiktív pilot felhasználót hoz létre a `db` CLI-vel, majd Playwrighttal teszteli a felületet — beleértve a szerver teljes leállítását és újraindítását (tartósság), a második felhasználó közös nézetét, a hibakezelést (hálózati/500 hiba, duplikált küldés, lejárt munkamenet), a régi böngészős adat kezelését és a hiányzó adatbázis állapotát. Éles vagy külső adatbázishoz soha nem kapcsolódik.
- Nincs új függőség. A Playwrightot a környezetből keresi (`require("playwright")`, `PLAYWRIGHT_PATH`, majd a globális telepítés).
- Akadálymentesség (axe-core, WCAG 2.0/2.1 A és AA): `AXE_PATH` az `axe.min.js` fájlra, vagy telepített `axe-core`. Ha nincs, a lépések **SKIPPED**-ként jelennek meg, nem sikeresként.
- `e2e/restriction.ts`: teszt-segédszkript — egy már meglévő (fiktív) tiltakozási nyilvántartást szimulál az adatbázisban, a CRM felületén kívül.
- Desktop: 1440 px, mobil: 390 px. Képernyőképek: `e2e/shots/` (gitignore-olt).
- Integrációs tesztek valódi PostgreSQL ellen: `JG_TEST_DATABASE_URL=postgres://…/postgres npx vitest run tests/server` (admin jogú kapcsolat; teszt-adatbázist hoz létre és töröl).
