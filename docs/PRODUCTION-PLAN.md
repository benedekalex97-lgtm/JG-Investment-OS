# Éles rendszerhez tervezett (NEM implementált) elemek
Hitelesítés · szerveroldali jogosultság (szerepkörök, adat-hozzáférési szabályok) · auditnapló · RLS (PostgreSQL) · mentés és visszaállítás · import staging · integrációs jogosultságok.
A `DataRepository` interfész (`src/data/repository.ts`) a csere pontja: perzisztens implementáció a UI módosítása nélkül adható hozzá; a jogosultság-ellenőrzésnek szerveroldalon kell megvalósulnia.
