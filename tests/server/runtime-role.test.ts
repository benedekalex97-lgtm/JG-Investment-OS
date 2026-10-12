import { randomBytes } from "node:crypto";
import { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSchema, migrate } from "@/server/db/migrate";
import { createPgDb } from "@/server/db/pg-driver";
import { provisionRuntimeRole, validateRuntimeRole } from "@/server/db/runtime-role";
import { scramSha256Verifier } from "@/server/db/scram";
import type { Db } from "@/server/db/types";
import { PASSWORD_A, addPilotUsers, client, makeApi, makeTestDb, type TestDb } from "./helpers";

describe("futási szerepkör: bemenet-ellenőrzés", () => {
  it("érvénytelen név vagy gyenge jelszó elutasítva", () => {
    const pw = "x".repeat(24);
    for (const name of ["jg_app", "pg_monitor", "Nagy", "a", "rossz-nev", 'x";drop', "1abc"]) expect(() => validateRuntimeRole({ name, password: pw }), name).toThrow();
    expect(() => validateRuntimeRole({ name: "jg_runtime", password: "rovid" })).toThrow(/24/);
    expect(() => validateRuntimeRole({ name: "jg_runtime", password: pw })).not.toThrow();
    expect(() => validateRuntimeRole({ name: "jg_runtime", password: "x".repeat(20) + " abcd" })).toThrow(/ASCII/);
    expect(() => validateRuntimeRole({ name: "jg_runtime", password: "á".repeat(30) })).toThrow(/ASCII/);
  });
});

