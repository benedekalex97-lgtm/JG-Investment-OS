import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { inputText, outputText } from "@/domain/logic";
import { DRIVERS, PASSWORD_A, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";

type Snap = import("@/domain/types").DataSnapshot;
const T0 = "2026-01-05T09:00:00.000Z";

/** Régi (v0.2-v0.5) adat és tiltakozási nyilvántartás: a v0.6 nem törli, nem írja át, nem képez le kitalált értékre. */
describe.each(DRIVERS)("régi adat megőrzése (%s)", (kind) => {
  let t: TestDb;
  let c: Client;
  let userId = "";

  beforeAll(async () => {
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    userId = u.a.id;
    await t.db.system(async (tx) => {
      await tx.query("insert into customers (id, type, first_name, last_name, display_name, contact_status, owner_id, source, verification_status, created_at, updated_at) values ('cust-1','individual','Elek','Régi','Régi Elek','existing_verified',$1,'régi kontaktadatbázis','demo',$2,$2)", [userId, T0]);
      await tx.query("insert into customers (id, type, company_name, owner_id, source, verification_status, created_at, updated_at) values ('cust-2','company','Régi Cég Kft.',$1,'régi','demo',$2,$2)", [userId, T0]);
      await tx.query("insert into company_contacts (id, company_id, first_name, last_name, phone, email, is_primary, created_at, updated_at) values ('kont-1','cust-2','Béla','Régi','+36 1 111 2222','regi@example.test',true,$1,$1)", [T0]);
      await tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ('cust-1','objection','Telefonon tiltakozott (fiktív)',$1,$2)", [T0, userId]);
      await tx.query("insert into processes (id, customer_id, type, title, status, closure_state, channel, source, owner_id, created_at, updated_at) values ('proc-1','cust-1','outbound_outreach','Régi folyamat','contact_in_progress','active','phone','contact_database',$1,$2,$2)", [userId, T0]);
      await tx.query("insert into activities (id, customer_id, process_id, type, occurred_at, summary, recorded_by) values ('act-1','cust-1','proc-1','process_created',$1,'Folyamat létrehozva: Régi folyamat',$2)", [T0, userId]);
      await tx.query("insert into contactability (id, customer_id, purpose, channel, status, evidence_status) values ('cont-1','cust-1','marketing','email','prohibited','documented_demo')");
      await tx.query("insert into tasks (id, customer_id, title, description, assignee_id, status, created_at, completed_at) values ('task-1','cust-1','Régi szabad szöveges feladat','Régi, szabad szöveges Input',$1,'done',$2,$2)", [userId, T0]);
      await tx.query("insert into task_results (task_id, seq, output_text, closed_at, closed_by) values ('task-1',0,'Régi, szabad szöveges Output',$1,$2)", [T0, userId]);
    });
    c = client(makeApi(t.db));
    await c.login("pilot.egy@example.test", PASSWORD_A);
  });
  afterAll(async () => { await t.cleanup(); });

  const snap = async () => ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: Snap }).snapshot;
  const raw = async (sql: string) => t.db.system((tx) => tx.query<Record<string, unknown>>(sql));

  it("a régi rekordok változatlanul olvashatók: nincs kitalált státusz, típus vagy leképezés", async () => {
    const s = await snap();
    const cust = s.customers.find((x) => x.id === "cust-1")!;
    expect(cust).toMatchObject({ contactStatus: "existing_verified", source: "régi kontaktadatbázis" });
    expect(cust.crmStatus).toBeUndefined();
    expect(cust.restriction).toMatchObject({ kind: "objection", note: "Telefonon tiltakozott (fiktív)", recordedBy: userId });
    const task = s.tasks.find((x) => x.id === "task-1")!;
    expect(task).toMatchObject({ title: "Régi szabad szöveges feladat", status: "done" });
    expect([task.taskType, task.crmStatus, task.inputKey]).toEqual([undefined, undefined, undefined]);
    expect(inputText(task)).toBe("Régi, szabad szöveges Input");
    expect(outputText(task.outputs![0])).toBe("Régi, szabad szöveges Output");
    expect(s.processes).toHaveLength(1);
    expect(s.contactability).toHaveLength(1);
    expect(s.activities.find((a) => a.id === "act-1")).toBeTruthy();
    expect(s.contacts.find((k) => k.id === "kont-1")).toMatchObject({ phone: "+36 1 111 2222", email: "regi@example.test" });
  });

  it("a cég régi kapcsolattartó-adata látszik és szerkesztés után sem vész el", async () => {
    const r = await c.op("customer.update", { id: "cust-2", input: { type: "company", companyName: "Régi Cég Kft.", contactName: "Régi Béla", phone: "+36 1 111 2222", email: "regi@example.test" } });
    expect(r.body.result.ok).toBe(true);
    const k = (await snap()).contacts.filter((x) => x.companyId === "cust-2");
    expect(k).toHaveLength(1);
    expect(k[0].id).toBe("kont-1");
  });

  it("a tiltakozás nyilvántartása megmarad minden művelet után; a kimenő státuszok továbbra is blokkoltak", async () => {
    const blocked = await c.op("customer.changeStatus", { customerId: "cust-1", input: { toStatus: "contact" } });
    expect(blocked.body.result).toMatchObject({ ok: false });
    expect((await c.op("customer.changeStatus", { customerId: "cust-1", input: { toStatus: "lost" } })).body.result.ok).toBe(true);
    expect((await c.op("customer.update", { id: "cust-1", input: { type: "individual", name: "Régi Elek", phone: "+36 20 555 1234" } })).body.result.ok).toBe(true);
    const rows = await raw("select kind, note, recorded_by from customer_restrictions where customer_id = 'cust-1'");
    expect(rows).toEqual([{ kind: "objection", note: "Telefonon tiltakozott (fiktív)", recorded_by: userId }]);
    expect((await snap()).customers.find((x) => x.id === "cust-1")!.restriction).toBeTruthy();
  });

  it("a régi feladat újranyitható és újrazárható: a régi Input/Output megmarad, az új lezárás hozzáfűződik", async () => {
    expect((await c.op("task.reopen", { taskId: "task-1" })).body.result.ok).toBe(true);
    expect((await c.op("task.close", { taskId: "task-1", input: { outputKey: "completed" } })).body.result.ok).toBe(true);
    const rows = await raw("select seq, output_key, output_text from task_results where task_id = 'task-1' order by seq");
    expect(rows.map((r) => [Number(r.seq), r.output_key, r.output_text])).toEqual([[0, null, "Régi, szabad szöveges Output"], [1, "completed", ""]]);
    const task = await raw("select description, task_type, crm_status, input_key from tasks where id = 'task-1'");
    expect(task).toEqual([{ description: "Régi, szabad szöveges Input", task_type: null, crm_status: null, input_key: null }]);
  });

  it("a régi folyamat, napló és megkereshetőség érintetlen marad", async () => {
    expect(await raw("select status, closure_state, title from processes")).toEqual([{ status: "contact_in_progress", closure_state: "active", title: "Régi folyamat" }]);
    expect(await raw("select status, evidence_status from contactability")).toEqual([{ status: "prohibited", evidence_status: "documented_demo" }]);
    expect(await raw("select summary from activities where id = 'act-1'")).toEqual([{ summary: "Folyamat létrehozva: Régi folyamat" }]);
  });
});
