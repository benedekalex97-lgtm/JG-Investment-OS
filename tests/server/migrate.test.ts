import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSchema, checksum, lintMigration, migrate, MIGRATIONS, type Migration } from "@/server/db/migrate";
import { DRIVERS, makeTestDb, type TestDb } from "./helpers";

describe("migráció-lint (additív alapértelmezés)", () => {
  it("a kiadott migrációk additívak: nincs destruktív utasítás", () => {
    for (const m of MIGRATIONS) expect(lintMigration(m), m.id).toEqual({ destructive: [], allowed: false });
  });
  it.each([
    "drop table customers;", "DROP COLUMN x", "truncate tasks;", "delete from tasks;", "alter table t drop column c;", "alter table t alter column c type int;",
    "alter table t disable row level security;",
  ])("destruktívként ismeri fel: %s", (sql) => {
    expect(lintMigration({ id: "x", description: "", sql }).destructive.length).toBeGreaterThan(0);
  });
  it("a megjegyzésben szereplő szó nem számít, a jóváhagyás-jelölés felismerhető", () => {
    expect(lintMigration({ id: "x", description: "", sql: "-- drop table nincs\ncreate table a (id int);" }).destructive).toEqual([]);
    expect(lintMigration({ id: "x", description: "", sql: "-- allow-destructive: TICKET-1\ndrop table a;" })).toMatchObject({ allowed: true });
  });
});

describe.each(DRIVERS)("migrációfuttató (%s)", (kind) => {
  let t: TestDb;
  beforeAll(async () => { t = await makeTestDb(kind, { migrate: false }); });
  afterAll(async () => { await t.cleanup(); });

  it("üres adatbázison alkalmaz, második futtatás nem változtat (idempotens); környezetet rögzít", async () => {
    expect((await checkSchema(t.db, "local")).ok).toBe(false);
    const first = await migrate(t.db, { env: "local" });
    expect(first.applied).toEqual(MIGRATIONS.map((m) => m.id));
    const second = await migrate(t.db, { env: "local" });
    expect(second).toEqual({ applied: [], alreadyApplied: MIGRATIONS.map((m) => m.id) });
    expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
  });
  it("nem hoz létre üzleti adatot (nincs automatikus seed)", async () => {
    for (const table of ["customers", "tasks", "task_results", "activities", "users"]) {
      const [{ n }] = await t.db.system((tx) => tx.query<{ n: string }>(`select count(*) as n from ${table}`));
      expect(Number(n), table).toBe(0);
    }
  });
  it("más környezet-címkével nem fut és a séma-ellenőrzés sem engedi (preview nem érheti el a local/production adatbázist)", async () => {
    await expect(migrate(t.db, { env: "production" })).rejects.toThrow(/eltér/);
    expect(await checkSchema(t.db, "preview")).toEqual({ ok: false, reason: "environment_mismatch" });
    expect(await checkSchema(t.db, "production")).toEqual({ ok: false, reason: "environment_mismatch" });
  });
  it("az alkalmazott migráció módosítása felismerhető (ellenőrzőösszeg)", async () => {
    const tampered: Migration = { ...MIGRATIONS[0], sql: MIGRATIONS[0].sql + "\n-- módosítva" };
    expect(checksum(tampered)).not.toBe(checksum(MIGRATIONS[0]));
    await expect(migrate(t.db, { env: "local", migrations: [tampered] })).rejects.toThrow(/megváltozott/);
  });
  it("destruktív migráció jóváhagyás nélkül nem fut; jóváhagyva sem engedélyezés nélkül", async () => {
    const bad: Migration = { id: "9999_x", description: "", sql: "drop table customers;" };
    await expect(migrate(t.db, { env: "local", migrations: [...MIGRATIONS, bad] })).rejects.toThrow(/jóváhagyás-jelölés nélkül/);
    const marked: Migration = { id: "9999_y", description: "", sql: "-- allow-destructive: TEST-1\ndrop table customers;" };
    await expect(migrate(t.db, { env: "local", migrations: [...MIGRATIONS, marked] })).rejects.toThrow(/JG_ALLOW_DESTRUCTIVE_MIGRATION/);
    const [{ ok }] = await t.db.system((tx) => tx.query<{ ok: boolean }>("select to_regclass('public.customers') is not null as ok"));
    expect(ok).toBe(true);
  });
  it("új, additív migráció meglévő adat mellett fut és az adat megmarad", async () => {
    await t.db.system((tx) => tx.query("insert into users (id, email, name, password_hash) values ('u-mig', 'mig@example.test', 'Mig', 'x')"));
    const add: Migration = { id: "9000_add_col", description: "", sql: "alter table customers add column if not exists test_flag boolean;" };
    const r = await migrate(t.db, { env: "local", migrations: [...MIGRATIONS, add] });
    expect(r.applied).toEqual(["9000_add_col"]);
    const [{ n }] = await t.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from users where id = 'u-mig'"));
    expect(Number(n)).toBe(1);
  });
});

