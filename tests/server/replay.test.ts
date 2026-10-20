import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { restoreCustomer } from "@/server/admin";
import type { Customer, Task } from "@/domain/types";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";

const FLAG = "JG_TEST_CUSTOMER_DELETE_ENABLED";
const SECRET_NAME = "Titkos Tímea";
const SECRET_NOTE = "Bizalmas jegyzet: 06 30 999 0000";

/**
 * Idempotens újraküldés (request_log) és logikai törlés: a tárolt válasz sem adhat vissza eltávolított ügyfélhez tartozó adatot.
 * Az ellenőrzés a TÁROLT eredményhez tartozó ügyfélre vonatkozik, nem az újraküldött args-ra.
 */
describe.each(DRIVERS)("idempotens újraküldés és eltávolított ügyfél (%s)", (kind) => {
  let t: TestDb;
  let a: Client;
  let b: Client;
  let seq = 0;
  beforeAll(async () => {
    t = await makeTestDb(kind);
    await addPilotUsers(t.db);
    a = client(makeApi(t.db));
    b = client(makeApi(t.db));
    await a.login("pilot.egy@example.test", PASSWORD_A);
    await b.login("pilot.ketto@example.test", PASSWORD_B);
  });
  afterAll(async () => { await t.cleanup(); });
  afterEach(() => { delete process.env[FLAG]; });

  const count = async (table: string) => Number((await t.db.system((tx) => tx.query<{ n: string }>(`select count(*) as n from ${table}`)))[0].n);
  const newCustomer = async (name: string, rid = randomUUID()) => {
    const r = await a.op<{ customer: Customer }>("customer.create", { input: { type: "individual", name, phone: `+36 30 400 ${String(1000 + ++seq)}` } }, rid);
    expect(r.body.result.ok, JSON.stringify(r.body.result)).toBe(true);
    return r.body.result.value!.customer;
  };
  const remove = async (id: string) => {
    process.env[FLAG] = "true";
    const r = await a.op("customer.delete", { customerId: id, confirmation: "TÖRLÉS" });
    expect(r.body.result.ok).toBe(true);
  };
  const leaks = (body: unknown, ...secrets: string[]) => secrets.some((s) => JSON.stringify(body).includes(s));

  it("a törölt ügyfél jegyzete az eredeti requestId-val újraküldve sem jön vissza", async () => {
    const c = await newCustomer(SECRET_NAME);
    const rid = randomUUID();
    const first = await a.op("note.create", { customerId: c.id, text: SECRET_NOTE }, rid);
    expect(first.body.result.ok).toBe(true);
    await remove(c.id);
    const replay = await a.op("note.create", { customerId: c.id, text: SECRET_NOTE }, rid);
    expect(replay.status).toBe(200);
    expect(replay.body.replayed).toBe(true);
    expect(replay.body.result).toEqual({ ok: false, errors: { _form: "A rekord nem található." } });
    expect(leaks(replay.body, SECRET_NOTE, SECRET_NAME, c.id)).toBe(false);
  });

  it("eltérő args-szal (másik, aktív ügyfél) sem kerülhető meg: a tárolt eredmény ügyfele számít", async () => {
    const gone = await newCustomer("Eltűnt Edina");
    const active = await newCustomer("Aktív Aladár");
    const rid = randomUUID();
    expect((await a.op("note.create", { customerId: gone.id, text: SECRET_NOTE }, rid)).body.result.ok).toBe(true);
    await remove(gone.id);
    for (const args of [{ customerId: active.id, text: "más szöveg" }, { customerId: active.id, text: SECRET_NOTE }, { customerId: "nincs", text: "x" }]) {
      const r = await a.op("note.create", args, rid);
      expect(r.body.result.ok, JSON.stringify(args)).toBe(false);
      expect(leaks(r.body, SECRET_NOTE, "Eltűnt Edina", gone.id)).toBe(false);
    }
    // A felhasználó és a művelettípus ellenőrzése megmarad.
    expect((await b.op("note.create", { customerId: active.id, text: "x" }, rid)).status).toBe(400);
    expect((await a.op("task.create", { input: { customerId: active.id, taskType: "email" } }, rid)).status).toBe(400);
  });

  it("minden eredményforma (ügyfél, feladat, jegyzet, státusz) újraküldése ellenőrzött; törlés után semmi nem szivárog", async () => {
    const createRid = randomUUID();
    const c = await newCustomer(SECRET_NAME + " Kettő", createRid);
    const rids: Record<string, string> = {};
    const run = async (op: string, args: unknown) => {
      rids[op] = randomUUID();
      const r = await a.op<Task>(op, args, rids[op]);
      expect(r.body.result.ok, `${op}: ${JSON.stringify(r.body.result)}`).toBe(true);
      return r.body.result.value!;
    };
    const task = await run("task.create", { input: { customerId: c.id, taskType: "phone_call", inputKey: "first_contact" } });
    await run("task.setDue", { taskId: task.id, dueAt: "2026-11-02T11:00:00.000Z" });
    await run("task.close", { taskId: task.id, input: { outcome: "success", output: SECRET_NOTE } });
    await run("task.reopen", { taskId: task.id });
    await run("customer.update", { id: c.id, input: { type: "individual", name: SECRET_NAME + " Kettő", email: "titkos@example.test" } });
    await run("customer.changeStatus", { customerId: c.id, input: { toStatus: "contact" } });
    await run("note.create", { customerId: c.id, text: SECRET_NOTE });
    rids["customer.create"] = createRid;
    await remove(c.id);
    const replays: Record<string, unknown> = {
      "customer.create": { input: { type: "individual", name: SECRET_NAME + " Kettő" } },
      "task.create": { input: { customerId: c.id, taskType: "phone_call" } },
      "task.setDue": { taskId: task.id, dueAt: null },
      "task.close": { taskId: task.id, input: { outcome: "success", output: "x" } },
      "task.reopen": { taskId: task.id },
      "customer.update": { id: c.id, input: { type: "individual", name: "x" } },
      "customer.changeStatus": { customerId: c.id, input: { toStatus: "lost" } },
      "note.create": { customerId: c.id, text: "x" },
    };
    for (const [op, args] of Object.entries(replays)) {
      const r = await a.op(op, args, rids[op]);
      expect(r.body.replayed, op).toBe(true);
      expect(r.body.result, op).toEqual({ ok: false, errors: { _form: "A rekord nem található." } });
      expect(leaks(r.body, SECRET_NAME, SECRET_NOTE, "titkos@example.test", c.id, task.id), op).toBe(false);
    }
  });

  it("aktív ügyfélnél az újraküldés változatlanul idempotens: ugyanaz az eredmény, nincs új rekord és nincs új audit", async () => {
    const c = await newCustomer("Ismétlő Ildikó");
    const rid = randomUUID();
    const first = await a.op("note.create", { customerId: c.id, text: "Rendes jegyzet" }, rid);
    const before = { acts: await count("activities"), audit: await count("audit_events"), log: await count("request_log") };
    const again = await a.op("note.create", { customerId: c.id, text: "Rendes jegyzet" }, rid);
    expect(again.body.replayed).toBe(true);
    expect(again.body.result).toEqual(first.body.result);
    const createRid = randomUUID();
    const created = await a.op<{ customer: Customer }>("customer.create", { input: { type: "individual", name: "Egyszeri Ernő", phone: "+36 30 401 0000" } }, createRid);
    const mid = { customers: await count("customers"), audit: await count("audit_events") };
    const createdAgain = await a.op("customer.create", { input: { type: "individual", name: "Egyszeri Ernő", phone: "+36 30 401 0000" } }, createRid);
    expect(createdAgain.body).toMatchObject({ replayed: true, result: created.body.result });
    expect({ customers: await count("customers"), audit: await count("audit_events") }).toEqual(mid);
    expect({ acts: await count("activities"), audit: await count("audit_events") - 1, log: await count("request_log") - 1 }).toEqual(before);
  });

  it("customer.delete újraküldése: amíg eltávolított, ugyanaz a sikeres válasz csak az azonosítóval; visszaállítás után nem sikeres; személyes adat egyik esetben sincs", async () => {
    const c = await newCustomer("Törölt Tódor");
    process.env[FLAG] = "true";
    const rid = randomUUID();
    const first = await a.op("customer.delete", { customerId: c.id, confirmation: "TÖRLÉS" }, rid);
    expect(first.body.result).toEqual({ ok: true, value: { id: c.id } });
    const audit = await count("audit_events");
    const again = await a.op("customer.delete", { customerId: c.id, confirmation: "TÖRLÉS" }, rid);
    expect(again.body).toMatchObject({ replayed: true, result: { ok: true, value: { id: c.id } } });
    expect(Object.keys(again.body.result.value as object)).toEqual(["id"]);
    expect(leaks(again.body, "Törölt Tódor")).toBe(false);
    expect(await count("audit_events")).toBe(audit);
    await restoreCustomer(t.db, c.id, "pilot.egy@example.test");
    const stale = await a.op("customer.delete", { customerId: c.id, confirmation: "TÖRLÉS" }, rid);
    expect(stale.body).toMatchObject({ replayed: true, result: { ok: false, errors: { _form: expect.stringMatching(/már feldolgozva/) } } });
    expect((await t.db.system((tx) => tx.query<{ deleted_at: unknown }>("select deleted_at from customers where id = $1", [c.id])))[0].deleted_at).toBeNull();
  });

  it("ismeretlen vagy sérült tárolt eredményforma nem kerül kiszolgálásra", async () => {
    const c = await newCustomer("Forma Ferenc");
    const userId = (await t.db.system((tx) => tx.query<{ id: string }>("select id from users where email = 'pilot.egy@example.test'")))[0].id;
    const cases = [
      { ok: true, value: { foo: "TITOK-1" } },
      { ok: true, value: { customerId: 42, summary: "TITOK-2" } },
      { ok: true },
      "TITOK-3",
      { ok: false, errors: { _form: "TITOK-4" } },
    ];
    for (const [i, response] of cases.entries()) {
      const rid = randomUUID();
      await t.db.system((tx) => tx.query("insert into request_log (request_id, user_id, op, response) values ($1, $2, 'note.create', $3::jsonb)", [rid, userId, JSON.stringify(response)]));
      const r = await a.op("note.create", { customerId: c.id, text: "x" }, rid);
      expect(r.body.replayed).toBe(true);
      expect(r.body.result.ok).toBe(false);
      expect(JSON.stringify(r.body.result), `case ${i}`).not.toMatch(/TITOK/);
    }
  });
});
