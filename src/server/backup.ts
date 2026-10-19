import { LATEST_MIGRATION } from "./db/migrate";
import type { Db, Tx } from "./db/types";
import type { JgEnv } from "./config";

/**
 * Logikai mentés/visszaállítás (JSON). A mentés TARTALMAZ személyes adatot és jelszó-hash-eket: titkosított, hozzáférés-védett
 * helyen tárolandó, nem kerülhet verziókezelésbe. A visszaállítás kizárólag ÜRES (frissen migrált) adatbázisba történik; meglévő
 * adatot soha nem ír felül és nem töröl. A munkamenetek és a bejelentkezési kísérletek nem része a mentésnek.
 */
export const BACKUP_TABLES = [
  "users", "oauth_identities", "customers", "customer_restrictions", "company_contacts", "processes", "activities", "tasks", "task_results",
  "contactability", "audit_events", "request_log",
] as const;
const JSONB_COLUMNS = new Set(["meta", "detail", "response"]);

export interface Backup {
  format: "jg-os-backup";
  version: 1;
  createdAt: string;
  migration: string;
  environment: JgEnv;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

const orderBy: Record<string, string> = {
  users: "created_at, id", oauth_identities: "issuer, subject", customers: "created_at, id", customer_restrictions: "customer_id", company_contacts: "created_at, id", processes: "created_at, id",
  activities: "occurred_at, id", tasks: "created_at, id", task_results: "task_id, seq", contactability: "id", audit_events: "id", request_log: "created_at, request_id",
};

export async function exportBackup(db: Db, env: JgEnv, now: Date = new Date()): Promise<Backup> {
  return db.system(async (tx) => {
    // Egyetlen tranzakció = konzisztens pillanatkép.
    const tables: Backup["tables"] = {};
    for (const t of BACKUP_TABLES) tables[t] = await tx.query(`select * from ${t} order by ${orderBy[t]}`);
    const counts = Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length]));
    return { format: "jg-os-backup", version: 1, createdAt: now.toISOString(), migration: LATEST_MIGRATION, environment: env, counts, tables } as Backup;
  });
}

async function insertRows(tx: Tx, table: string, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    const cols = Object.keys(row);
    const vals = cols.map((c) => {
      const v = row[c];
      return JSONB_COLUMNS.has(c) && v !== null && v !== undefined ? JSON.stringify(v) : v;
    });
    const ph = cols.map((c, i) => (JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
    await tx.query(`insert into ${table} (${cols.join(", ")}) values (${ph})`, vals);
  }
}

export class RestoreError extends Error {}

/** Visszaállítás üres adatbázisba, egyetlen tranzakcióban (hiba esetén semmi nem íródik). */
export async function restoreBackup(db: Db, backup: Backup, env: JgEnv): Promise<Record<string, number>> {
  if (backup.format !== "jg-os-backup" || backup.version !== 1) throw new RestoreError("Ismeretlen mentésformátum.");
  if (backup.migration !== LATEST_MIGRATION) throw new RestoreError(`A mentés sémaverziója (${backup.migration}) eltér az alkalmazásétól (${LATEST_MIGRATION}).`);
  if (backup.environment !== env) throw new RestoreError(`A mentés környezete (${backup.environment}) nem egyezik a célkörnyezettel (${env}).`);
  for (const t of BACKUP_TABLES) if (!Array.isArray(backup.tables[t])) throw new RestoreError(`Hiányzó tábla a mentésben: ${t}.`);
  return db.system(async (tx) => {
    for (const t of BACKUP_TABLES) {
      const [{ n }] = await tx.query<{ n: string }>(`select count(*) as n from ${t}`);
      if (Number(n) > 0) throw new RestoreError(`A céladatbázis nem üres (${t}). A visszaállítás csak üres adatbázisba engedett.`);
    }
    for (const t of BACKUP_TABLES) await insertRows(tx, t, backup.tables[t]);
    await tx.query("select setval(pg_get_serial_sequence('audit_events', 'id'), greatest((select coalesce(max(id), 0) from audit_events), 1), (select count(*) > 0 from audit_events))");
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      const [{ n }] = await tx.query<{ n: string }>(`select count(*) as n from ${t}`);
      counts[t] = Number(n);
      if (counts[t] !== backup.counts[t]) throw new RestoreError(`A visszaállított sorok száma eltér (${t}): ${counts[t]} / ${backup.counts[t]}.`);
    }
    return counts;
  });
}

