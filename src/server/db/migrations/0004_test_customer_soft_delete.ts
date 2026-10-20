import type { Migration } from "../migrate";

/**
 * 0004 - tesztfázisban létrehozott ügyfél logikai (visszaállítható) eltávolítása (v0.9, CRM-006). Kizárólag additív.
 *
 * - `customers.deleted_at` / `deleted_by`: ha ki vannak töltve, az ügyfél nem része az aktív CRM-nek (a snapshot nem tartalmazza, és
 *   rajta vagy a kapcsolódó feladatain semmilyen művelet nem hajtható végre). A rekord és minden kapcsolódó adat (kapcsolattartók,
 *   feladatok, Outputok, jegyzetek, napló, audit) a táblákban változatlanul megmarad; a visszaállítás a két mező kiürítése.
 * - A két mező csak együtt tölthető ki (CHECK). Fizikai törlés továbbra sincs: a `jg_app` szerepkörnek nincs DELETE joga.
 * - A meglévő RLS-szabályok és tábla-szintű jogok változatlanok (a `jg_app` UPDATE joga az új oszlopokra is vonatkozik).
 */
const sql = `
alter table customers add column deleted_at timestamptz;
alter table customers add column deleted_by text references users(id);
alter table customers add constraint customers_soft_delete_chk check ((deleted_at is null) = (deleted_by is null));
create index customers_active_idx on customers(created_at desc) where deleted_at is null;
`;

export const migration0004: Migration = { id: "0004_test_customer_soft_delete", description: "Tesztügyfél logikai, visszaállítható eltávolítása (deleted_at, deleted_by)", sql };
