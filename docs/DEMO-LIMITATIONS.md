# Demókorlátok — v0.2

- **Adatmegőrzés:** a módosítások a böngészőfül `sessionStorage`-ában élnek; frissítést túlélnek, a fül bezárásakor elvesznek. Nincs szerveroldali mentés, backup. A felület is jelzi ("DEMÓ" sáv, visszaállítás gomb).
- **Nincs hitelesítés és jogosultság:** a két "Admin" fiktív felhasználó (`DEMO_USERS`), a közös csapatnézet nem jogosultság-érvényesítés, és nem írhatja felül a később meghatározandó adatkezelési/hozzáférési szabályokat. Alkalmazásszintű Admin ≠ infrastruktúra-/adatbázis-/Gmail-admin.
- **Megkereshetőség:** alapértelmezett `unknown`; az "engedélyezett" érték fiktív tesztállapot, nem jogi igazolás. Ügyfélstátusz vagy korábbi kapcsolat nem marketingengedély. Nincs automatikus megkeresés.
- **Szolgáltatói mérföldkövek (számlanyitás folyamatban, számla megnyitva, első pénzelhelyezés igazolt):** a demóban kézzel rögzített, SZIMULÁLT állapotok. Nincs K&H/Patria szinkron vagy API, nem ellenőrizhető a valóságban; a CRM nem helyettesíti a szolgáltató nyilvántartását, nem tárol számlaszámot, egyenleget vagy tranzakciós bizonylatot. A manuális igazolás (forráskategória + compliance tudomásulvétel) csak a demó folyamatát mutatja, jogosultságot nem igazol.
- **Kapcsolati státusz (igazolt meglévő/korábbi ügyfél):** a besorolás kézi, naplózott demóművelet; nem igazolt szolgáltatói ügyfélstátusz.
- **Megkeresési jogalap, adatforrás, tiltakozás:** a felület csak jelzi az ellenőrzés szükségességét és rögzíti a tiltakozást/korlátozást; a jogszerűséget nem vizsgálja, a kontaktadatbázisban szereplés nem igazol jogalapot. Nincs automatikus megkeresés, hideghívás vagy e-mail-küldés.
- **v0.1 adat:** nincs automatikus migráció (lásd `docs/V0.2-WORKFLOW.md`); a régi adat érintetlen marad, exportálható vagy törölhető.
- **Státuszok és pipeline-szakaszok:** előzetes, üzletileg még nem jóváhagyott megnevezések (`src/domain/constants.ts`), nem jogi vagy szolgáltatói ügyfélstátusz-igazolások; nem sugallnak JG-hatáskört.
- **Tevékenységek:** belső demórekordok; nincs telefon-, Google Calendar- vagy Gmail-kapcsolat.
- **Nincs:** Trello-kapcsolat/import, JG Email System integráció, éles adat, production deployment, auditnapló, RLS, import staging.
- **Nem épült:** befektetési ajánlás, portfóliókezelés, hozamszámítás, ügyfélpénz-kezelés, értékpapír-nyilvántartás, MiFID/KYC, marketingautomatizáció.
- **Keresés/lista:** kliensoldali, kis adatmennyiségre; nincs lapozás. Az ügyfél-törlés nincs (csak archivált státusz).
- A JG és a Patria Finance Magyarországi Fióktelepe (K&H Értékpapír) viszonyára vonatkozó tartalom nem szerepel a felületen; a függő ügynöki szerep pontos megfogalmazása jogi/compliance review tárgya.
