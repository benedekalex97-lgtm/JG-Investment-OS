import { createHash } from "node:crypto";
import { LATEST_MIGRATION, MIGRATIONS } from "./db/migrate";
import type { Db, Tx } from "./db/types";
import type { JgEnv } from "./config";

/**
 * Logikai mentés/visszaállítás (JSON dokumentum, v0.6 óta; v1.0-ban bővítve). A mentés TARTALMAZ személyes adatot és jelszó-hash-eket:
 * kizárólag titkosítva (backup-crypto.ts: AES-256-GCM boríték), hozzáférés-védett helyen tárolandó, nem kerülhet verziókezelésbe.
 * A visszaállítás kizárólag ÜRES (frissen migrált) adatbázisba történik; meglévő adatot soha nem ír felül és nem töröl.
 * A munkamenetek, a bejelentkezési kísérletek és a rövid életű OAuth-folyamatok nem részei a mentésnek.
 *
 * Ez ALKALMAZÁS-szintű adatmentés, nem teljes infrastruktúra-mentés: nem tartalmazza a Vercel-telepítést, az OAuth-kliens
 * beállítását, a környezeti változókat/titkokat, a Neon projekt- és szerepkör-beállításait (lásd docs/V1.0-DATA-OPERATIONS.md).
 */
export const BACKUP_TABLES = [
  "users", "oauth_identities", "user_permissions", "customers", "customer_restrictions", "company_contacts", "processes", "activities", "tasks", "task_results",
  "contactability", "audit_events", "request_log", "import_jobs", "import_results", "ops_log",
] as const;
export type BackupTable = (typeof BACKUP_TABLES)[number];
const JSONB_COLUMNS = new Set(["meta", "detail", "response", "options"]);

/**
 * Kompatibilitási leképezés: melyik migráció hozta létre a táblát. Régebbi sémájú mentésből a később létrejött tábla hiányozhat
 * (üresként áll vissza - nem találunk ki adatot, jogosultságot vagy adatforrást); a táblát már tartalmazó sémájú mentésből nem.
 */
export const TABLE_SINCE: Partial<Record<BackupTable, string>> = {
  oauth_identities: "0002_google_auth",
  user_permissions: "0005_crm_data_permissions",
  ops_log: "0005_crm_data_permissions",
  import_jobs: "0006_crm_import_jobs",
  import_results: "0006_crm_import_jobs",
};

export interface Backup {
  format: "jg-os-backup";
  version: 1;
  createdAt: string;
  migration: string;
  environment: JgEnv;
  counts: Record<string, number>;
  tables: Record<string, Record<string, unknown>[]>;
}

const orderBy: Record<BackupTable, string> = {
  users: "created_at, id", oauth_identities: "issuer, subject", user_permissions: "user_id, permission", customers: "created_at, id", customer_restrictions: "customer_id",
  company_contacts: "created_at, id", processes: "created_at, id", activities: "occurred_at, id", tasks: "created_at, id", task_results: "task_id, seq", contactability: "id",
  audit_events: "id", request_log: "created_at, request_id", import_jobs: "created_at, id", import_results: "job_id, row_no", ops_log: "id",
};

/** Kanonikus JSON (rendezett kulcsok) - a tábla-lenyomatokhoz. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
/** Egy tábla tartalmának SHA-256 lenyomata (a sorok JSON-alakjából, rendezett kulcsokkal). */
export const tableChecksum = (rows: Record<string, unknown>[]) => sha256(canonical(JSON.parse(JSON.stringify(rows))));

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
    if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c))) throw new RestoreError(`Érvénytelen oszlopnév a mentésben (${table}).`);
    const vals = cols.map((c) => {
      const v = row[c];
      return JSONB_COLUMNS.has(c) && v !== null && v !== undefined ? JSON.stringify(v) : v;
    });
    const ph = cols.map((c, i) => (JSONB_COLUMNS.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
    await tx.query(`insert into ${table} (${cols.join(", ")}) values (${ph})`, vals);
  }
}

export class RestoreError extends Error {}

/**
 * Korábbi sémaverziójú mentések, amelyek a jelenlegi sémába változtatás nélkül visszaállíthatók, mert az azóta futott migrációk
 * kizárólag NULL-ozható oszlopokat (0003: `task_results.outcome`; 0004: `customers.deleted_at` / `deleted_by`) vagy új táblákat
 * (0005: `user_permissions`, `ops_log`; 0006: `import_jobs`, `import_results`) adtak hozzá. A régi sorok az új oszlopokban NULL-t
 * kapnak, az új táblák üresek maradnak - kitalált érték nem keletkezik. Nem additív sémaváltozásnál a lista nem bővíthető.
 */
export const RESTORE_COMPATIBLE_MIGRATIONS: readonly string[] = ["0002_google_auth", "0003_task_outcome", "0004_test_customer_soft_delete", "0005_crm_data_permissions", LATEST_MIGRATION];

const migrationIndex = (id: string) => MIGRATIONS.findIndex((m) => m.id === id);

