# JG Investment OS — v0.6 (pilot, tartós adattárolással)

Egyszerű, ügyfélközpontú CRM-demó a JG Investment Plus Kft. számára: **ügyfél → kapcsolati státusz (hét érték) → a státuszokhoz kapcsolt feladatok**, egyszerű Pipeline-nézettel.
**v0.6:** tartós PostgreSQL-tárolás, bejelentkezés, szerveroldali jogosultság (RLS), Input/Output legördülők, jobb oldali kapcsolati adatok sáv.
**Állapot: „Implementáció elkészült, tartós infrastruktúra összekötésre vár.”** Nincs jóváhagyott külső adatbázis-szolgáltató; éles használatra nem kész; kizárólag fiktív adat. Lásd `docs/V0.6-PERSISTENCE.md`.

## Indítás
```bash
npm install
cp .env.example .env.local                 # JG_ENV=local, JG_PGLITE_DIR=.data/pg (helyi, fájl alapú PostgreSQL)
JG_USER_PASSWORD='<min. 12 karakter>' npm run db -- user:create egy@example.test "Teszt Egy"   # a szervert előtte állítsd le
npm run dev          # http://localhost:3000  (adatbázis nélkül: „Tartós infrastruktúra összekötésre vár”)
npm run typecheck && npm run lint && npm test -- --run && npm run build
npm run e2e          # Playwright E2E, saját szerverrel és ideiglenes adatbázissal (lásd e2e/README.md)
```

## Adatvédelem és adatbiztonság (v1.3)
Beállítások › **Adatvédelem** (`crm.privacy.manage`; végleges törléshez külön `crm.privacy.erase`), részletek: `docs/V1.3-DATA-PROTECTION.md`.
- **Érintetti kérelmek** (GDPR 15-21. cikk) nyilvántartása 1 hónapos határidővel, egyszeri meghosszabbítással, azonosítás-jelöléssel; lezárt kérelem végleges.
- **Adatkivonat** (hozzáférés / hordozhatóság): az érintett összes CRM-adata JSON-ban, adatkezelési tájékoztatóval; minden letöltés naplózott.
- **Tiltakozás / korlátozás rögzítése**; **végleges törlés (anonimizálás)** minden táblában egy tranzakcióban, beírt megerősítéssel; az anonimizált ügyfél nem állítható vissza.
- **Tiltólista**: a törölt / tiltakozó érintett elérhetőségének lenyomata — az import elutasítja, kézi felvitelt csak adatvédelmi jog mellett, naplózott megerősítéssel enged.
- **Megőrzés**: felülvizsgálandó (inaktív / régen eltávolított) ügyfelek listája; technikai adatok törlése CLI-ből.
- **Biztonsági fejlécek** (CSP, HSTS, COOP/CORP), Next.js 16.4.6 / Zod 4.6.7 (ismert sérülékenységek javítva).

```bash
npm run db -- retention:report                                          # lejárt technikai rekordok (előnézet)
JG_OPERATOR="<üzemeltető>" npm run db -- retention:run                  # ... törlése (élesben JG_CONFIRM_PRODUCTION=yes)
npm run db -- privacy:ledger <fájl>                                     # anonimizált ügyfelek azonosítói (a mentések mellé)
JG_OPERATOR="<üzemeltető>" npm run db -- privacy:reapply <fájl> <e-mail> # régebbi mentés visszaállítása után: újra-anonimizálás
npm run e2e:privacy                                                     # böngészős E2E (build után)
```

## Stack és indoklás
Next.js (App Router) + TypeScript + Tailwind CSS v4 + Zod 4 + Vitest — az AxFlow OS-sel azonos, bevált stack,
így a későbbi éles réteg (hitelesítés, szerveroldali jogosultság) ugyanazokkal a mintákkal építhető.

## Struktúra
| Réteg | Hely |
|---|---|
| Domain típusok, konstansok (konfigurálható státuszcímkék) | `src/domain/types.ts`, `constants.ts` |
| Státuszváltás-szabályok (v0.5), régi folyamat-szabályok | `src/domain/workflow.ts` |
| Validációs sémák (Zod) | `src/domain/schemas.ts` |
| Üzleti logika (keresés, kapcsolati validáció, dashboard-szelektorok) | `src/domain/logic.ts` |
| Tartományi műveletek (közös szabályok; a szerver is ezt futtatja) | `src/data/repository.ts` |
| Kliens: távoli repository és store | `src/data/remote.ts`, `store.tsx` |
| Szerver: DB-meghajtók, migrációk, RLS, auth, műveletek, API, mentés | `src/server/**`, `scripts/db.ts` |
| Fiktív seed (csak tesztek) | `src/data/seed.ts` |
| UI-komponensek, app shell | `src/components/**` |
| Oldalak | `src/app/**` |

## Dokumentáció
- `docs/V1.3-DATA-PROTECTION.md` — **v1.3: adatvédelem (GDPR) - érintetti kérelmek, adatkivonat, tiltakozás, végleges törlés, tiltólista, megőrzés, biztonsági fejlécek; adatleltár, 30. cikk szerinti nyilvántartás-tervezet, incidenskezelés, nyitott DPO-döntések**
- `docs/V1.2-ACQUISITION-CHANNELS.md` — **v1.2: érkezési csatorna az ügyfelekhez (katalógus, kötelező választás kézi felvételnél, szűrés, export/import, Csatornák kimutatás); a `source` és a csatorna különbsége; migráció és rollback; következő lépések**
- `docs/V1.1-ADMIN-SETTINGS.md` — **v1.1: Beállítások - konfigurálható Pipeline-státuszok, feladattípusok, Input-opciók; felhasználói jogok; változásnapló; migráció, mentés, rollback**
- `docs/V0.6.2-NEON-VERCEL.md` — **v0.6.2: Neon preview + Vercel előkészítés, környezeti változók, első admin, futási szerepkör, Vercel hozzáférés állapota**
- `docs/V0.6.1-NEON-ACTIONS.md` — a Neon preview migráció GitHub Actionsből
- `docs/V0.6-PERSISTENCE.md` — **v0.6: architektúra-döntés, adatmodell, hitelesítés/jogosultság, migrációk, mentés/helyreállítás, környezetek, beállítási útmutató, blokkolók**
- `docs/V0.6-CONTACTABILITY-AUDIT.md` — a régi megkereshetőségi rendszer auditja és a szükséges minimális folyamat
- `docs/V0.5-SIMPLE-CRM.md` — v0.5 és v0.5.1: egyszerű modell, hét státusz, státuszhoz kötött feladatok (Input/Output), régi adatok kompatibilitása
- `docs/V0.3-UX.md` — v0.3 (részben felülírva): üres CRM, demóadat-eltávolítás, Pipeline (folyamat-alapú, v0.5-ben ügyfélstátusz-alapúra egyszerűsítve)
- `docs/V0.2-WORKFLOW.md` — v0.2 modell, státuszok és üzleti szabályok
- `docs/DEMO-LIMITATIONS.md` — demókorlátok (olvasd el!)
- `docs/INTEGRATION-BOUNDARIES.md` — JG Email System és Trello-import későbbi határfelületei (nem implementált)
- `docs/PRODUCTION-PLAN.md` — a későbbi éles rendszerhez tervezett, most NEM implementált elemek
