import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSchema } from "@/server/db/migrate";
import { createPgDb } from "@/server/db/pg-driver";
import { provisionRuntimeRole, validateRuntimeRole } from "@/server/db/runtime-role";
import type { Db } from "@/server/db/types";
import { PASSWORD_A, addPilotUsers, client, makeApi, makeTestDb, type TestDb } from "./helpers";

describe("futási szerepkör: bemenet-ellenőrzés", () => {
  it("érvénytelen név vagy gyenge jelszó elutasítva", () => {
    const pw = "x".repeat(24);
    for (const name of ["jg_app", "pg_monitor", "Nagy", "a", "rossz-nev", 'x";drop', "1abc"]) expect(() => validateRuntimeRole({ name, password: pw }), name).toThrow();
    expect(() => validateRuntimeRole({ name: "jg_runtime", password: "rovid" })).toThrow(/24/);
    expect(() => validateRuntimeRole({ name: "jg_runtime", password: pw })).not.toThrow();
  });
});

/** Valódi PostgreSQL szükséges (több szerepkör, külön bejelentkezés): JG_TEST_DATABASE_URL megadásakor fut. */
describe.skipIf(!process.env.JG_TEST_DATABASE_URL)("futási szerepkör: legkisebb jogosultság (valódi PostgreSQL)", () => {
  let owner: TestDb;
  let rt: Db;
  const role = `jg_rt_${randomBytes(4).toString("hex")}`;
  const password = randomBytes(24).toString("hex");

  const denied = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return String((e as Error).message);
    }
    return "";
  };
  const runtimeUrl = (pw: string) => {
    const u = new URL(owner.url as string);
    u.username = role;
    u.password = pw;
    return u.toString();
  };

  beforeAll(async () => {
    owner = await makeTestDb("pg");
    await addPilotUsers(owner.db);
    await provisionRuntimeRole(owner.db, { name: role, password });
    rt = createPgDb(runtimeUrl(password));
  });
  afterAll(async () => {
    await rt.close();
    await owner.cleanup();
    const admin = new Pool({ connectionString: process.env.JG_TEST_DATABASE_URL, max: 1 });
    await admin.query(`drop role if exists "${role}"`);
    await admin.end();
  });

  it("a szerepkör attribútumai: bejelentkezhet, de nem szuperfelhasználó, nem hozhat létre adatbázist/szerepkört, nincs BYPASSRLS, nem tulajdonos", async () => {
    const [r] = await owner.db.system((tx) => tx.query<Record<string, boolean>>(`select rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit from pg_roles where rolname = '${role}'`));
    expect(r).toEqual({ rolcanlogin: true, rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolinherit: false });
    expect(await owner.db.system((tx) => tx.query(`select 1 from pg_class where relowner = '${role}'::regrole`))).toHaveLength(0);
  });

  it("a teljes alkalmazás-folyamat működik a futási szerepkörrel: belépés, ügyfél, feladat, lezárás, pillanatkép, kijelentkezés", async () => {
    const c = client(makeApi(rt));
    expect((await c.login("pilot.egy@example.test", PASSWORD_A)).status).toBe(200);
    const cust = (await c.op<{ customer: { id: string } }>("customer.create", { input: { type: "company", companyName: "Futási Kft.", contactName: "Teszt Béla" } })).body.result.value!.customer;
    const task = (await c.op<{ id: string }>("task.create", { input: { customerId: cust.id, taskType: "email", inputKey: "first_contact" } })).body.result.value!;
    expect((await c.op("task.close", { taskId: task.id, input: { outputKey: "completed" } })).body.result.ok).toBe(true);
    expect((await c.op("customer.changeStatus", { customerId: cust.id, input: { toStatus: "contact" } })).body.result.ok).toBe(true);
    const snap = (await (await c.get("/api/crm/snapshot")).json()) as { snapshot: { customers: unknown[]; tasks: { status: string }[] }; users: unknown[] };
    expect(snap.snapshot.customers).toHaveLength(1);
    expect(snap.snapshot.tasks[0].status).toBe("done");
    expect(snap.users).toHaveLength(2);
    expect((await c.get("/api/status")).status).toBe(200);
    expect((await c.post("/api/auth/logout")).status).toBe(200);
    expect((await c.get("/api/crm/snapshot")).status).toBe(401);
    expect(await checkSchema(rt, "local")).toEqual({ ok: true });
    const [{ n }] = await owner.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from audit_events"));
    expect(Number(n)).toBeGreaterThanOrEqual(4);
  });

  it("séma-kezelés tilos: nem hozhat létre, módosíthat, törölhet táblát, szerepkört vagy adatbázist", async () => {
    for (const sql of ["create table x (id int)", "alter table customers add column x int", "drop table customers", "truncate customers", "create role ujszerep", "alter table customers disable row level security", "drop policy app_access on customers"]) {
      expect(await denied(() => rt.system((tx) => tx.exec(sql))), sql).toMatch(/permission denied|must be owner|must have/i);
    }
  });

  it("a CRM-táblák közvetlenül nem érhetők el; csak a jg_app szerepkörön át, felhasználói azonosítóval, RLS-sel", async () => {
    for (const t of ["customers", "tasks", "task_results", "activities", "audit_events", "customer_restrictions", "request_log"]) {
      expect(await denied(() => rt.system((tx) => tx.query(`select 1 from ${t}`))), t).toMatch(/permission denied/i);
    }
    expect(await rt.asUser("u-nincs", async (tx) => (await tx.query("select 1 from customers")).length)).toBe(0);
    expect(await denied(() => rt.asUser("u-nincs", (tx) => tx.query("delete from customers")))).toMatch(/permission denied/i);
  });

  it("a hitelesítési táblákon csak a szükséges műveletek: nincs jelszó-módosítás, felhasználó-létrehozás vagy -törlés, nincs meta-módosítás", async () => {
    expect(await denied(() => rt.system((tx) => tx.query("update users set password_hash = 'x'")))).toMatch(/permission denied/i);
    expect(await denied(() => rt.system((tx) => tx.query("update users set active = false")))).toMatch(/permission denied/i);
    expect(await denied(() => rt.system((tx) => tx.query("insert into users (id, email, name, password_hash) values ('u-x','x@example.test','x','x')")))).toMatch(/permission denied/i);
    expect(await denied(() => rt.system((tx) => tx.query("delete from users")))).toMatch(/permission denied/i);
    expect(await denied(() => rt.system((tx) => tx.query("update meta set value = 'production'")))).toMatch(/permission denied/i);
    expect(await denied(() => rt.system((tx) => tx.query("insert into schema_migrations (id, checksum) values ('x','x')")))).toMatch(/permission denied/i);
    expect(await denied(() => rt.system((tx) => tx.query("update users set last_login_at = now()")))).toBe("");
  });

  it("idempotens: újrafuttatva (új jelszóval) működik, a régi jelszó érvénytelen; az adat érintetlen", async () => {
    const before = await owner.db.system((tx) => tx.query("select count(*)::int as n from users"));
    const next = randomBytes(24).toString("hex");
    await provisionRuntimeRole(owner.db, { name: role, password: next });
    const old = createPgDb(runtimeUrl(password));
    // Jelszavas hitelesítést alkalmazó szerveren (scram) a régi jelszó azonnal érvénytelen.
    expect(await denied(() => old.system((tx) => tx.query("select 1")))).toMatch(/password authentication failed/i);
    await old.close();
    const fresh = createPgDb(runtimeUrl(next));
    expect(await checkSchema(fresh, "local")).toEqual({ ok: true });
    await fresh.close();
    expect(await owner.db.system((tx) => tx.query("select count(*)::int as n from users"))).toEqual(before);
  });
});
