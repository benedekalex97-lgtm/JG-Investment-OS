import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CRM_CONFIG } from "@/domain/config";
import { loadConfig } from "@/server/crm/store";
import { checkSchema, LATEST_MIGRATION, migrate, MIGRATIONS, type Migration } from "@/server/db/migrate";
import { DRIVERS, makeTestDb, type TestDb } from "./helpers";

/**
 * v1.1 migrációs tesztek (M01-M14) valódi PostgreSQL-en (PGlite; natív PostgreSQL 18-on is, ha a JG_TEST_DATABASE_URL meg van adva).
 * Kiindulás: v1.0 séma (0001-0006) fiktív, a v1.0 alkalmazás által írható adatokkal - mind a hét státusz, régi (státusz nélküli)
 * ügyfél és feladat, régi szabad szöveges és legördülős Output, a v1.0-ban nem ellenőrzött régi feladattípus/Input kulcs, napló,
 * kérésnapló, import, jogosultság. A migráció után minden eredeti oszlop és sor bájtra azonos.
 */
const V10 = MIGRATIONS.slice(0, 6);
const T0 = "2026-05-01T08:00:00.000Z";
const TABLES = ["users", "user_permissions", "customers", "customer_restrictions", "company_contacts", "tasks", "task_results", "activities", "audit_events", "request_log", "import_jobs", "import_results", "ops_log"];
const ORDER: Record<string, string> = { users: "id", user_permissions: "user_id, permission", customers: "id", customer_restrictions: "customer_id", company_contacts: "id", tasks: "id", task_results: "task_id, seq", activities: "id", audit_events: "id", request_log: "request_id", import_jobs: "id", import_results: "job_id, row_no", ops_log: "id" };
const STATUSES = BUILTIN_CRM_CONFIG.statuses.map((s) => s.key);

async function seedV10(t: TestDb) {
  await t.db.system(async (tx) => {
    await tx.query("insert into users (id, email, name, password_hash) values ('u-1','v10.egy@example.test','V10 Egy','x'), ('u-2','v10.ketto@example.test','V10 Kettő','x')");
    await tx.query("insert into user_permissions (user_id, permission, granted_by) values ('u-1','crm.customer.export','Teszt Üzemeltető')");
    const values = [...STATUSES, null].map((s, i) => `('c-${i}','individual','Fiktív ${i}','Fiktív','${i}',${s ? `'${s}'` : "null"},'u-1','$T0','$T0')`.replace(/\$T0/g, T0)).join(",");
    await tx.query(`insert into customers (id, type, display_name, last_name, first_name, crm_status, owner_id, created_at, updated_at) values ${values}`);
    await tx.query("insert into customers (id, type, company_name, owner_id, created_at, updated_at, deleted_at, deleted_by) values ('c-del','company','Törölt Fiktív Kft.','u-1',$1,$1,$1,'u-1')", [T0]);
    await tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ('c-1','objection','Fiktív tiltakozás',$1,'u-1')", [T0]);
    await tx.query("insert into company_contacts (id, company_id, first_name, last_name, is_primary, created_at, updated_at) values ('k-1','c-del','Anna','Kovács',true,$1,$1)", [T0]);
    await tx.query(`insert into tasks (id, customer_id, title, task_type, input_key, input_note, description, assignee_id, status, crm_status, created_at, completed_at) values
      ('t-1','c-0','Telefonhívás','phone_call','other','Régi megjegyzés',null,'u-1','open','waiting_for_contact',$1,null),
      ('t-2','c-5','Régi szabad cím',null,null,null,'Régi szabad Input','u-2','done',null,$1,$1),
      ('t-3','c-6','Örökölt típus','legacy_call','old_input',null,null,'u-1','done','lost',$1,$1),
      ('t-4','c-del','E-mail','email','callback',null,null,'u-1','open','meeting',$1,null)`, [T0]);
    await tx.query(`insert into task_results (task_id, seq, output_key, output_text, outcome, closed_at, closed_by) values
      ('t-2',0,'not_reached','',null,$1,'u-2'), ('t-2',1,null,'Régi szabad Output',null,$1,'u-2'), ('t-3',0,null,'Sikeres fiktív lezárás','success',$1,'u-1')`, [T0]);
    await tx.query("insert into activities (id, customer_id, type, occurred_at, summary, recorded_by, meta) values ('a-1','c-1','crm_status_change',$1,'Kapcsolati státusz: Feldolgozásra vár → Kapcsolatfelvétel','u-1',$2::jsonb)", [T0, JSON.stringify({ fromCrmStatus: "waiting_for_contact", toCrmStatus: "contact" })]);
    await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail) values ('u-1','customer.create','customer','c-0','c-0','{\"type\":\"individual\"}'::jsonb)");
    await tx.query("insert into request_log (request_id, user_id, op, response) values ('r-1','u-1','customer.create','{\"ok\":true}'::jsonb)");
    await tx.query(`insert into import_jobs (id, created_by, status, file_type, file_sha256, file_size, source_name, purpose, source_verification, compliance_declared, options, expires_at)
      values ('imp-1','u-1','previewed','csv',repeat('a',64),10,'Fiktív forrás','Teszt','verified',true,'{}'::jsonb,$1)`, [T0]);
    await tx.query("insert into ops_log (operation, environment, operator, detail) values ('permission.grant','local','Teszt Üzemeltető','{}'::jsonb)");
  });
}

