import type { Tx } from "./db/types";

/**
 * Üzemeltetői napló (0005 `ops_log`): jogosultság-kiosztás, mentés, visszaállítás. Hozzáfűző; csak a tulajdonosi kapcsolat írja.
 * A részletek nem tartalmazhatnak személyes adatot (csak azonosítókat, számokat, lenyomatokat).
 */
export async function opsLog(tx: Tx, e: { operation: string; environment: string; operator: string; detail?: Record<string, unknown> }): Promise<void> {
  await tx.query("insert into ops_log (operation, environment, operator, detail) values ($1, $2, $3, $4::jsonb)", [e.operation, e.environment, e.operator, e.detail ? JSON.stringify(e.detail) : null]);
}
