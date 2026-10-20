import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Tx } from "@/server/db/types";
import { DRIVERS, addPilotUsers, makeTestDb, type TestDb } from "./helpers";

/** Adatbázis-szintű jogosultság (RLS + szerepkör-jogok): a Server Action/API-validáció nem helyettesíti. */
describe.each(DRIVERS)("RLS és jogosultságok (%s)", (kind) => {
  let t: TestDb;
  let a = "";
  let b = "";
  const NOW = "2026-10-12T10:00:00.000Z";

  const asApp = <R,>(userId: string | null, fn: (tx: Tx) => Promise<R>): Promise<R> =>
    t.db.system(async (tx) => {
      await tx.exec("set local role jg_app");
      if (userId !== null) await tx.query("select set_config('app.user_id', $1, true)", [userId]);
      return fn(tx);
    });
  const denied = async (userId: string | null, sql: string, params: unknown[] = []) => {
    let err: unknown;
    try {
      await asApp(userId, (tx) => tx.query(sql, params));
    } catch (e) {
      err = e;
    }
    return String((err as Error | undefined)?.message ?? "");
  };

  beforeAll(async () => {
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    a = u.a.id; b = u.b.id;
    await t.db.system(async (tx) => {
      await tx.query("insert into customers (id, type, display_name, owner_id, created_at, updated_at) values ('c1','individual','Teszt Elek',$1,$2,$2)", [a, NOW]);
      await tx.query("insert into tasks (id, customer_id, title, assignee_id, status, created_at) values ('t1','c1','Telefonhívás',$1,'open',$2)", [a, NOW]);
      await tx.query("insert into task_results (task_id, seq, output_key, closed_at, closed_by) values ('t1',0,'completed',$1,$2)", [NOW, a]);
      await tx.query("insert into activities (id, customer_id, type, occurred_at, summary, recorded_by) values ('a1','c1','note',$1,'x',$2)", [NOW, a]);
      await tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ('c1','objection','fiktív tiltakozás',$1,$2)", [NOW, a]);
      await tx.query("insert into audit_events (user_id, action, entity_type) values ($1,'x','customer')", [a]);
    });
  });
  afterAll(async () => { await t.cleanup(); });

  it("felhasználói kontextus nélkül az alkalmazás-szerepkör semmit nem lát és nem ír", async () => {
    for (const table of ["customers", "tasks", "task_results", "activities", "customer_restrictions", "audit_events", "company_contacts"]) {
      expect(await asApp(null, async (tx) => (await tx.query(`select 1 from ${table}`)).length), table).toBe(0);
    }
    expect(await denied(null, "insert into customers (id, type, display_name, owner_id, created_at, updated_at) values ('c2','individual','X',$1,now(),now())", [a])).toMatch(/row-level security|policy/i);
  });
  it("ismeretlen vagy letiltott felhasználó azonosítóval sem lát adatot", async () => {
    expect(await asApp("u-nincs", async (tx) => (await tx.query("select 1 from customers")).length)).toBe(0);
    await t.db.system((tx) => tx.query("update users set active = false where id = $1", [b]));
    expect(await asApp(b, async (tx) => (await tx.query("select 1 from customers")).length)).toBe(0);
    expect(await denied(b, "update customers set source = 'x'")).toBe("");
    expect(await asApp(b, async (tx) => (await tx.query("update customers set source = 'x' returning id")).length)).toBe(0);
    await t.db.system((tx) => tx.query("update users set active = true where id = $1", [b]));
  });
  it("aktív felhasználó lát és ír (mindkét pilot felhasználó ugyanazt az adatot látja)", async () => {
    for (const u of [a, b]) expect(await asApp(u, async (tx) => (await tx.query("select 1 from customers")).length)).toBe(1);
    await asApp(b, (tx) => tx.query("update tasks set due_at = $1 where id = 't1'", [NOW]));
  });
  it("a felhasználói kontextus nem szivárog a tranzakción túl", async () => {
    await asApp(a, (tx) => tx.query("select 1"));
    expect(await asApp(null, async (tx) => (await tx.query("select 1 from customers")).length)).toBe(0);
  });
  it("törlés semmilyen CRM-táblán nem engedett az alkalmazás-szerepkörnek", async () => {
    for (const table of ["customers", "tasks", "task_results", "activities", "customer_restrictions", "audit_events", "company_contacts", "processes", "contactability", "request_log"]) {
      expect(await denied(a, `delete from ${table}`), table).toMatch(/permission denied/i);
    }
    expect(await denied(a, "truncate customers")).toMatch(/permission denied/i);
  });
  it("a naplók hozzáfűzhetők, de nem módosíthatók (aktivitás, feladat-eredmény, audit)", async () => {
    expect(await denied(a, "update activities set summary = 'y'")).toMatch(/permission denied/i);
    expect(await denied(a, "update task_results set output_key = 'other'")).toMatch(/permission denied/i);
    expect(await denied(a, "update audit_events set action = 'y'")).toMatch(/permission denied/i);
  });
  it("a tiltakozás/korlátozás az alkalmazás-szerepkörnek csak olvasható", async () => {
    expect(await asApp(a, async (tx) => (await tx.query("select 1 from customer_restrictions")).length)).toBe(1);
    expect(await denied(a, "update customer_restrictions set note = 'y'")).toMatch(/permission denied/i);
    expect(await denied(a, "insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ('c1','objection','y',now(),$1)", [a])).toMatch(/permission denied/i);
  });
  it("a hitelesítési és rendszer-táblák az alkalmazás-szerepkörnek nem elérhetők", async () => {
    for (const table of ["users", "sessions", "login_attempts", "meta", "schema_migrations"]) {
      expect(await denied(a, `select * from ${table}`), table).toMatch(/permission denied/i);
    }
  });
  it("az alkalmazás-szerepkör nem szuperfelhasználó, nem kerüli meg az RLS-t, nem tulajdonos", async () => {
    const [r] = await t.db.system((tx) => tx.query<{ rolsuper: boolean; rolbypassrls: boolean; rolcanlogin: boolean }>("select rolsuper, rolbypassrls, rolcanlogin from pg_roles where rolname = 'jg_app'"));
    expect(r).toEqual({ rolsuper: false, rolbypassrls: false, rolcanlogin: false });
    const owned = await t.db.system((tx) => tx.query("select 1 from pg_tables where schemaname = 'public' and tableowner = 'jg_app'"));
    expect(owned).toHaveLength(0);
    const unprotected = await t.db.system((tx) =>
      tx.query<{ tablename: string }>("select c.relname as tablename from pg_class c join pg_namespace n on n.oid = c.relnamespace where n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity"),
    );
    expect(unprotected.map((x) => x.tablename).filter((x) => x !== "schema_migrations")).toEqual([]);
  });
  it("idegen kulcs: nem létező felhasználóra vagy ügyfélre hivatkozó rekord nem rögzíthető", async () => {
    expect(await denied(a, "insert into tasks (id, customer_id, title, assignee_id, status, created_at) values ('t9','nincs','x',$1,'open',now())", [a])).toMatch(/foreign key|violates/i);
    expect(await denied(a, "insert into tasks (id, customer_id, title, assignee_id, status, created_at) values ('t9','c1','x','u-nincs','open',now())")).toMatch(/foreign key|violates/i);
    expect(await denied(a, "insert into tasks (id, customer_id, title, assignee_id, status, created_at) values ('t9','c1','x',$1,'kitalalt',now())", [a])).toMatch(/check|violates/i);
  });
});