const dump = (t: TestDb) => t.db.system(async (tx) => {
  const out: Record<string, Record<string, unknown>[]> = {};
  for (const table of TABLES) out[table] = await tx.query(`select * from ${table} order by ${ORDER[table]}`);
  return JSON.parse(JSON.stringify(out)) as Record<string, Record<string, unknown>[]>;
});

describe.each(DRIVERS)("v1.1 migráció v1.0 adatbázisról (%s)", (kind) => {
  let t: TestDb;
  let before: Record<string, Record<string, unknown>[]>;
  beforeAll(async () => {
    t = await makeTestDb(kind, { migrate: false });
    await migrate(t.db, { env: "local", migrations: V10 });
    await seedV10(t);
    before = await dump(t);
  });
  afterAll(async () => { await t.cleanup(); });

  it("M01/M06/M07/M14: a v1.0 adatbázis migrál; minden eredeti oszlop és sor változatlan (új oszlop csak NULL-lal)", async () => {
    const r = await migrate(t.db, { env: "local" });
    expect(r.applied).toEqual(["0007_crm_settings_permissions", "0008_crm_config_catalogs", "0009_dynamic_crm_statuses"]);
    expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
    const after = await dump(t);
    for (const table of TABLES) {
      const projected = after[table].map((row, i) => Object.fromEntries(Object.keys(before[table][i] ?? {}).map((k) => [k, row[k]])));
      expect(projected, table).toEqual(before[table]);
      expect(after[table]).toHaveLength(before[table].length);
    }
    expect(after.user_permissions.map((p) => [p.revoked_at, p.revoked_by])).toEqual([[null, null]]);
    // A v1.0 jogosultság a migráció után is érvényes; új jog nem keletkezett.
    expect(await t.db.asUser("u-1", (tx) => tx.query("select app_has_permission('crm.customer.export') as e, app_has_permission('crm.settings.manage') as s, app_has_permission('crm.users.manage') as u"))).toEqual([{ e: true, s: false, u: false }]);
  });

  it("M02/M03/M04/M05: a hét státusz, hat feladattípus és hat Input a v1.0 kulcsaival, neveivel és sorrendjével; a régi, listán kívüli kulcsok archiválva megmaradnak", async () => {
    const cfg = await t.db.asUser("u-1", (tx) => loadConfig(tx));
    const pick = <T extends { key: string; label: string; sortOrder: number; isActive: boolean; isSystem: boolean }>(l: T[]) => l.map(({ key, label, sortOrder, isActive, isSystem }) => ({ key, label, sortOrder, isActive, isSystem }));
    expect(pick(cfg.statuses)).toEqual(pick(BUILTIN_CRM_CONFIG.statuses));
    expect(cfg.statuses.map(({ color, semantic, requiresVerification, labelLocked }) => ({ color, semantic, requiresVerification, labelLocked })))
      .toEqual(BUILTIN_CRM_CONFIG.statuses.map(({ color, semantic, requiresVerification, labelLocked }) => ({ color, semantic, requiresVerification, labelLocked })));
    expect(pick(cfg.taskTypes)).toEqual([...pick(BUILTIN_CRM_CONFIG.taskTypes), { key: "legacy_call", label: "legacy_call", sortOrder: 1001, isActive: false, isSystem: false }]);
    expect(pick(cfg.taskInputs)).toEqual([...pick(BUILTIN_CRM_CONFIG.taskInputs), { key: "old_input", label: "old_input", sortOrder: 1001, isActive: false, isSystem: false }]);
    expect(cfg.taskInputs.filter((i) => i.allowsNote).map((i) => i.key)).toEqual(["other"]);
    // A beépített konfiguráció (és így a migráció adata) a v1.0 kódba égetett listáknak felel meg.
    expect(BUILTIN_CRM_CONFIG.statuses.map((s) => s.label)).toEqual(["Feldolgozásra vár", "Kapcsolatfelvétel", "Kapcsolatépítés", "Online/Személyes tárgyalás", "Számlanyitás", "Tőke elhelyezve", "Elvesztett"]);
  });

  it("M09: a régi CHECK helyett idegen kulcs; szabad szöveges státusz nem írható; a katalógus hivatkozott eleme nem törölhető", async () => {
    const cons = await t.db.system((tx) => tx.query<{ conname: string }>("select conname from pg_constraint where conrelid in ('customers'::regclass, 'tasks'::regclass) and conname like '%crm_status%' order by conname"));
    expect(cons.map((c) => c.conname)).toEqual(["customers_crm_status_fk", "tasks_crm_status_fk"]);
    await expect(t.db.system((tx) => tx.query("update customers set crm_status = 'kitalalt' where id = 'c-0'"))).rejects.toThrow();
    await expect(t.db.system((tx) => tx.query("update tasks set task_type = 'kitalalt' where id = 't-1'"))).rejects.toThrow();
    await expect(t.db.system((tx) => tx.query("delete from crm_pipeline_statuses where key = 'lost'"))).rejects.toThrow();
    await expect(t.db.system((tx) => tx.query("delete from crm_task_types where key = 'legacy_call'"))).rejects.toThrow();
  });

  it("M08/M10/M11/M14: új státusz létrehozható és használható; archiválva új hozzárendelésnél tiltott, a meglévő rekord olvasható; a v1.0 írási minta működik", async () => {
    await t.db.system((tx) => tx.query("insert into user_permissions (user_id, permission, granted_by) values ('u-1','crm.settings.manage','Teszt Üzemeltető')"));
    await t.db.asUser("u-1", (tx) => tx.query("insert into crm_pipeline_statuses (key, label, sort_order) values ('ajanlat','Fiktív ajánlat',80)"));
    // v1.0 alkalmazásminta (upsert a jg_app szerepkörrel) - új és régi kulccsal.
    await t.db.asUser("u-2", async (tx) => {
      await tx.query("insert into customers (id, type, display_name, last_name, first_name, crm_status, owner_id, created_at, updated_at) values ('c-n','individual','Új Fiktív','Új','Fiktív','ajanlat','u-2',now(),now())");
      await tx.query("insert into customers (id, type, display_name, last_name, first_name, crm_status, owner_id, created_at, updated_at) values ('c-v10','individual','V10 Írás','V10','Írás','meeting','u-2',now(),now())");
      await tx.query("insert into tasks (id, customer_id, title, task_type, assignee_id, status, crm_status, created_at) values ('t-n','c-n','Telefonhívás','phone_call','u-2','open','ajanlat',now())");
    });
    await t.db.asUser("u-1", (tx) => tx.query("update crm_pipeline_statuses set is_active = false where key = 'ajanlat'"));
    await expect(t.db.asUser("u-2", (tx) => tx.query("insert into customers (id, type, display_name, crm_status, owner_id, created_at, updated_at) values ('c-x','individual','X','ajanlat','u-2',now(),now())"))).rejects.toThrow(/inactive_status/);
    // Meglévő rekord: más mezője menthető (v1.0 upsert ON CONFLICT ággal is), a feladata lezárható.
    await t.db.asUser("u-2", async (tx) => {
      await tx.query("insert into customers (id, type, display_name, crm_status, owner_id, created_at, updated_at) values ('c-n','individual','Új Fiktív (mód.)','ajanlat','u-2',now(),now()) on conflict (id) do update set display_name = excluded.display_name, crm_status = excluded.crm_status");
      await tx.query("insert into tasks (id, customer_id, title, task_type, assignee_id, status, crm_status, created_at) values ('t-n','c-n','Telefonhívás','phone_call','u-2','done','ajanlat',now()) on conflict (id) do update set status = excluded.status");
      await tx.query("insert into tasks (id, customer_id, title, task_type, input_key, assignee_id, status, crm_status, created_at) values ('t-3','c-6','Örökölt típus','legacy_call','old_input','u-1','open','lost',$1) on conflict (id) do update set status = excluded.status", [T0]);
    });
    const rows = await t.db.asUser("u-2", (tx) => tx.query<{ id: string; crm_status: string; display_name: string }>("select id, crm_status, display_name from customers where id in ('c-n','c-v10') order by id"));
    expect(rows).toEqual([{ id: "c-n", crm_status: "ajanlat", display_name: "Új Fiktív (mód.)" }, { id: "c-v10", crm_status: "meeting", display_name: "V10 Írás" }]);
    // A feladat státusza (a létrehozáskori) nem írható át.
    await expect(t.db.asUser("u-2", (tx) => tx.query("update tasks set crm_status = 'lost' where id = 't-n'"))).rejects.toThrow(/task_status_immutable/);
  });

  it("M12: a migráció ismételt futtatása biztonságos (nincs új alkalmazás, nincs adatváltozás)", async () => {
    const snapshot = await dump(t);
    expect(await migrate(t.db, { env: "local" })).toEqual({ applied: [], alreadyApplied: MIGRATIONS.map((m) => m.id) });
    expect(await dump(t)).toEqual(snapshot);
  });
});

