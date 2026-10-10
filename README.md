# JG Investment OS — v0.3 (DEMÓ)

Belső, ügyfélközpontú CRM-demó a JG Investment Plus Kft. számára: ügyféladatlap, kapcsolatépítési és értékesítési folyamatok, naplózott aktivitás.
**Csak demó: kizárólag fiktív adatok, nincs éles adatbázis, hitelesítés, integráció vagy deployment.**

## Indítás
```bash
npm install
npm run dev          # http://localhost:3000
npm run typecheck && npm run lint && npm test -- --run && npm run build
npm run e2e          # Playwright E2E (lásd e2e/README.md)
```

## Stack és indoklás
Next.js (App Router) + TypeScript + Tailwind CSS v4 + Zod 4 + Vitest — az AxFlow OS-sel azonos, bevált stack,
így a későbbi éles réteg (hitelesítés, szerveroldali jogosultság) ugyanazokkal a mintákkal építhető.

## Struktúra
| Réteg | Hely |
|---|---|
| Domain típusok, konstansok (konfigurálható státuszcímkék) | `src/domain/types.ts`, `constants.ts` |
| Folyamat-állapotátmenetek, igazolási és lezárási szabályok | `src/domain/workflow.ts` |
| Validációs sémák (Zod) | `src/domain/schemas.ts` |
| Üzleti logika (keresés, kapcsolati validáció, dashboard-szelektorok) | `src/domain/logic.ts` |
| Adat-hozzáférési absztrakció + demó implementáció | `src/data/repository.ts` |
| Fiktív seed | `src/data/seed.ts` |
| Demó store (React) | `src/data/store.tsx` |
| UI-komponensek, app shell | `src/components/**` |
| Oldalak | `src/app/**` |

## Dokumentáció
- `docs/V0.3-UX.md` — v0.3: Pipeline, üres CRM, egyszerűsített ügyfél- és cégadatlap
- `docs/V0.2-WORKFLOW.md` — v0.2 modell, státuszok és üzleti szabályok
- `docs/DEMO-LIMITATIONS.md` — demókorlátok (olvasd el!)
- `docs/INTEGRATION-BOUNDARIES.md` — JG Email System és Trello-import későbbi határfelületei (nem implementált)
- `docs/PRODUCTION-PLAN.md` — a későbbi éles rendszerhez tervezett, most NEM implementált elemek
