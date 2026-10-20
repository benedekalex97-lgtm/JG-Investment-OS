import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CRM_CONFIG } from "@/domain/config";
import { BACKUP_TABLES, CATALOG_TABLES, exportBackup, restoreBackup, tableChecksum, type Backup } from "@/server/backup";
import { generateKey, openBackup, parseKey, sealBackup } from "@/server/backup-crypto";
import { loadConfig } from "@/server/crm/store";
import { migrate, MIGRATIONS } from "@/server/db/migrate";
import { DRIVERS, makeTestDb, type TestDb } from "./helpers";

/**
 * v1.1 mentés/visszaállítás (SET-009, 17. fejezet): a konfigurációs katalógusok, a visszavont jogok és a beállítási napló a teljes
 * logikai mentés része; a régi (v1.0 / v0.9) mentések az új sémába változatlanul visszaállíthatók. Kizárólag fiktív adat, eldobható DB.
 */
const V10 = MIGRATIONS.slice(0, 6);
const V10_TABLES = ["users", "oauth_identities", "user_permissions", "customers", "customer_restrictions", "company_contacts", "processes", "activities", "tasks", "task_results", "contactability", "audit_events", "request_log", "import_jobs", "import_results", "ops_log"];
const V10_ORDER: Record<string, string> = {
  users: "created_at, id", oauth_identities: "issuer, subject", user_permissions: "user_id, permission", customers: "created_at, id", customer_restrictions: "customer_id",
  company_contacts: "created_at, id", processes: "created_at, id", activities: "occurred_at, id", tasks: "created_at, id", task_results: "task_id, seq", contactability: "id",
  audit_events: "id", request_log: "created_at, request_id", import_jobs: "created_at, id", import_results: "job_id, row_no", ops_log: "id",
};
const T0 = "2026-05-01T08:00:00.000Z";

/** Egy v1.0 (0006) sémájú adatbázis mentése pontosan a v1.0 `exportBackup` alakjában (a v1.0 táblalistájával). */
async function v10Backup(t: TestDb): Promise<Backup> {
  return t.db.system(async (tx) => {
    const tables: Backup["tables"] = {};
    for (const name of V10_TABLES) tables[name] = await tx.query(`select * from ${name} order by ${V10_ORDER[name]}`);
    const b = { format: "jg-os-backup", version: 1, createdAt: T0, migration: "0006_crm_import_jobs", environment: "local", counts: Object.fromEntries(Object.entries(tables).map(([k, v]) => [k, v.length])), tables } as Backup;
    return JSON.parse(JSON.stringify(b)) as Backup;
  });
}