describe.each(DRIVERS)("v1.1 migráció hibája és visszagörgetése (%s)", (kind) => {
  it("M13: ha a 0009 előfeltétele nem teljesül, a 0009 egésze visszagördül (a CHECK megmarad), az alkalmazás nem indul (schema_outdated)", async () => {
    const t = await makeTestDb(kind, { migrate: false });
    try {
      await migrate(t.db, { env: "local", migrations: V10 });
      await t.db.system(async (tx) => {
        await tx.query("insert into users (id, email, name, password_hash) values ('u-1','m13@example.test','M13','x')");
        await tx.query("insert into customers (id, type, display_name, owner_id, created_at, updated_at) values ('c-1','individual','Fiktív','u-1',now(),now())");
        // A v1.0 nem ellenőrizte a feladattípust: kulcsformának nem megfelelő érték (pl. régi kézi adat) nem kerül a katalógusba.
        await tx.query("insert into tasks (id, customer_id, title, task_type, assignee_id, status, created_at) values ('t-1','c-1','Régi','Régi Típus!','u-1','open',now())");
      });
      await expect(migrate(t.db, { env: "local" })).rejects.toThrow(/migration_precheck tasks.task_type/);
      const applied = await t.db.system((tx) => tx.query<{ id: string }>("select id from schema_migrations order by id"));
      expect(applied.map((a) => a.id)).toEqual([...V10.map((m) => m.id), "0007_crm_settings_permissions", "0008_crm_config_catalogs"]);
      const cons = await t.db.system((tx) => tx.query<{ conname: string }>("select conname from pg_constraint where conrelid = 'customers'::regclass and conname like '%crm_status%'"));
      expect(cons.map((c) => c.conname)).toEqual(["customers_crm_status_check"]);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: false, reason: "schema_outdated" });
      expect(await t.db.system((tx) => tx.query("select task_type from tasks"))).toEqual([{ task_type: "Régi Típus!" }]);
      // Egy migráción belüli hiba (pl. utolsó utasítás) is teljes visszagörgetést jelent: semmi nem marad a 0009-ből.
      const broken: Migration = { ...MIGRATIONS[8], sql: `${MIGRATIONS[8].sql}\nselect 1/0;` };
      await t.db.system((tx) => tx.query("update tasks set task_type = 'phone_call'"));
      await expect(migrate(t.db, { env: "local", migrations: [...MIGRATIONS.slice(0, 8), broken] })).rejects.toThrow();
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from pg_constraint where conname = 'customers_crm_status_fk'"))).toEqual([{ n: 0 }]);
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from pg_trigger where tgname = 'customers_assign_active'"))).toEqual([{ n: 0 }]);
      // Az adat javítása után a migráció befejezhető.
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0009_dynamic_crm_statuses"]);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
    } finally {
      await t.cleanup();
    }
  });

  it("dokumentált séma-visszagörgetés (2. szint): v1.0 sémára áll vissza; egyedi státusz használatánál megtagadva, semmi nem változik", async () => {
    const t = await makeTestDb(kind, { migrate: false });
    const sql = readFileSync(join(__dirname, "../../scripts/sql/v1.1-schema-rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    try {
      await migrate(t.db, { env: "local", migrations: V10 });
      await seedV10(t);
      const before = await dump(t);
      await migrate(t.db, { env: "local" });
      await t.db.system((tx) => tx.query("insert into user_permissions (user_id, permission, granted_by) values ('u-2','crm.users.manage','Teszt')"));
      await t.db.system((tx) => tx.query("insert into crm_pipeline_statuses (key, label, sort_order) values ('egyedi','Egyedi',90)"));
      await t.db.system((tx) => tx.query("update customers set crm_status = 'egyedi' where id = 'c-0'"));
      await expect(t.db.system((tx) => tx.exec(sql))).rejects.toThrow(/egyedi \(v1\.1\) státuszban/);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
      await t.db.system((tx) => tx.query("update customers set crm_status = 'waiting_for_contact' where id = 'c-0'"));
      await t.db.system((tx) => tx.exec(sql));
      expect(await checkSchema(t.db, "local", V10)).toEqual({ ok: true });
      const cons = await t.db.system((tx) => tx.query<{ conname: string }>("select conname from pg_constraint where conrelid in ('customers'::regclass,'tasks'::regclass) and conname like '%crm_status%' order by conname"));
      expect(cons.map((c) => c.conname)).toEqual(["customers_crm_status_check", "tasks_crm_status_check"]);
      expect(await t.db.system((tx) => tx.query("select to_regclass('crm_pipeline_statuses') as a, to_regclass('settings_audit') as b"))).toEqual([{ a: null, b: null }]);
      const after = await dump(t);
      for (const table of TABLES.filter((x) => x !== "customers")) expect(after[table], table).toEqual(before[table]);
      expect(after.customers.find((c) => c.id === "c-0")!.crm_status).toBe("waiting_for_contact");
      // Ezután a v1.1 migráció újra alkalmazható (előre-visszalépés).
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0007_crm_settings_permissions", "0008_crm_config_catalogs", "0009_dynamic_crm_statuses"]);
      expect(LATEST_MIGRATION).toBe("0009_dynamic_crm_statuses");
    } finally {
      await t.cleanup();
    }
  });
});
