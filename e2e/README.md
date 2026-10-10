# E2E (Playwright) — v0.3

```bash
npm run build && npx next start -p 3100 &
npm run e2e                      # BASE_URL=http://localhost:3100
```

- Nincs új függőség. A Playwrightot a környezetből keresi (`require("playwright")`, `PLAYWRIGHT_PATH`, majd a globális telepítés).
- Az akadálymentességi ellenőrzéshez (axe-core, WCAG 2.0/2.1 A és AA) add meg az `AXE_PATH` környezeti változót az `axe.min.js` fájlra, vagy telepítsd az `axe-core`-t. Ha nincs, a lépések **SKIPPED**-ként jelennek meg, nem sikeresként.
- Minden teszt üres CRM-ből indul, a UI-n keresztül hoz létre fiktív adatot; a megőrzési és demóadat-eltávolítási tesztekhez kézzel összeállított, fiktív v0.2 snapshotot injektál a `sessionStorage`-ba.
- Desktop: 1440 px, mobil: 390 px. Képernyőképek: `e2e/shots/` (gitignore-olt).