describe.each(DRIVERS)("v1.1 mentés és visszaállítás (%s)", (kind) => {
  let src: TestDb;
  beforeAll(async () => {
    src = await makeTestDb(kind, { migrate: false });
    await migrate(src.db, { env: "local", migrations: V10 });
    await src.db.system(async (tx) => {
      await tx.query("insert into users (id, email, name, password_hash, created_at) values ('u-1','b.egy@example.test','B Egy','x',$1), ('u-2','b.ketto@example.test','B Kettő','x',$1)", [T0]);
      await tx.query("insert into user_permissions (user_id, permission, granted_by, granted_at) values ('u-1','crm.customer.export','Teszt Üzemeltető',$1)", [T0]);
      await tx.query("insert into customers (id, type, display_name, last_name, first_name, crm_status, owner_id, created_at, updated_at) values ('c-1','individual','Fiktív Egy','Fiktív','Egy','capital_placed','u-1',$1,$1), ('c-2','individual','Fiktív Kettő','Fiktív','Kettő',null,'u-2',$1,$1)", [T0]);
      await tx.query("insert into tasks (id, customer_id, title, task_type, input_key, assignee_id, status, crm_status, created_at) values ('t-1','c-1','Örökölt','legacy_call','old_input','u-1','open','capital_placed',$1), ('t-2','c-2','Telefonhívás','phone_call','other','u-2','open',null,$1)", [T0]);
      await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, customer_id) values ('u-1','customer.create','customer','c-1','c-1')");
    });
  });
  afterAll(async () => { await src.cleanup(); });

  it("M15: valódi v1.0 (0006) formátumú mentés visszaállítható a v1.1 sémába; a katalógus a v1.0 konfiguráció; a régi kulcsok archiválva", async () => {
    const backup = await v10Backup(src);
    const dst = await makeTestDb(kind);
    try {
      const counts = await restoreBackup(dst.db, backup, "local");
      expect(counts).toMatchObject({ users: 2, customers: 2, tasks: 2, user_permissions: 1 });
      const cfg = await dst.db.asUser("u-1", (tx) => loadConfig(tx));
      expect(cfg.statuses.map((s) => s.key)).toEqual(BUILTIN_CRM_CONFIG.statuses.map((s) => s.key));
      expect(cfg.taskTypes.filter((x) => !x.isActive).map((x) => x.key)).toEqual(["legacy_call"]);
      expect(cfg.taskInputs.filter((x) => !x.isActive).map((x) => x.key)).toEqual(["old_input"]);
      for (const t of V10_TABLES) {
        const rows = await dst.db.system((tx) => tx.query<Record<string, unknown>>(`select * from ${t} order by ${V10_ORDER[t]}`));
        const projected = rows.map((r, i) => Object.fromEntries(Object.keys(backup.tables[t][i] ?? {}).map((k) => [k, r[k]])));
        expect(tableChecksum(projected), t).toBe(tableChecksum(backup.tables[t]));
      }
      expect(await dst.db.system((tx) => tx.query("select count(*)::int as n from settings_audit"))).toEqual([{ n: 0 }]);
      // A visszaállítás után a triggerek ismét élnek: archivált régi kulcs új feladathoz nem használható.
      await expect(dst.db.asUser("u-1", (tx) => tx.query("insert into tasks (id, customer_id, title, task_type, assignee_id, status, created_at) values ('t-x','c-1','X','legacy_call','u-1','open',now())"))).rejects.toThrow(/inactive_task_type/);
      expect(await dst.db.asUser("u-1", (tx) => tx.query("select app_has_permission('crm.customer.export') as ok"))).toEqual([{ ok: true }]);
    } finally { await dst.cleanup(); }
  });

  it("teljes v1.1 mentés: egyedi és archivált konfiguráció, visszavont jog és napló - visszaállítás után bájtra azonos, a napló folytatódik", async () => {
    await migrate(src.db, { env: "local" });
    await src.db.system((tx) => tx.query("insert into user_permissions (user_id, permission, granted_by) values ('u-1','crm.settings.manage','Teszt Üzemeltető'), ('u-2','crm.users.manage','Teszt Üzemeltető')"));
    await src.db.system((tx) => tx.query("update user_permissions set revoked_at = now(), revoked_by = 'Teszt Üzemeltető' where user_id = 'u-2'"));
    await src.db.asUser("u-1", async (tx) => {
      await tx.query("insert into crm_pipeline_statuses (key, label, color, sort_order) values ('ajanlat','Fiktív ajánlat','teal',80)");
      await tx.query("update crm_pipeline_statuses set label = 'Új kapcsolat' where key = 'contact'");
      await tx.query("insert into crm_task_types (key, label, sort_order) values ('video','Videó',70)");
      await tx.query("insert into crm_task_input_options (key, label, sort_order, allows_note) values ('rendezveny','Rendezvény',70,true)");
      await tx.query("update customers set crm_status = 'ajanlat' where id = 'c-2'");
      await tx.query("insert into tasks (id, customer_id, title, task_type, input_key, input_note, assignee_id, status, crm_status, created_at) values ('t-3','c-2','Videó','video','rendezveny','Fiktív','u-1','open','ajanlat',now())");
      await tx.query("update crm_pipeline_statuses set is_active = false where key = 'ajanlat'");
    });
    const backup = JSON.parse(JSON.stringify(await exportBackup(src.db, "local"))) as Backup;
    expect(Object.keys(backup.tables)).toEqual([...BACKUP_TABLES]);
    expect(backup.counts.settings_audit).toBeGreaterThanOrEqual(8);
    // Titkosított boríték: a táblánkénti lenyomatok az új táblákra is kiterjednek.
    const key = parseKey(generateKey());
    const sealed = sealBackup(backup, key, { databaseFingerprint: "teszt" });
    const opened = openBackup(sealed, key);
    expect(opened.header.counts).toEqual(backup.counts);
    expect(Object.keys(opened.header.tableSha256)).toEqual(expect.arrayContaining(["crm_pipeline_statuses", "crm_task_types", "crm_task_input_options", "settings_audit"]));
    expect(opened.header.tableSha256.settings_audit).toBe(tableChecksum(backup.tables.settings_audit));
    const dst = await makeTestDb(kind);
    try {
      await restoreBackup(dst.db, opened.backup, "local");
      for (const t of BACKUP_TABLES) {
        const order = t === "settings_audit" ? "id" : (CATALOG_TABLES as readonly string[]).includes(t) ? "key" : undefined;
        if (!order) continue;
        const rows = await dst.db.system((tx) => tx.query<Record<string, unknown>>(`select * from ${t} order by ${order}`));
        expect(tableChecksum(JSON.parse(JSON.stringify(rows))), t).toBe(tableChecksum(backup.tables[t]));
      }
      const c2 = await dst.db.system((tx) => tx.query("select crm_status from customers where id = 'c-2'"));
      expect(c2).toEqual([{ crm_status: "ajanlat" }]);
      expect(await dst.db.asUser("u-2", (tx) => tx.query("select app_has_permission('crm.users.manage') as ok"))).toEqual([{ ok: false }]);
      // A triggerek visszakapcsoltak: az új változás naplózódik, az azonosító a mentett után folytatódik.
      const maxId = Math.max(...backup.tables.settings_audit.map((r) => Number(r.id)));
      await dst.db.asUser("u-1", (tx) => tx.query("update crm_pipeline_statuses set is_active = true where key = 'ajanlat'"));
      const last = await dst.db.system((tx) => tx.query<{ id: string; action: string }>("select id, action from settings_audit order by id desc limit 1"));
      expect(Number(last[0].id)).toBeGreaterThan(maxId);
      expect(last[0].action).toBe("pipeline_status.reactivate");
      await expect(dst.db.asUser("u-1", (tx) => tx.query("update crm_pipeline_statuses set is_active = false where key = 'lost'"))).rejects.toThrow(/system_archive/);
    } finally { await dst.cleanup(); }

    // Nem érintetlen (módosított katalógusú) célba nem állítható vissza; semmi nem íródik.
    const dirty = await makeTestDb(kind);
    try {
      await dirty.db.system((tx) => tx.query("update crm_task_types set label = 'Hívás' where key = 'phone_call'"));
      await expect(restoreBackup(dirty.db, backup, "local")).rejects.toThrow(/nem üres \(crm_task_types/);
      expect(await dirty.db.system((tx) => tx.query("select count(*)::int as n from users"))).toEqual([{ n: 0 }]);
    } finally { await dirty.cleanup(); }
  });
});