/** 0003 (v0.9): a v0.8 sémán (0001+0002) meglévő adat mellett fut; a régi Output-adat változatlan, minősítést nem kap. */
describe.each(DRIVERS)("0003_task_outcome: v0.8 adatbázis frissítése (%s)", (kind) => {
  let t: TestDb;
  beforeAll(async () => {
    t = await makeTestDb(kind, { migrate: false });
    await migrate(t.db, { env: "local", migrations: MIGRATIONS.slice(0, 2) });
  });
  afterAll(async () => { await t.cleanup(); });

  it("v0.8 adatokkal migrál, a régi sorok megmaradnak, outcome = NULL; új minősített lezárás írható; idempotens", async () => {
    const T0 = "2026-05-01T08:00:00.000Z";
    await t.db.system(async (tx) => {
      await tx.query("insert into users (id, email, name, password_hash) values ('u-1', 'v08@example.test', 'V08', 'x')");
      await tx.query("insert into customers (id, type, display_name, first_name, last_name, owner_id, created_at, updated_at) values ('c-1','individual','Régi Rita','Rita','Régi','u-1',$1,$1)", [T0]);
      await tx.query("insert into tasks (id, customer_id, title, assignee_id, status, created_at, completed_at) values ('t-1','c-1','Telefonhívás','u-1','done',$1,$1)", [T0]);
      await tx.query("insert into task_results (task_id, seq, output_key, output_text, closed_at, closed_by) values ('t-1',0,'not_reached','',$1,'u-1'), ('t-1',1,null,'Régi szabad szöveg',$1,'u-1')", [T0]);
    });
    const before = await t.db.system((tx) => tx.query("select task_id, seq, output_key, output_text, closed_at, closed_by from task_results order by seq"));
    const r = await migrate(t.db, { env: "local" });
    expect(r.applied).toEqual(["0003_task_outcome"]);
    expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
    const after = await t.db.system((tx) => tx.query<Record<string, unknown>>("select task_id, seq, output_key, output_text, closed_at, closed_by, outcome from task_results order by seq"));
    expect(after.map(({ outcome, ...rest }) => { expect(outcome).toBeNull(); return rest; })).toEqual(before);
    await t.db.system((tx) => tx.query("insert into task_results (task_id, seq, outcome, output_text, closed_at, closed_by) values ('t-1',2,'success','Új lezárás',now(),'u-1')"));
    await expect(t.db.system((tx) => tx.query("insert into task_results (task_id, seq, outcome, output_text, closed_at, closed_by) values ('t-1',3,'failure',' ',now(),'u-1')"))).rejects.toThrow();
    // v0.8 írási minta (outcome nélkül, üres szöveggel) továbbra is elfogadott - a visszaállás (rollback) nem törik el.
    await t.db.system((tx) => tx.query("insert into task_results (task_id, seq, output_key, output_text, closed_at, closed_by) values ('t-1',3,'completed','',now(),'u-1')"));
    expect((await migrate(t.db, { env: "local" })).applied).toEqual([]);
  });
});
