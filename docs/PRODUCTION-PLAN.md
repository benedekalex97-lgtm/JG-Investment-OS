# Éles rendszerhez tervezett (NEM implementált) elemek
Hitelesítés · szerveroldali jogosultság (szerepkörök, adat-hozzáférési szabályok) · auditnapló · RLS (PostgreSQL) · mentés és visszaállítás · import staging · integrációs jogosultságok.
A `DataRepository` interfész (`src/data/repository.ts`) a csere pontja: perzisztens implementáció a UI módosítása nélkül adható hozzá; a jogosultság-ellenőrzésnek szerveroldalon kell megvalósulnia.

## v0.2-ben azonosított hiányosságok az éles rendszerhez
- **Hitelesítés/jogosultság:** a „rögzítő” a böngészőben kiválasztott demófelhasználó; szerveroldali azonosítás és szerepkörök nélkül a napló nem bizonyító erejű.
- **Auditnapló:** az Activity napló kliensoldali és módosítható; éles használathoz append-only, szerveroldali, idő- és felhasználóhoz kötött auditnapló kell.
- **Adatvédelem:** adatkezelési jogalap, megkeresési hozzájárulás/tiltakozás nyilvántartása, megőrzési idők, érintetti jogok kezelése, adatforrás-nyilvántartás.
- **Szolgáltatói integráció:** a mérföldkövek valós visszaigazolásához külön, jóváhagyott szolgáltatói adatátvétel és jogosultsági modell kell (nem épült).
- **Jogosultság a mérföldkövekhez:** ki rögzíthet/igazolhat szolgáltatói állapotot, kétszemélyes jóváhagyás szükségessége — üzleti/compliance döntés.
- **Perzisztens adatréteg és migráció**, RLS, mentés/visszaállítás, import staging (Trello), integrációs jogosultságok (JG Email System).
- Üzleti review: a státuszok, indokok és a „Későbbre halasztva” kezelése előzetes megnevezések (`constants.ts`).

## v0.5.1: megkereshetőség és tiltakozás kezelése
A v0.5.1 az ügyféladatlapról eltávolította a megkeresési panelt (UX-egyszerűsítés). A háttéradat és a kontrollok megmaradtak, de a felületről nem rögzíthető/oldható fel tiltakozás vagy korlátozás, és a megkereshetőségi mátrix nem szerkeszthető. Éles működéshez külön adatvédelmi és compliance review kell: a megkeresési jogalap és az adatforrás nyilvántartása, a tiltakozás/korlátozás rögzítésének és feloldásának jogosultsága és naplózása, valamint a megkeresési csatornák és célok kezelése.
