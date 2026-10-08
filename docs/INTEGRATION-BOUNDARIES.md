# Integrációs határfelületek (csak dokumentáció — semmi nem implementált)

## JG Email System (későbbi)
Tervezett folyamat: **CRM → jóváhagyott sablon → Gmail draft létrehozása → ellenőrzött eredmény → CRM kommunikációs esemény.**
- A draft létrehozása nem azonos az elküldéssel; a rendszer nem küld automatikusan e-mailt.
- Helye: `DataRepository` mellett egy külön `CommunicationGateway` port (pl. `createDraft(customerOrContactId, templateId)`), amely a JG Email System API-ját hívja szerveroldalon.
- Előfeltétel: a `Contactability` rekord (purpose × channel) `allowed` + igazolt bizonyíték — e nélkül a gateway nem hívható. A visszatérő eredmény `Activity` (type: `follow_up`/`note`) rekordként tárolódik.
- A JG-Email-System repository ebben a fázisban nem lett módosítva és nem lett auditálva; a pontos határfelület az emailintegrációs feasibility gate (JG-OS-D01) tárgya.

## Trello-migráció (későbbi, külön fejlesztési és compliance-kapu)
Az adatmodell importálhatóságát az alábbiak biztosítják; import nem készült.
- `Customer.source` és `verificationStatus` az eredet és az ellenőrzöttség rögzítésére.
- Személy/cég szétválasztás, kapcsolattartók külön entitásként (a Trello-kártyák leírásából parszolt adatokhoz).
- `Contactability.evidenceStatus` az ellenőrzendő megkereshetőségi bizonyítékokhoz; alapértelmezés `unknown`.
- Javasolt: külön import staging tábla + `externalId`/`sourceRef` mező (a stabil Trello-azonosító megléte még ellenőrizetlen), emberi jóváhagyás az éles táblákba írás előtt.
