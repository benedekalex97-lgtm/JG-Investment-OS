import type { Db } from "./db/types";

/**
 * Adminisztratív visszaállítás (CRM-006): a logikailag eltávolított ügyfél visszakerül az aktív CRM-be. Csak a tulajdonosi kapcsolattal
 * futó `npm run db -- customer:restore` parancs hívja; az alkalmazás felületén nincs visszaállítás. Adatot nem töröl és nem ír felül:
 * kizárólag a `deleted_at` / `deleted_by` mezőket üríti, és auditbejegyzést hoz létre a megadott (aktív) üzemeltetővel.
 */
export async function restoreCustomer(db: Db, customerId: string, operatorEmail: string): Promise<{ restored: boolean }> {
  return db.system(async (tx) => {
    const op = await tx.query<{ id: string }>("select id from users where email = $1 and active", [operatorEmail.trim().toLowerCase()]);
    if (!op.length) throw new Error("Az üzemeltető e-mail-címe nem aktív CRM-felhasználóé.");
    const rows = await tx.query<{ id: string }>("update customers set deleted_at = null, deleted_by = null where id = $1 and deleted_at is not null returning id", [customerId]);
    if (!rows.length) return { restored: false };
    await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail) values ($1, 'customer.restore', 'customer', $2, $2, $3::jsonb)", [op[0].id, customerId, JSON.stringify({ via: "cli" })]);
    return { restored: true };
  });
}

/** Az eltávolított ügyfelek listája az üzemeltetőnek (azonosító, típus, időpont, eltávolító) - személyes adat (név, elérhetőség) nélkül. */
export async function listRemovedCustomers(db: Db): Promise<{ id: string; type: string; deleted_at: string; deleted_by: string }[]> {
  return db.system((tx) => tx.query("select id, type, deleted_at::text as deleted_at, deleted_by from customers where deleted_at is not null order by deleted_at desc"));
}