describe("SCRAM-SHA-256 verifier", () => {
  it("formátum: iteráció, só, StoredKey, ServerKey; a tiszta jelszó nincs benne; véletlen sóval minden hívás más", () => {
    const v = scramSha256Verifier("titkos-jelszo-1234567890abcd");
    expect(v).toMatch(/^SCRAM-SHA-256\$4096:[A-Za-z0-9+/]{22}==\$[A-Za-z0-9+/]{43}=:[A-Za-z0-9+/]{43}=$/);
    expect(v).not.toContain("titkos");
    expect(scramSha256Verifier("titkos-jelszo-1234567890abcd")).not.toBe(v);
    expect(scramSha256Verifier("x", { salt: Buffer.alloc(16, 1) })).toBe(scramSha256Verifier("x", { salt: Buffer.alloc(16, 1) }));
  });
  it("az RFC 7677 tesztvektor: a verifier kulcsaiból a hivatalos kliens-bizonyíték és szerver-aláírás adódik", async () => {
    const { createHmac, createHash } = await import("node:crypto");
    const v = scramSha256Verifier("pencil", { salt: Buffer.from("W22ZaJ0SNY7soEsUEjb6gQ==", "base64") });
    const [, , keys] = v.split("$");
    const [stored, server] = keys.split(":").map((k) => Buffer.from(k, "base64"));
    const authMessage = "n=user,r=rOprNGfwEbeRWgbNEkqO,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0,s=W22ZaJ0SNY7soEsUEjb6gQ==,i=4096,c=biws,r=rOprNGfwEbeRWgbNEkqO%hvYDpWUa2RaTCAfuxFIlj)hNlF$k0";
    const clientSig = createHmac("sha256", stored).update(authMessage).digest();
    const serverSig = createHmac("sha256", server).update(authMessage).digest().toString("base64");
    expect(serverSig).toBe("6rriTRBi23WpRR/wtup+mMhUZUn/dB5nLTJRsjl95G4=");
    // ClientProof = ClientKey XOR ClientSignature; a hivatalos érték: dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=
    const proof = Buffer.from("dHzbZapWIk4jUhN+Ute9ytag9zjfMHgsqmmiz7AndVQ=", "base64");
    const clientKey = Buffer.from(proof.map((b, i) => b ^ clientSig[i]));
    expect(createHash("sha256").update(clientKey).digest().equals(stored)).toBe(true);
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

  it("a jelszó SCRAM-SHA-256 verifierként tárolódik; a tiszta jelszó nem szerepel az adatbázisban", async () => {
    const [r] = await owner.db.system((tx) => tx.query<{ rolpassword: string }>(`select rolpassword from pg_authid where rolname = '${role}'`));
    expect(r.rolpassword).toMatch(/^SCRAM-SHA-256\$4096:/);
    expect(r.rolpassword).not.toContain(password);
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

/**
 * Neon-szerű tulajdonos: NEM szuperfelhasználó, de CREATEROLE + CREATEDB + BYPASSRLS (a Neon `<db>_owner` szerepköre ilyen).
 * PostgreSQL 16+ alatt ez a szerepkör meglévő szerepkörön nem adhat meg privilegizált attribútum-opciót (pl. NOSUPERUSER) - a szuperfelhasználós
 * tesztek ezt elfedik. Ez a teszt a provisioning újrafuttatását (jelszócsere) és a tiltott attribútumok kezelését ilyen tulajdonossal ellenőrzi.
 */
describe.skipIf(!process.env.JG_TEST_DATABASE_URL)("futási szerepkör: Neon-szerű (nem szuperfelhasználó) tulajdonossal", () => {
  const tag = randomBytes(4).toString("hex");
  const ownerRole = `jgt_own_${tag}`;
  const ownerPw = randomBytes(16).toString("hex");
  const dbName = `jgt_neon_${tag}`;
  const runtime = `jg_rt_${tag}`;
  let admin: Pool;
  let ownerDb: Db;

  const urlFor = (user: string, pw: string) => {
    const u = new URL(process.env.JG_TEST_DATABASE_URL as string);
    u.pathname = `/${dbName}`;
    u.username = user;
    u.password = pw;
    return u.toString();
  };
  const denied = async (fn: () => Promise<unknown>) => {
    try {
      await fn();
    } catch (e) {
      return String((e as Error).message);
    }
    return "";
  };

  beforeAll(async () => {
    admin = new Pool({ connectionString: process.env.JG_TEST_DATABASE_URL, max: 1 });
    await admin.query(`create role "${ownerRole}" login createrole createdb bypassrls nosuperuser password '${ownerPw}'`);
    await admin.query(`create database "${dbName}" owner "${ownerRole}"`);
    // A Neonon a jg_app szerepkört a tulajdonos hozta létre (ADMIN OPTION-nel); itt a hermetikus tesztklaszteren ezt szimuláljuk.
    await admin.query("do $$ begin if not exists (select 1 from pg_roles where rolname = 'jg_app') then create role jg_app nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls; end if; end $$");
    await admin.query(`grant jg_app to "${ownerRole}" with admin option`);
    ownerDb = createPgDb(urlFor(ownerRole, ownerPw));
    await migrate(ownerDb, { env: "local" });
  });
  afterAll(async () => {
    await ownerDb.close();
    await admin.query(`drop database if exists "${dbName}" with (force)`);
    await admin.query(`drop role if exists "${runtime}"`);
    await admin.query(`drop role if exists "${ownerRole}"`);
    await admin.end();
  });

  it("a tulajdonos valóban nem szuperfelhasználó, a migráció mégis lefutott", async () => {
    const [r] = await ownerDb.system((tx) => tx.query<{ rolsuper: boolean }>("select rolsuper from pg_roles where rolname = current_user"));
    expect(r.rolsuper).toBe(false);
    expect(await checkSchema(ownerDb, "local")).toEqual({ ok: true });
  });

  it("létrehozás, majd újrafuttatás (jelszócsere) nem szuperfelhasználó tulajdonossal is működik; a régi jelszó érvénytelen, az új jó", async () => {
    const first = randomBytes(24).toString("hex");
    const second = randomBytes(24).toString("hex");
    await provisionRuntimeRole(ownerDb, { name: runtime, password: first });
    const a = createPgDb(urlFor(runtime, first));
    expect(await checkSchema(a, "local")).toEqual({ ok: true });
    await a.close();
    await provisionRuntimeRole(ownerDb, { name: runtime, password: second });
    const old = createPgDb(urlFor(runtime, first));
    expect(await denied(() => old.system((tx) => tx.query("select 1")))).toMatch(/password authentication failed/i);
    await old.close();
    const fresh = createPgDb(urlFor(runtime, second));
    expect(await checkSchema(fresh, "local")).toEqual({ ok: true });
    expect(await denied(() => fresh.system((tx) => tx.exec("create table x (id int)")))).toMatch(/permission denied/i);
    await fresh.close();
    const [attrs] = await ownerDb.system((tx) => tx.query<Record<string, boolean>>(`select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolinherit, rolcanlogin from pg_roles where rolname = '${runtime}'`));
    expect(attrs).toEqual({ rolsuper: false, rolcreatedb: false, rolcreaterole: false, rolbypassrls: false, rolinherit: false, rolcanlogin: true });
  });

  it("ha a meglévő futási szerepkör privilegizált (CREATEROLE/BYPASSRLS), a provisioning megáll és nem kerüli meg", async () => {
    await admin.query(`alter role "${runtime}" createrole bypassrls`);
    const msg = await denied(() => provisionRuntimeRole(ownerDb, { name: runtime, password: randomBytes(24).toString("hex") }));
    expect(msg).toMatch(/CREATEROLE/);
    expect(msg).toMatch(/BYPASSRLS/);
    expect(msg).toMatch(/Kézi javítás/);
    await admin.query(`alter role "${runtime}" nocreaterole nobypassrls`);
    await provisionRuntimeRole(ownerDb, { name: runtime, password: randomBytes(24).toString("hex") });
  });
});
