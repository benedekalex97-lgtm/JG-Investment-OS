import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { restoreCustomer } from "@/server/admin";
import { exportBackup, restoreBackup } from "@/server/backup";
import { LATEST_MIGRATION } from "@/server/db/migrate";
import { features } from "@/server/features";
import type { Customer, DataSnapshot, Task } from "@/domain/types";
import { revokePermission } from "@/server/data/permissions";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";
import { grant, OPERATOR } from "./data-helpers";

/** A korábbi (v0.9-v1.1) kapcsoló, amely v1.1.1-től semmit nem kapcsol be: a törléshez a crm.customer.delete jog kell. */
const OLD_FLAG = "JG_TEST_CUSTOMER_DELETE_ENABLED";

describe("funkciókapcsoló", () => {
  it("D1: a régi tesztügyfél-törlési kapcsoló megszűnt (nem ad törlési lehetőséget)", () => {
    expect(features({})).toEqual({ customerImport: false });
    expect(features({ [OLD_FLAG]: "true" })).toEqual({ customerImport: false });
  });
});

describe.each(DRIVERS)("CRM-006 tesztügyfél logikai eltávolítása (%s)", (kind) => {
  let t: TestDb;
  let c: Client;
  let worker: Client;
  let userId = "";
  let workerId = "";
  beforeAll(async () => {
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    userId = u.a.id;
    workerId = u.b.id;
    // v1.1.1: az ügyféltörlés adminjog; az admin (pilot.egy) kifejezetten megkapja, a munkatárs (pilot.ketto) nem.
    await grant(t.db, "pilot.egy@example.test", "crm.customer.delete");
    c = client(makeApi(t.db));
    worker = client(makeApi(t.db));
    await c.login("pilot.egy@example.test", PASSWORD_A);
    await worker.login("pilot.ketto@example.test", PASSWORD_B);
  });
  afterAll(async () => { await t.cleanup(); });
  afterEach(() => { delete process.env[OLD_FLAG]; });

  const snap = async () => ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: DataSnapshot }).snapshot;
  const raw = (sql: string, p: unknown[] = []) => t.db.system((tx) => tx.query<Record<string, unknown>>(sql, p));
  let seq = 0;
  const seedCustomer = async (name: string) => {
    // Egyedi telefonszám ügyfelenként (az azonos szám erős duplikáció-egyezés lenne, CRM-013).
    const phone = `+36 1 555 ${String(1000 + ++seq)}`;
    const cust = (await c.op<{ customer: Customer }>("customer.create", { input: { type: "company", acquisitionChannel: "egyeb", companyName: name, contactName: "Teszt Kapcsolattartó", phone } })).body.result.value!.customer;
    const task = (await c.op<Task>("task.create", { input: { customerId: cust.id, taskType: "phone_call", dueAt: new Date().toISOString() } })).body.result.value!;
    await c.op("task.close", { taskId: task.id, input: { outcome: "success", output: "Teszt lezárás" } });
    await c.op("task.reopen", { taskId: task.id });
    await c.op("note.create", { customerId: cust.id, text: "Teszt jegyzet" });
    await c.op("customer.changeStatus", { customerId: cust.id, input: { toStatus: "contact" } });
    return { cust, task };
  };

  it("D1/D14: csak az ügyféltörlési jogú admin törölhet - a munkatársat a szerver elutasítja (a régi kapcsolóval is), naplózza, és a DB is tilt", async () => {
    const { cust } = await seedCustomer("Jogosultság Kft.");
    process.env[OLD_FLAG] = "true";
    const r = await worker.op("customer.delete", { customerId: cust.id, confirmation: "TÖRLÉS" });
    expect(r.body.result).toMatchObject({ ok: false, errors: { _form: expect.stringMatching(/ügyféltörlési joggal/) } });
    expect((await snap()).customers.some((x) => x.id === cust.id)).toBe(true);
    expect((await raw("select action, user_id from audit_events where customer_id = $1 and action = 'customer.delete_denied'", [cust.id]))).toEqual([{ action: "customer.delete_denied", user_id: workerId }]);
    // A felület megkerülésével sem: az alkalmazás szerepköre jog nélkül nem írhatja az eltávolítás-jelölést.
    await expect(t.db.asUser(workerId, (tx) => tx.query("update customers set deleted_at = now(), deleted_by = $2 where id = $1", [cust.id, workerId]))).rejects.toThrow(/forbidden_customer_delete/);
    await expect(t.db.asUser(workerId, (tx) => tx.query("insert into customers (id, type, display_name, owner_id, created_at, updated_at, deleted_at, deleted_by) values ('c-x','individual','X',$1,now(),now(),now(),$1)", [workerId]))).rejects.toThrow(/forbidden_customer_delete/);
    // A jog a felület menüjébe is kijut (csak megjelenítés; a szerver minden kérésnél ellenőriz).
    expect(((await (await c.get("/api/auth/me")).json()) as { permissions: string[] }).permissions).toContain("crm.customer.delete");
    expect(((await (await worker.get("/api/auth/me")).json()) as { permissions: string[] }).permissions).not.toContain("crm.customer.delete");
    expect(((await (await c.get("/api/auth/me")).json()) as { features: unknown }).features).toEqual({ customerImport: false });
  });

  it("D2: munkamenet nélkül 401, adat nem változik", async () => {
    const { cust } = await seedCustomer("Jogosulatlan Kft.");
    const anon = client(makeApi(t.db));
    expect((await anon.post("/api/crm/op", { requestId: crypto.randomUUID(), op: "customer.delete", args: { customerId: cust.id, confirmation: "TÖRLÉS" } })).status).toBe(401);
    expect((await raw("select deleted_at from customers where id = $1", [cust.id]))[0].deleted_at).toBeNull();
  });

  it("D3/D4: megerősítő szó nélkül vagy hibásan nem töröl", async () => {
    const { cust } = await seedCustomer("Megerősítés Kft.");
    for (const confirmation of ["", "torles", "TÖRLÉS!", "igen"]) {
      expect((await c.op("customer.delete", { customerId: cust.id, confirmation })).body.result).toMatchObject({ ok: false, errors: { confirmation: expect.any(String) } });
    }
    expect((await c.op("customer.delete", { customerId: cust.id })).status).toBe(400);
    expect((await snap()).customers.some((x) => x.id === cust.id)).toBe(true);
  });

  it("D5-D13: logikai törlés; eltűnik az aktív adatból; minden kapcsolódó adat megmarad; a törölt ügyfél API-n sem módosítható; ismételt törlés ártalmatlan", async () => {
    const keep = await seedCustomer("Marad Kft.");
    const { cust, task } = await seedCustomer("Törlendő Kft.");
    const counts = async () => Object.fromEntries(await Promise.all(["company_contacts", "tasks", "task_results", "activities"].map(async (tb) => {
      const col = tb === "company_contacts" ? "company_id" : tb === "task_results" ? "(select customer_id from tasks where id = task_id)" : "customer_id";
      return [tb, Number((await raw(`select count(*) as n from ${tb} where ${col} = $1`, [cust.id]))[0].n)];
    })));
    const before = await counts();
    const r = await c.op("customer.delete", { customerId: cust.id, confirmation: "TÖRLÉS" });
    expect(r.body.result).toEqual({ ok: true, value: { id: cust.id } });
    // D6/D7/D8/D9: a válasz-snapshot és az új lekérés sem tartalmazza (lista, pipeline, számlálók, kereső, feladatlisták ebből dolgoznak).
    for (const s of [r.body.snapshot, await snap()]) {
      expect(s.customers.map((x) => x.id)).not.toContain(cust.id);
      expect(s.tasks.some((x) => x.customerId === cust.id)).toBe(false);
      expect(s.activities.some((x) => x.customerId === cust.id)).toBe(false);
      expect(s.contacts.some((x) => x.companyId === cust.id)).toBe(false);
      expect(s.customers.map((x) => x.id)).toContain(keep.cust.id);
    }
    // D5/D10: csak a két mező töltődött; a feladatok, Outputok, jegyzetek, előzmények, kapcsolattartók és az audit megmaradtak.
    const row = (await raw("select deleted_at, deleted_by, company_name, crm_status from customers where id = $1", [cust.id]))[0];
    expect(row).toMatchObject({ deleted_by: userId, company_name: "Törlendő Kft.", crm_status: "contact" });
    expect(row.deleted_at).not.toBeNull();
    expect(await counts()).toEqual(before);
    expect(before).toMatchObject({ company_contacts: 1, tasks: 1, task_results: 1 });
    const audit = await raw("select action, user_id from audit_events where customer_id = $1 order by id", [cust.id]);
    expect(audit.at(-1)).toEqual({ action: "customer.soft_delete", user_id: userId });
    expect(audit.length).toBeGreaterThan(5);
    // D12: semmilyen művelet nem hajtható végre a törölt ügyfélen vagy a feladatain.
    const attempts = [
      c.op("task.create", { input: { customerId: cust.id, taskType: "email" } }),
      c.op("note.create", { customerId: cust.id, text: "Tiltott jegyzet" }),
      c.op("task.close", { taskId: task.id, input: { outcome: "failure", output: "Tiltott lezárás" } }),
      c.op("task.setDue", { taskId: task.id, dueAt: null }),
      c.op("customer.update", { id: cust.id, input: { type: "company", companyName: "Átírt Kft." } }),
      c.op("customer.changeStatus", { customerId: cust.id, input: { toStatus: "lost" } }),
    ];
    for (const a of await Promise.all(attempts)) expect(a.body.result).toMatchObject({ ok: false, errors: { _form: "A rekord nem található." } });
    expect(await counts()).toEqual(before);
    expect((await raw("select company_name, crm_status from customers where id = $1", [cust.id]))[0]).toEqual({ company_name: "Törlendő Kft.", crm_status: "contact" });
    // D13: ismételt törlés nem okoz hibát és nem módosít (az időpont és az eltávolító marad).
    const again = await c.op("customer.delete", { customerId: cust.id, confirmation: "TÖRLÉS" });
    expect(again.body.result).toMatchObject({ ok: false });
    expect((await raw("select deleted_at from customers where id = $1", [cust.id]))[0].deleted_at).toEqual(row.deleted_at);
    // D14: a jog visszavonása után (a meglévő munkamenettel is) újabb törlés nem lehetséges; újra kiosztva ismét igen.
    await revokePermission(t.db, { email: "pilot.egy@example.test", permission: "crm.customer.delete", operator: OPERATOR, env: "local" });
    expect((await c.op("customer.delete", { customerId: keep.cust.id, confirmation: "TÖRLÉS" })).body.result).toMatchObject({ ok: false });
    await grant(t.db, "pilot.egy@example.test", "crm.customer.delete");

    // D11: a mentés a törölt ügyfelet és teljes történetét tartalmazza; a visszaállítás után is törölt marad.
    const b = JSON.parse(JSON.stringify(await exportBackup(t.db, "local")));
    expect(b.migration).toBe(LATEST_MIGRATION);
    expect(b.tables.customers.find((x: { id: string }) => x.id === cust.id)).toMatchObject({ deleted_by: userId });
    const dst = await makeTestDb(kind);
    await restoreBackup(dst.db, b, "local");
    const restored = await dst.db.system((tx) => tx.query<Record<string, unknown>>("select deleted_by from customers where id = $1", [cust.id]));
    expect(restored).toEqual([{ deleted_by: userId }]);
    await dst.cleanup();

    // Adminisztratív visszaállítás: a mezők ürülnek, az ügyfél és minden adata ismét aktív; auditált.
    expect(await restoreCustomer(t.db, cust.id, "pilot.egy@example.test")).toEqual({ restored: true });
    expect(await restoreCustomer(t.db, cust.id, "pilot.egy@example.test")).toEqual({ restored: false });
    await expect(restoreCustomer(t.db, cust.id, "nincs@example.test")).rejects.toThrow(/aktív/);
    const back = await snap();
    expect(back.customers.find((x) => x.id === cust.id)).toMatchObject({ companyName: "Törlendő Kft.", crmStatus: "contact" });
    expect(back.tasks.find((x) => x.id === task.id)!.outputs).toHaveLength(1);
    expect(back.activities.some((a) => a.customerId === cust.id && a.type === "note")).toBe(true);
    expect((await raw("select action from audit_events where customer_id = $1 order by id desc limit 1", [cust.id]))[0].action).toBe("customer.restore");
  });
});
