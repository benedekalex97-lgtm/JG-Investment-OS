import { createHash } from "node:crypto";
import { LATEST_MIGRATION, MIGRATIONS } from "./db/migrate";
import type { Db, Tx } from "./db/types";
import type { JgEnv } from "./config";
import { assertDbEnvironment } from "./db/environment";
import { BUILTIN_CRM_CONFIG } from "@/domain/config";

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
  "users", "oauth_identities", "user_permissions", "crm_pipeline_statuses", "crm_task_types", "crm_task_input_options",
  "customers", "customer_restrictions", "company_contacts", "processes", "activities", "tasks", "task_results",
  "contactability", "audit_events", "request_log", "import_jobs", "import_results", "ops_log", "settings_audit",
] as const;
/**
 * v1.1 konfigurációs katalógusok: a migráció (0008) a v1.0 értékekkel tölti fel őket, ezért egy frissen migrált céladatbázisban NEM
 * üresek. Visszaállításkor a cél katalógusának pontosan ebben az érintetlen kiinduló állapotban kell lennie; a mentés sorai ezt
 * kulcs szerint felülírják (a kiinduló sorok mind szerepelnek a mentésben, mert rendszerelem nem törölhető), törlés nincs.
 */
export const CATALOG_TABLES = ["crm_pipeline_statuses", "crm_task_types", "crm_task_input_options"] as const;
type CatalogTable = (typeof CATALOG_TABLES)[number];
const isCatalog = (t: string): t is CatalogTable => (CATALOG_TABLES as readonly string[]).includes(t);
export type BackupTable = (typeof BACKUP_TABLES)[number];
const JSONB_COLUMNS = new Set(["meta", "detail", "response", "options", "changes"]);

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
  settings_audit: "0007_crm_settings_permissions",
  crm_pipeline_statuses: "0008_crm_config_catalogs",
  crm_task_types: "0008_crm_config_catalogs",
  crm_task_input_options: "0008_crm_config_catalogs",
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
  crm_pipeline_statuses: "key", crm_task_types: "key", crm_task_input_options: "key", settings_audit: "id",
};

/** Kanonikus JSON (rendezett kulcsok) - a tábla-lenyomatokhoz. */
export const canonical = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));
export const sha256 = (s: string | Uint8Array) => createHash("sha256").update(s).digest("hex");
/** Egy tábla tartalmának SHA-256 lenyomata (a sorok JSON-alakjából, rendezett kulcsokkal). */
export const tableChecksum = (rows: Record<string, unknown>[]) => sha256(canonical(JSON.parse(JSON.stringify(rows))));

