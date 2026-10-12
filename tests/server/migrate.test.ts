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
