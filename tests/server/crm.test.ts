import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { customerName, statusOf, tasksByStatus } from "@/domain/logic";
import type { Customer, Task } from "@/domain/types";
import { makeApi, makeTestDb, addPilotUsers, client, DRIVERS, PASSWORD_A, PASSWORD_B, type Client, type TestDb } from "./helpers";

type Snap = import("@/domain/types").DataSnapshot;
const VERIFY = { sourceCategory: "provider_notification", complianceAcknowledged: true };

describe.each(DRIVERS)("CRM szerveroldali műveletek (%s)", (kind) => {
  let t: TestDb;
  let one: Client;
  let two: Client;
  let ids: { a: string; b: string };

  beforeAll(async () => {
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    ids = { a: u.a.id, b: u.b.id };
    const api = makeApi(t.db);
    one = client(api);
    two = client(api);
    await one.login("pilot.egy@example.test", PASSWORD_A);
    await two.login("pilot.ketto@example.test", PASSWORD_B);
  });
  afterAll(async () => { await t.cleanup(); });

  const create = async (c: Client, input: Record<string, unknown>) => {
    const r = await c.op<{ customer: Customer }>("customer.create", { input });
    expect(r.body.result.ok, JSON.stringify(r.body.result)).toBe(true);
    return r.body.result.value!.customer;
  };
  const newTask = async (c: Client, customerId: string, extra: Record<string, unknown> = {}) => {
    const r = await c.op<Task>("task.create", { input: { customerId, taskType: "phone_call", inputKey: "first_contact", ...extra } });
    expect(r.body.result.ok, JSON.stringify(r.body.result)).toBe(true);
    return r.body.result.value!;
  };
  const snap = async (c: Client) => ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: Snap }).snapshot;

  it("üres CRM: új adatbázisban nincs ügyfél, feladat vagy aktivitás", async () => {
    const empty = await makeTestDb(kind);
    await addPilotUsers(empty.db);
    const c = client(makeApi(empty.db));
    await c.login("pilot.egy@example.test", PASSWORD_A);
    const s = await snap(c);
    expect([s.customers, s.tasks, s.activities, s.contacts, s.processes].map((x) => x.length)).toEqual([0, 0, 0, 0, 0]);
    await empty.cleanup();
  });

  it("magánszemély és cég létrehozása: csak a név kötelező; alapértelmezett státusz; a létrehozó a hitelesített felhasználó", async () => {
    const p = await create(one, { type: "individual", name: "Fiktív Péter", recordedBy: "valaki-mas" });
    expect(p).toMatchObject({ type: "individual", displayName: "Fiktív Péter", crmStatus: "waiting_for_contact", ownerId: ids.a });
    const co = await create(two, { type: "company", companyName: "Fiktív Kft.", contactName: "Kovács Anna", contactPosition: "ügyvezető", phone: "+36 30 123 4567", email: "anna@example.test", source: "ajánlás" });
    expect(co).toMatchObject({ type: "company", companyName: "Fiktív Kft.", ownerId: ids.b });
    const s = await snap(one);
    expect(s.contacts.find((k) => k.companyId === co.id)).toMatchObject({ lastName: "Kovács", firstName: "Anna", isPrimaryContact: true });
    const bad = await one.op("customer.create", { input: { type: "individual", name: "" } });
    expect(bad.body.result).toMatchObject({ ok: false, errors: { name: expect.any(String) } });
    expect((await snap(one)).customers.filter((c) => c.id === p.id)).toHaveLength(1);
  });

  it("két pilot felhasználó ugyanazt az adatot látja; a módosítás mindkét oldalon megjelenik, a módosító azonosítható", async () => {
    const c = await create(one, { type: "individual", name: "Közös Katalin" });
    expect((await snap(two)).customers.some((x) => x.id === c.id)).toBe(true);
    const task = await newTask(two, c.id);
    expect(task.assigneeId).toBe(ids.b);
    const closed = await one.op<Task>("task.close", { taskId: task.id, input: { outcome: "success", output: "Kapcsolat létrejött." } });
    expect(closed.body.result.ok).toBe(true);
    const seen = (await snap(two)).tasks.find((x) => x.id === task.id)!;
    expect(seen.status).toBe("done");
    expect(seen.outputs![0]).toMatchObject({ outcome: "success", text: "Kapcsolat létrejött.", closedBy: ids.a });
    const audit = await t.db.system((tx) => tx.query<{ user_id: string; action: string }>("select user_id, action from audit_events where customer_id = $1 order by id", [c.id]));
    expect(audit.map((x) => [x.action, x.user_id])).toEqual([["customer.create", ids.a], ["task.create", ids.b], ["task.close", ids.a]]);
  });

  it("a rögzítő/felelős hamisítása hatástalan; az API nem enged régi, nem kitett vagy ismeretlen műveletet", async () => {
    const c = await create(one, { type: "individual", name: "Hamis Hanna" });
    // A kliens nem adhat meg felelőst/rögzítőt/állapotot: az ilyen mező elutasítva, a tulajdonost mindig a munkamenet adja.
    expect((await one.op("customer.create", { input: { type: "individual", name: "Más Tulaj", ownerId: ids.b } })).body.result.ok).toBe(false);
    expect((await one.op("task.create", { input: { customerId: c.id, taskType: "phone_call", assigneeId: ids.b } })).status).toBe(400);
    expect((await one.op("task.create", { input: { customerId: c.id, taskType: "phone_call", status: "done" } })).status).toBe(400);
    const task = await newTask(one, c.id);
    expect(task.assigneeId).toBe(ids.a);
    expect(task.status).toBe("open");
    expect((await snap(one)).customers.some((x) => customerName(x) === "Más Tulaj")).toBe(false);
    for (const op of ["restriction.set", "process.create", "customer.delete", "contactability.set"]) {
      const r = await one.op(op, { customerId: c.id });
      expect(r.status, op).toBe(400);
    }
    expect((await one.op("task.create", { input: { customerId: c.id, taskType: "phone_call" }, extra: 1 })).status).toBe(400);
    expect((await one.post("/api/crm/op", { requestId: "nem-uuid", op: "task.close", args: {} })).status).toBe(400);
  });

  it("ügyfél szerkesztése mentődik; kapcsolati adatok frissülnek; a típus nem módosítható", async () => {
    const c = await create(one, { type: "company", companyName: "Szerk Kft.", contactName: "Nagy Béla" });
    const r = await two.op<Customer>("customer.update", { id: c.id, input: { type: "company", companyName: "Szerk Kft. (új)", contactName: "Nagy Béla", contactPosition: "pénzügyi vezető", phone: "+36 20 111 2222", email: "bela@example.test", source: "weboldal" } });
    expect(r.body.result.ok).toBe(true);
    const s = await snap(one);
    expect(s.customers.find((x) => x.id === c.id)).toMatchObject({ companyName: "Szerk Kft. (új)", phone: "+36 20 111 2222", email: "bela@example.test", source: "weboldal" });
    expect(s.contacts.filter((k) => k.companyId === c.id)).toHaveLength(1);
    expect(s.contacts.find((k) => k.companyId === c.id)!.position).toBe("pénzügyi vezető");
    const wrong = await one.op("customer.update", { id: c.id, input: { type: "individual", name: "X" } });
    expect(wrong.body.result).toMatchObject({ ok: false });
    const audit = await t.db.system((tx) => tx.query<{ detail: { fields: string[] } }>("select detail from audit_events where action = 'customer.update' and customer_id = $1", [c.id]));
    expect(audit[0].detail.fields).toEqual(expect.arrayContaining(["companyName", "phone", "email", "source"]));
    expect(JSON.stringify(audit)).not.toContain("bela@example.test");
  });

  it("státuszváltás: egy ügyfél egy státusz; a feladatok a létrehozáskori státuszhoz tartoznak és megmaradnak; a pipeline szinkronban van", async () => {
    const c = await create(one, { type: "individual", name: "Státusz Samu" });
    const t1 = await newTask(one, c.id);
    expect(t1.crmStatus).toBe("waiting_for_contact");
    for (const to of ["contact", "relationship", "meeting"]) {
      const r = await two.op("customer.changeStatus", { customerId: c.id, input: { toStatus: to } });
      expect(r.body.result.ok).toBe(true);
    }
    const t2 = await newTask(two, c.id, { taskType: "online_meeting", inputKey: "scheduling" });
    expect(t2.crmStatus).toBe("meeting");
    const s = await snap(one);
    const cust = s.customers.find((x) => x.id === c.id)!;
    expect(statusOf(cust)).toBe("meeting");
    const view = tasksByStatus(s, cust);
    expect(view.current.map((x) => x.id)).toEqual([t2.id]);
    expect(view.earlier.flatMap((g) => g.tasks).map((x) => x.id)).toEqual([t1.id]);
    expect(s.activities.filter((a) => a.customerId === c.id && a.type === "crm_status_change")).toHaveLength(3);
  });

  it("ügyféljegyzet: közös, tartós, idempotens, a rögzítőt a munkamenet adja", async () => {
    const c = await create(one, { type: "individual", name: "Jegyzet Júlia" });
    const requestId = randomUUID();
    const args = { customerId: c.id, text: "  Pénteken visszahívást kért.\nA kérdéseit összegyűjti.  " };
    const first = await one.op("note.create", args, requestId);
    expect(first.body.result.ok).toBe(true);
    expect((await one.op("note.create", args, requestId)).body.replayed).toBe(true);
    const notes = (await snap(two)).activities.filter((a) => a.customerId === c.id && a.type === "note");
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ summary: args.text.trim(), recordedBy: ids.a });
    expect((await one.op("note.create", { customerId: c.id, text: " " })).status).toBe(400);
    expect((await one.op("note.create", { customerId: c.id, text: "x".repeat(2001) })).status).toBe(400);
    expect((await one.op("note.create", { customerId: c.id, text: "Hamis", recordedBy: ids.b })).status).toBe(400);
    expect((await one.op("note.create", { customerId: "missing", text: "Nincs ügyfél" })).body.result.ok).toBe(false);
    const audit = await t.db.system((tx) => tx.query("select detail from audit_events where action = 'note.create' and customer_id = $1", [c.id]));
    expect(audit).toHaveLength(1);
    expect(JSON.stringify(audit)).not.toContain("Pénteken");
  });

  it("„Tőke elhelyezve” igazolás nélkül nem rögzíthető; igazolással igen (szimulált)", async () => {
    const c = await create(one, { type: "individual", name: "Tőke Tamás" });
    const no = await one.op("customer.changeStatus", { customerId: c.id, input: { toStatus: "capital_placed" } });
    expect(no.body.result.ok).toBe(false);
    expect((await snap(one)).customers.find((x) => x.id === c.id)!.crmStatus).toBe("waiting_for_contact");
    const yes = await one.op("customer.changeStatus", { customerId: c.id, input: { toStatus: "capital_placed", verification: VERIFY } });
    expect(yes.body.result.ok).toBe(true);
    const act = (await snap(one)).activities.find((a) => a.customerId === c.id && a.type === "provider_milestone");
    expect(act?.meta?.verification).toMatchObject({ sourceCategory: "provider_notification", simulated: true, recordedBy: ids.a });
  });

  it("feladat (v0.9): Sikeres/Sikertelen + kötelező szöveges Output; ügyfélstátusz nem változik; újranyitás után az előzmény megmarad", async () => {
    const c = await create(one, { type: "individual", name: "Feladat Ferenc" });
    const task = await newTask(one, c.id, { inputKey: "callback", dueAt: "2026-11-02T00:00:00.000Z" });
    expect(task).toMatchObject({ title: "Telefonhívás", inputKey: "callback" });
    expect((await snap(one)).tasks.find((x) => x.id === task.id)!.dueAt).toBe("2026-11-02T00:00:00.000Z");

    // A4/A5/A10: üres, csak whitespace vagy hiányzó Output, hiányzó/ismeretlen minősítés - a szerver elutasítja, a feladat nyitott marad.
    for (const input of [{}, { outcome: "success" }, { outcome: "success", output: "" }, { outcome: "failure", output: "   \n\t  " }, { output: "Van szöveg" }, { outcome: "kiváló", output: "Van szöveg" }]) {
      const r = await one.op("task.close", { taskId: task.id, input });
      expect(r.body.result.ok, JSON.stringify(input)).toBe(false);
    }
    const ws = await one.op("task.close", { taskId: task.id, input: { outcome: "success", output: " \n " } });
    expect(ws.body.result.errors).toMatchObject({ output: "A feladat lezárásához az Output kitöltése kötelező." });
    const tooLong = await one.op("task.close", { taskId: task.id, input: { outcome: "success", output: "x".repeat(2001) } });
    expect(tooLong.body.result.errors?.output).toMatch(/2000/);
    // A régi, legördülős alak (outputKey/outputNote) már nem fogadható el.
    expect((await one.op("task.close", { taskId: task.id, input: { outputKey: "completed" } })).status).toBe(400);
    expect((await snap(one)).tasks.find((x) => x.id === task.id)!).toMatchObject({ status: "open" });
    expect((await snap(one)).tasks.find((x) => x.id === task.id)!.outputs).toBeUndefined();

    // A7 + A8 + B2: sikertelen lezárás, a szöveg sortörésekkel; a státusz változatlan; a második zárás elutasítva.
    const before = statusOf((await snap(one)).customers.find((x) => x.id === c.id)!);
    const text1 = "Az ügyfelet három próbálkozás után\nsem sikerült elérni.";
    expect((await two.op("task.close", { taskId: task.id, input: { outcome: "failure", output: `  ${text1}  ` } })).body.result.ok).toBe(true);
    expect(statusOf((await snap(one)).customers.find((x) => x.id === c.id)!)).toBe(before);
    expect((await one.op("task.close", { taskId: task.id, input: { outcome: "success", output: "Második" } })).body.result.ok).toBe(false);

    // B4 + B5: újranyitás, majd sikeres lezárás - új eredmény fűződik hozzá, a régi nem íródik felül.
    expect((await one.op("task.reopen", { taskId: task.id })).body.result.ok).toBe(true);
    const text2 = "Telefonon egyeztettünk, az ügyfél érdeklődik a\nszolgáltatás iránt. Csütörtökön ismét keresni kell.";
    expect((await one.op("task.close", { taskId: task.id, input: { outcome: "success", output: text2 } })).body.result.ok).toBe(true);
    const done = (await snap(two)).tasks.find((x) => x.id === task.id)!;
    expect(done.outputs!.map((o) => [o.outcome, o.key, o.text, o.closedBy])).toEqual([["failure", undefined, text1, ids.b], ["success", undefined, text2, ids.a]]);
    const rows = await t.db.system((tx) => tx.query<{ seq: number; outcome: string; output_text: string }>("select seq, outcome, output_text from task_results where task_id = $1 order by seq", [task.id]));
    expect(rows.map((r) => [Number(r.seq), r.outcome, r.output_text])).toEqual([[0, "failure", text1], [1, "success", text2]]);
    // Az előzmények: két külön lezárási esemény a saját Outputjával + egy újranyitás.
    const acts = (await snap(one)).activities.filter((a) => a.meta?.taskId === task.id);
    const closes = acts.filter((a) => a.type === "task_completed").map((a) => [a.meta?.taskOutcome, a.meta?.output, a.recordedBy]);
    expect(closes).toEqual([["success", text2, ids.a], ["failure", text1, ids.b]]);
    expect(acts.filter((a) => a.meta?.taskChange === "reopened")).toHaveLength(1);
    expect(statusOf((await snap(one)).customers.find((x) => x.id === c.id)!)).toBe(before);
    // Audit: csak minősítés és hossz, a szöveg nem.
    const audit = await t.db.system((tx) => tx.query<{ detail: Record<string, unknown> }>("select detail from audit_events where entity_id = $1 and action = 'task.close' order by id", [task.id]));
    expect(audit.map((a) => a.detail)).toEqual([{ outcome: "failure", outputLength: text1.length }, { outcome: "success", outputLength: text2.length }]);

    expect((await one.op("task.setDue", { taskId: task.id, dueAt: null })).body.result.ok).toBe(true);
    expect((await snap(one)).tasks.find((x) => x.id === task.id)!.dueAt).toBeUndefined();
  });

  it("átidőzítés (C1-C5): új határidő mentődik, a feladat nyitott marad, az előzmény a korábbi/új határidőt és a munkatársat őrzi", async () => {
    const c = await create(one, { type: "individual", name: "Átidőzítés Anna" });
    const task = await newTask(one, c.id, { dueAt: "2026-10-20T10:00:00.000Z" });
    const r = await two.op<Task>("task.setDue", { taskId: task.id, dueAt: "2026-10-23T10:00:00.000Z" });
    expect(r.body.result.ok).toBe(true);
    const cur = (await snap(one)).tasks.find((x) => x.id === task.id)!;
    expect(cur).toMatchObject({ status: "open", dueAt: "2026-10-23T10:00:00.000Z" });
    expect(cur.outputs).toBeUndefined();
    const act = (await snap(one)).activities.filter((a) => a.meta?.taskId === task.id && a.type === "task_updated");
    expect(act).toHaveLength(1);
    expect(act[0]).toMatchObject({ recordedBy: ids.b, meta: { taskChange: "rescheduled", fromDueAt: "2026-10-20T10:00:00.000Z", toDueAt: "2026-10-23T10:00:00.000Z" } });
    // Ugyanarra a dátumra mentés nem hoz létre újabb bejegyzést (D8).
    expect((await two.op("task.setDue", { taskId: task.id, dueAt: "2026-10-23T10:00:00.000Z" })).body.result.ok).toBe(true);
    expect((await snap(one)).activities.filter((a) => a.meta?.taskId === task.id && a.type === "task_updated")).toHaveLength(1);
    // Érvénytelen dátum: hiba, a mentett határidő változatlan.
    expect((await one.op("task.setDue", { taskId: task.id, dueAt: "nem-datum" })).body.result).toMatchObject({ ok: false, errors: { dueAt: expect.any(String) } });
    expect((await snap(one)).tasks.find((x) => x.id === task.id)!.dueAt).toBe("2026-10-23T10:00:00.000Z");
  });

  it("adatbázis-szintű védelem: minősített lezárás üres Outputtal és ismeretlen minősítés a CRM-rétegen kívül sem írható", async () => {
    const c = await create(one, { type: "individual", name: "Kényszer Kornél" });
    const task = await newTask(one, c.id);
    const insert = (outcome: string, text: string) => t.db.asUser(ids.a, (tx) => tx.query("insert into task_results (task_id, seq, outcome, output_text, closed_at, closed_by) values ($1, 0, $2, $3, now(), $4)", [task.id, outcome, text, ids.a]));
    await expect(insert("success", "  \n ")).rejects.toThrow();
    await expect(insert("maybe", "Szöveg")).rejects.toThrow();
    expect((await snap(one)).tasks.find((x) => x.id === task.id)!.outputs).toBeUndefined();
  });

  it("idempotencia: ugyanaz a kérés-azonosító nem hoz létre duplikátumot, és ugyanazt az eredményt adja", async () => {
    const rid = randomUUID();
    const a = await one.op<{ customer: Customer }>("customer.create", { input: { type: "individual", name: "Ismétlődő Imre" } }, rid);
    const b = await one.op<{ customer: Customer }>("customer.create", { input: { type: "individual", name: "Ismétlődő Imre" } }, rid);
    expect(a.body.replayed).toBe(false);
    expect(b.body.replayed).toBe(true);
    expect(b.body.result.value!.customer.id).toBe(a.body.result.value!.customer.id);
    expect((await snap(one)).customers.filter((c) => customerName(c) === "Ismétlődő Imre")).toHaveLength(1);
    const other = await two.op("customer.create", { input: { type: "individual", name: "Más" } }, rid);
    expect(other.status).toBe(400);
  });

  it("egyidejű, azonos azonosítójú kérésekből is egyetlen rekord lesz", async () => {
    const rid = randomUUID();
    const rs = await Promise.all([1, 2, 3].map(() => one.op("customer.create", { input: { type: "individual", name: "Párhuzamos Pál" } }, rid)));
    expect(rs.map((r) => r.status)).toEqual([200, 200, 200]);
    expect((await snap(one)).customers.filter((c) => customerName(c) === "Párhuzamos Pál")).toHaveLength(1);
  });

  it("nem létező ügyfél/feladat: kezelt hiba, nincs csonka írás", async () => {
    const before = (await snap(one)).tasks.length;
    expect((await one.op("task.create", { input: { customerId: "nincs", taskType: "email" } })).body.result).toMatchObject({ ok: false });
    expect((await one.op("task.close", { taskId: "nincs", input: { outcome: "success", output: "x" } })).body.result).toMatchObject({ ok: false });
    expect((await snap(one)).tasks.length).toBe(before);
  });

  it("adatbázis-hiba kezelt: általános 500, részletek és személyes adat nélkül; a korábbi adat érintetlen", async () => {
    const c = await create(one, { type: "individual", name: "Hiba Henrik", email: "henrik@example.test" });
    await t.db.system((tx) => tx.exec("alter table tasks add constraint test_break check (title <> 'Telefonhívás') not valid"));
    const res = await one.post("/api/crm/op", { requestId: randomUUID(), op: "task.create", args: { input: { customerId: c.id, taskType: "phone_call" } } });
    await t.db.system((tx) => tx.exec("alter table tasks drop constraint test_break"));
    expect(res.status).toBe(500);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ error: "server_error" });
    expect(text).not.toMatch(/henrik|constraint|test_break|select|insert/i);
    expect((await snap(one)).tasks.filter((x) => x.customerId === c.id)).toHaveLength(0);
    expect((await snap(one)).customers.some((x) => x.id === c.id)).toBe(true);
    expect((await newTask(one, c.id)).id).toBeTruthy();
  });

  it("a mentés tranzakciós: hiba esetén a részben végrehajtott írás (ügyfél + kapcsolattartó) visszagördül", async () => {
    await t.db.system((tx) => tx.exec("alter table company_contacts add constraint test_break2 check (last_name <> 'Bukó') not valid"));
    const res = await one.op("customer.create", { input: { type: "company", companyName: "Visszagördülő Kft.", contactName: "Bukó Béla" } });
    await t.db.system((tx) => tx.exec("alter table company_contacts drop constraint test_break2"));
    expect(res.status).toBe(500);
    expect((await snap(one)).customers.some((x) => x.type === "company" && x.companyName === "Visszagördülő Kft.")).toBe(false);
    const orphans = await t.db.system((tx) => tx.query("select 1 from audit_events a left join customers c on c.id = a.customer_id where a.customer_id is not null and c.id is null"));
    expect(orphans).toHaveLength(0);
  });
});