/** A mentés szerkezeti ellenőrzése (formátum, sémaverzió, környezet, táblák) - írás nélkül. */
export function checkBackupShape(backup: Backup, env: JgEnv): BackupTable[] {
  if (!backup || backup.format !== "jg-os-backup" || backup.version !== 1) throw new RestoreError("Ismeretlen mentésformátum.");
  if (!RESTORE_COMPATIBLE_MIGRATIONS.includes(backup.migration)) throw new RestoreError(`A mentés sémaverziója (${backup.migration}) eltér az alkalmazásétól (${LATEST_MIGRATION}), és nem tölthető vissza változtatás nélkül.`);
  if (backup.environment !== env) throw new RestoreError(`A mentés környezete (${backup.environment}) nem egyezik a célkörnyezettel (${env}).`);
  if (!backup.tables || typeof backup.tables !== "object" || !backup.counts) throw new RestoreError("Ismeretlen mentésformátum.");
  const unknown = Object.keys(backup.tables).filter((t) => !(BACKUP_TABLES as readonly string[]).includes(t));
  if (unknown.length) throw new RestoreError(`Ismeretlen tábla a mentésben: ${unknown.join(", ")}.`);
  const present: BackupTable[] = [];
  for (const t of BACKUP_TABLES) {
    if (Array.isArray(backup.tables[t])) {
      if (backup.counts[t] !== backup.tables[t].length) throw new RestoreError(`A mentés sorösszesítője hibás (${t}).`);
      present.push(t);
      continue;
    }
    const since = TABLE_SINCE[t];
    // A tábla csak akkor hiányozhat, ha a mentés sémája régebbi, mint a táblát létrehozó migráció.
    if (since && migrationIndex(backup.migration) < migrationIndex(since)) continue;
    throw new RestoreError(`Hiányzó tábla a mentésben: ${t}.`);
  }
  return present;
}

/** Az adatbázis összes mentett táblája üres-e (a visszaállítás előfeltétele). */
export async function assertEmptyTarget(tx: Tx): Promise<void> {
  for (const t of BACKUP_TABLES) {
    const [{ n }] = await tx.query<{ n: string }>(`select count(*) as n from ${t}`);
    if (Number(n) > 0) throw new RestoreError(`A céladatbázis nem üres (${t}). A visszaállítás csak üres adatbázisba engedett.`);
  }
}

/**
 * Visszaállítás üres adatbázisba, egyetlen tranzakcióban (hiba esetén semmi nem íródik). A végén ugyanabban a tranzakcióban
 * ellenőrzi a sorszámokat ÉS a tartalmat: minden tábla visszaolvasott sorai (a mentésben szereplő oszlopokra vetítve) bájtra
 * azonosak a mentéssel. Az idegen kulcsok (ügyfél-feladat-Output-kapcsolattartó-import) a séma kényszerei szerint ellenőrzöttek.
 */
export async function restoreBackup(db: Db, backup: Backup, env: JgEnv): Promise<Record<string, number>> {
  const present = checkBackupShape(backup, env);
  return db.system(async (tx) => {
    await assertEmptyTarget(tx);
    for (const t of present) await insertRows(tx, t, backup.tables[t]);
    for (const seq of [["audit_events", "id"], ["ops_log", "id"]]) {
      await tx.query(`select setval(pg_get_serial_sequence('${seq[0]}', '${seq[1]}'), greatest((select coalesce(max(${seq[1]}), 0) from ${seq[0]}), 1), (select count(*) > 0 from ${seq[0]}))`);
    }
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      const [{ n }] = await tx.query<{ n: string }>(`select count(*) as n from ${t}`);
      counts[t] = Number(n);
      const expected = present.includes(t) ? backup.counts[t] : 0;
      if (counts[t] !== expected) throw new RestoreError(`A visszaállított sorok száma eltér (${t}): ${counts[t]} / ${expected}.`);
    }
    for (const t of present) {
      const rows = await tx.query<Record<string, unknown>>(`select * from ${t} order by ${orderBy[t]}`);
      const want = backup.tables[t];
      const projected = rows.map((r, i) => Object.fromEntries(Object.keys(want[i] ?? {}).map((k) => [k, r[k]])));
      if (tableChecksum(projected) !== tableChecksum(want)) throw new RestoreError(`A visszaállított tartalom eltér a mentéstől (${t}).`);
    }
    return Object.fromEntries(Object.entries(counts).filter(([t]) => present.includes(t as BackupTable) || backup.counts[t] !== undefined));
  });
}

/** Üzemeltetői kapcsolat ellenőrzése: a mentés/visszaállítás csak a séma tulajdonosával (vagy szuperfelhasználóval) futhat. */
export async function assertOperatorConnection(db: Db): Promise<void> {
  const [r] = await db.system((tx) => tx.query<{ ok: boolean }>(
    `select coalesce((select r.rolsuper from pg_roles r where r.rolname = current_user), false)
        or coalesce(pg_has_role(current_user, (select tableowner from pg_tables where schemaname = 'public' and tablename = 'customers'), 'MEMBER'), false) as ok`,
  ));
  if (!r?.ok) throw new RestoreError("Nincs üzemeltetői jogosultság: a mentés és a visszaállítás csak a séma tulajdonosi kapcsolatával végezhető (nem a futási vagy alkalmazás-szerepkörrel).");
}