export async function exportBackup(db: Db, env: JgEnv, now: Date = new Date()): Promise<Backup> {
  return db.system(async (tx) => {
    // Egyetlen, REPEATABLE READ + READ ONLY tranzakció: a környezet-ellenőrzés és MINDEN tábla ugyanabból a pillanatképből olvasódik
    // (READ COMMITTED mellett a táblák közötti olvasások között véglegesített írás - pl. új ügyfél + feladata - részben kerülne a mentésbe).
    // Csak ez a tranzakció kapja ezt a szintet; az általános driver-tranzakciók izolációja változatlan.
    await tx.exec("set transaction isolation level repeatable read, read only");
    await assertDbEnvironment(tx, env);
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
 * v1.1 (0007-0009): a `user_permissions` két új, NULL-ozható oszlopot kapott (visszavonás), a napló új tábla; a katalógusok a
 * migráció kiinduló (v1.0) értékeivel maradnak - pontosan azzal a konfigurációval, amellyel a régi mentés készült. A régi
 * feladatokon szereplő, a v1.0 listában nem szereplő típus/Input kulcsok a migrációval azonos szabállyal archivált katalóguselemet
 * kapnak (a hivatkozási integritás miatt); más adat nem keletkezik.
 */
export const RESTORE_COMPATIBLE_MIGRATIONS: readonly string[] = ["0002_google_auth", "0003_task_outcome", "0004_test_customer_soft_delete", "0005_crm_data_permissions", "0006_crm_import_jobs", LATEST_MIGRATION];

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
    if (isCatalog(t)) {
      if (!(await isPristineCatalog(tx, t))) throw new RestoreError(`A céladatbázis nem üres (${t}: a katalógus eltér a migráció kiinduló állapotától). A visszaállítás csak üres adatbázisba engedett.`);
      continue;
    }
    const [{ n }] = await tx.query<{ n: string }>(`select count(*) as n from ${t}`);
    if (Number(n) > 0) throw new RestoreError(`A céladatbázis nem üres (${t}). A visszaállítás csak üres adatbázisba engedett.`);
  }
}

/** A migráció (0008) által létrehozott, érintetlen kiinduló sorok (kulcs, név, sorrend, állapot, verzió, módosító nélkül). */
function seedRows(t: CatalogTable): string[] {
  const list = t === "crm_pipeline_statuses" ? BUILTIN_CRM_CONFIG.statuses : t === "crm_task_types" ? BUILTIN_CRM_CONFIG.taskTypes : BUILTIN_CRM_CONFIG.taskInputs;
  return list.map((x) => `${x.key}|${x.label}|${x.sortOrder}|t|t|1||`).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}
async function isPristineCatalog(tx: Tx, t: CatalogTable): Promise<boolean> {
  // Rendezés a kliensen (a szerver kollációjától függetlenül, determinisztikusan).
  const rows = (await tx.query<{ r: string }>(`select concat_ws('|', key, label, sort_order, case when is_active then 't' else 'f' end, case when is_system then 't' else 'f' end, version, coalesce(created_by, ''), coalesce(updated_by, '')) as r from ${t}`)).sort((a, b) => (a.r < b.r ? -1 : a.r > b.r ? 1 : 0));
  const want = seedRows(t);
  return rows.length === want.length && rows.every((x, i) => x.r === want[i]);
}

/** Régi (katalógus nélküli) mentésnél a feladatok listán kívüli kulcsai - ugyanaz a szabály, mint a 0008 migrációban. */
function legacyKeys(backup: Backup, col: "task_type" | "input_key", t: CatalogTable): string[] {
  const known = new Set(seedRows(t).map((r) => r.split("|")[0]));
  return [...new Set((backup.tables.tasks ?? []).map((r) => r[col]).filter((v): v is string => typeof v === "string" && !known.has(v) && /^[a-z][a-z0-9_]{1,39}$/.test(v)))].sort();
}

/**
 * Visszaállítás üres adatbázisba, egyetlen tranzakcióban (hiba esetén semmi nem íródik). A végén ugyanabban a tranzakcióban
 * ellenőrzi a sorszámokat ÉS a tartalmat: minden tábla visszaolvasott sorai (a mentésben szereplő oszlopokra vetítve) bájtra
 * azonosak a mentéssel. Az idegen kulcsok (ügyfél-feladat-Output-kapcsolattartó-import) a séma kényszerei szerint ellenőrzöttek.
 */
export async function restoreBackup(db: Db, backup: Backup, env: JgEnv): Promise<Record<string, number>> {
  const present = checkBackupShape(backup, env);
  return db.system(async (tx) => {
    await assertDbEnvironment(tx, env);
    await assertEmptyTarget(tx);
    // A v1.1 őr-, napló- és aktív-elem triggerei a visszaállítás idejére (csak ebben a tranzakcióban) kikapcsolnak: a mentés a már
    // naplózott, korábban érvényes állapotot tartalmazza (pl. archivált státuszban lévő ügyfelet, a mentett verziószámokat). Az idegen
    // kulcsok és CHECK-ek érvényesek maradnak. Hiba esetén a tranzakció visszagördül, a triggerek is visszakapcsolnak.
    const guarded = [...CATALOG_TABLES, "user_permissions", "customers", "tasks"];
    for (const t of guarded) await tx.exec(`alter table ${t} disable trigger user`);
    const derived: Partial<Record<CatalogTable, number>> = {};
    for (const t of BACKUP_TABLES) {
      if (isCatalog(t)) {
        if (present.includes(t)) await upsertCatalog(tx, t, backup.tables[t]);
        else if (t !== "crm_pipeline_statuses") {
          const keys = legacyKeys(backup, t === "crm_task_types" ? "task_type" : "input_key", t);
          for (const [i, k] of keys.entries()) await tx.query(`insert into ${t} (key, label, sort_order, is_active, archived_at) values ($1, $1, $2, false, now())`, [k, 1001 + i]);
          derived[t] = keys.length;
        }
        continue;
      }
      if (present.includes(t)) await insertRows(tx, t, backup.tables[t]);
    }
    for (const t of guarded) await tx.exec(`alter table ${t} enable trigger user`);
    for (const seq of [["audit_events", "id"], ["ops_log", "id"], ["settings_audit", "id"]]) {
      await tx.query(`select setval(pg_get_serial_sequence('${seq[0]}', '${seq[1]}'), greatest((select coalesce(max(${seq[1]}), 0) from ${seq[0]}), 1), (select count(*) > 0 from ${seq[0]}))`);
    }
    const counts: Record<string, number> = {};
    for (const t of BACKUP_TABLES) {
      const [{ n }] = await tx.query<{ n: string }>(`select count(*) as n from ${t}`);
      counts[t] = Number(n);
      const expected = present.includes(t) ? backup.counts[t] : isCatalog(t) ? seedRows(t).length + (derived[t] ?? 0) : 0;
      if (counts[t] !== expected) throw new RestoreError(`A visszaállított sorok száma eltér (${t}): ${counts[t]} / ${expected}.`);
    }
    for (const t of present) {
      const rows = await tx.query<Record<string, unknown>>(`select * from ${t} order by ${orderBy[t]}`);
      const want = backup.tables[t];
      const projected = rows.map((r, i) => Object.fromEntries(Object.keys(want[i] ?? {}).map((k) => [k, r[k]])));
      if (tableChecksum(projected) !== tableChecksum(want)) throw new RestoreError(`A visszaállított tartalom eltér a mentéstől (${t}).`);
    }
    // Régi mentésnél a katalógus a migráció kiinduló állapota (+ a régi feladatok archivált kulcsai) marad.
    for (const t of CATALOG_TABLES.filter((x) => !present.includes(x))) {
      const rows = (await tx.query<{ key: string }>(`select key from ${t}`)).sort((a, b) => (a.key < b.key ? -1 : 1));
      const want = [...seedRows(t).map((r) => r.split("|")[0]), ...(t === "crm_pipeline_statuses" ? [] : legacyKeys(backup, t === "crm_task_types" ? "task_type" : "input_key", t))].sort();
      if (rows.map((r) => r.key).join() !== want.join()) throw new RestoreError(`A visszaállított tartalom eltér a mentéstől (${t}).`);
    }
    return Object.fromEntries(Object.entries(counts).filter(([t]) => present.includes(t as BackupTable) || backup.counts[t] !== undefined));
  });
}

/** Katalógus visszaállítása kulcs szerint (a cél kiinduló sorai a mentés értékeit kapják; új kulcs beszúrás). Törlés nincs. */
async function upsertCatalog(tx: Tx, table: CatalogTable, rows: Record<string, unknown>[]) {
  for (const row of rows) {
    const cols = Object.keys(row);
    if (!cols.every((c) => /^[a-z_][a-z0-9_]*$/.test(c)) || !cols.includes("key")) throw new RestoreError(`Érvénytelen oszlopnév a mentésben (${table}).`);
    const ph = cols.map((_c, i) => `$${i + 1}`).join(", ");
    const upd = cols.filter((c) => c !== "key").map((c) => `${c} = excluded.${c}`).join(", ");
    await tx.query(`insert into ${table} (${cols.join(", ")}) values (${ph}) on conflict (key) do update set ${upd}`, cols.map((c) => row[c]));
  }
}

/** Üzemeltetői kapcsolat ellenőrzése: a mentés/visszaállítás csak a séma tulajdonosával (vagy szuperfelhasználóval) futhat. */
export async function assertOperatorConnection(db: Db): Promise<void> {
  const [r] = await db.system((tx) => tx.query<{ ok: boolean }>(
    `select coalesce((select r.rolsuper from pg_roles r where r.rolname = current_user), false)
        or coalesce(pg_has_role(current_user, (select tableowner from pg_tables where schemaname = 'public' and tablename = 'customers'), 'MEMBER'), false) as ok`,
  ));
  if (!r?.ok) throw new RestoreError("Nincs üzemeltetői jogosultság: a mentés és a visszaállítás csak a séma tulajdonosi kapcsolatával végezhető (nem a futási vagy alkalmazás-szerepkörrel).");
}