describe.each(DRIVERS)("tartósság (%s)", (kind) => {
  it("az adat újraindítás (új szerverfolyamat, új munkamenet) után is megvan - fájl alapú adatbázison", async () => {
    if (kind !== "pglite") return; // a `pg` meghajtó tartóssága a szerver oldali PostgreSQL-é; lásd az E2E és a docs/V0.6-PERSISTENCE.md
    const dir = mkdtempSync(join(tmpdir(), "jg-persist-"));
    try {
      let t = await makeTestDb("pglite", { dir });
      await addPilotUsers(t.db);
      let c = client(makeApi(t.db));
      await c.login("pilot.egy@example.test", PASSWORD_A);
      const cust = (await c.op<{ customer: Customer }>("customer.create", { input: { type: "company", companyName: "Tartós Kft.", contactName: "Szabó Géza", phone: "+36 1 234 5678" } })).body.result.value!.customer;
      const task = (await c.op<Task>("task.create", { input: { customerId: cust.id, taskType: "email", inputKey: "information" } })).body.result.value!;
      await c.op("task.close", { taskId: task.id, input: { outcome: "success", output: "Információ elküldve e-mailben." } });
      await c.op("customer.changeStatus", { customerId: cust.id, input: { toStatus: "relationship" } });
      await t.cleanup();

      // „új telepítés / új szerverfolyamat”: ugyanaz az adatkönyvtár, új kapcsolat, a migráció újrafuttatása (nem seed, nem reset)
      t = await makeTestDb("pglite", { dir });
      c = client(makeApi(t.db));
      expect((await c.login("pilot.ketto@example.test", PASSWORD_B)).status).toBe(200); // másik felhasználó, új munkamenet
      const s = ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: Snap }).snapshot;
      expect(s.customers.map((x) => x.id)).toEqual([cust.id]);
      expect(s.customers[0]).toMatchObject({ companyName: "Tartós Kft.", crmStatus: "relationship", phone: "+36 1 234 5678" });
      expect(s.tasks[0]).toMatchObject({ id: task.id, status: "done", inputKey: "information", crmStatus: "waiting_for_contact" });
      expect(s.tasks[0].outputs![0]).toMatchObject({ outcome: "success", text: "Információ elküldve e-mailben." });
      expect(s.contacts).toHaveLength(1);
      expect(s.activities.length).toBeGreaterThanOrEqual(3);
      await t.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);
});
