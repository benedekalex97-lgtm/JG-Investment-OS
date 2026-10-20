import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BACKUP_TABLES, exportBackup, restoreBackup, RestoreError } from "@/server/backup";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type TestDb } from "./helpers";

/** Mentés és visszaállítás: fiktív adaton, forrás és külön céladatbázis között (a dokumentált helyreállítási eljárás próbája). */
describe.each(DRIVERS)("mentés és visszaállítás (%s)", (kind) => {
  let src: TestDb;
  let dst: TestDb;
  beforeAll(async () => {
    src = await makeTestDb(kind);
    await addPilotUsers(src.db);
    await src.db.system((tx) => tx.query("insert into oauth_identities (issuer, subject, user_id) select 'https://accounts.google.com', 'fictitious-backup-subject', id from users where email = 'pilot.egy@example.test'"));
    const c = client(makeApi(src.db));
    await c.login("pilot.egy@example.test", PASSWORD_A);
    const cust = (await c.op<{ customer: { id: string } }>("customer.create", { input: { type: "company", companyName: "Mentett Kft.", contactName: "Mentő Márta", phone: "+36 1 999 8888" } })).body.result.value!.customer;
    const task = (await c.op<{ id: string }>("task.create", { input: { customerId: cust.id, taskType: "email", inputKey: "other", inputNote: "Fiktív megjegyzés" } })).body.result.value!;
    await c.op("task.close", { taskId: task.id, input: { outcome: "failure", output: "Fiktív eredmény\nmásodik sor" } });
    await c.op("task.reopen", { taskId: task.id });
    await c.op("task.close", { taskId: task.id, input: { outcome: "success", output: "Fiktív második lezárás" } });
    await c.op("customer.changeStatus", { customerId: cust.id, input: { toStatus: "meeting" } });
    await src.db.system((tx) => tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) select $1, 'restriction', 'fiktív korlátozás', now(), id from users limit 1", [cust.id]));
    dst = await makeTestDb(kind);
  });
  afterAll(async () => { await src.cleanup(); await dst.cleanup(); });

  it("a mentés minden táblát tartalmaz; a munkamenetek és belépési kísérletek nem része", async () => {
    const b = await exportBackup(src.db, "local");
    expect(Object.keys(b.tables).sort()).toEqual([...BACKUP_TABLES].sort());
    expect(b.counts).toMatchObject({ users: 2, oauth_identities: 1, customers: 1, company_contacts: 1, tasks: 1, task_results: 2, customer_restrictions: 1 });
    expect(b.counts.audit_events).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(b)).not.toContain("token_hash");
  });

  it("visszaállítás üres adatbázisba: tartalom azonos, a sorszám egyezik, a belépés és a CRM működik", async () => {
    const b = JSON.parse(JSON.stringify(await exportBackup(src.db, "local")));
    const counts = await restoreBackup(dst.db, b, "local");
    expect(counts).toEqual(b.counts);
    const again = await exportBackup(dst.db, "local");
    expect(JSON.parse(JSON.stringify(again.tables))).toEqual(b.tables);
    const c = client(makeApi(dst.db));
    expect((await c.login("pilot.ketto@example.test", PASSWORD_B)).status).toBe(200);
    const s = ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: import("@/domain/types").DataSnapshot }).snapshot;
    expect(s.customers[0]).toMatchObject({ companyName: "Mentett Kft.", crmStatus: "meeting" });
    expect(s.customers[0].restriction).toMatchObject({ kind: "restriction", note: "fiktív korlátozás" });
    expect(s.tasks[0].outputs!.map((o) => [o.outcome, o.key, o.text])).toEqual([["failure", undefined, "Fiktív eredmény\nmásodik sor"], ["success", undefined, "Fiktív második lezárás"]]);
    expect((await c.op("customer.create", { input: { type: "individual", name: "Visszaállítás utáni" } })).body.result.ok).toBe(true);
    const [{ id }] = await dst.db.system((tx) => tx.query<{ id: string }>("select id::text as id from audit_events order by id desc limit 1"));
    expect(Number(id)).toBeGreaterThan(b.counts.audit_events);
  });

  it("nem üres adatbázisra nem ír (nem ír felül és nem töröl): a visszaállítás hibával megáll", async () => {
    const b = await exportBackup(src.db, "local");
    await expect(restoreBackup(dst.db, b, "local")).rejects.toThrow(RestoreError);
    await expect(restoreBackup(dst.db, b, "local")).rejects.toThrow(/nem üres/);
  });

  it("más környezet vagy ismeretlen formátum esetén megáll; részleges hiba esetén semmi nem íródik", async () => {
    const b = await exportBackup(src.db, "local");
    const empty = await makeTestDb(kind);
    await expect(restoreBackup(empty.db, b, "production")).rejects.toThrow(/környezet/);
    await expect(restoreBackup(empty.db, { ...b, version: 2 } as never, "local")).rejects.toThrow(/formátum/);
    const broken = JSON.parse(JSON.stringify(b));
    broken.tables.tasks[0].customer_id = "nincs-ilyen";
    await expect(restoreBackup(empty.db, broken, "local")).rejects.toThrow();
    const [{ n }] = await empty.db.system((tx) => tx.query<{ n: string }>("select (select count(*) from users) + (select count(*) from customers) as n"));
    expect(Number(n)).toBe(0);
    await empty.cleanup();
  });

  it("v0.8-as (0002_google_auth) mentés visszaállítható a v0.9 sémába: a régi lezárások minősítés nélkül (NULL) maradnak", async () => {
    const b = JSON.parse(JSON.stringify(await exportBackup(src.db, "local")));
    b.migration = "0002_google_auth";
    for (const row of b.tables.task_results) { delete row.outcome; row.output_key = "completed"; }
    const empty = await makeTestDb(kind);
    await restoreBackup(empty.db, b, "local");
    const rows = await empty.db.system((tx) => tx.query<{ outcome: string | null; output_key: string }>("select outcome, output_key from task_results order by task_id, seq"));
    expect(rows).toEqual(b.tables.task_results.map(() => ({ outcome: null, output_key: "completed" })));
    await expect(restoreBackup(empty.db, { ...b, migration: "0001_init" }, "local")).rejects.toThrow(/sémaverzió/);
    await empty.cleanup();
  });

  it("a mentésfájl JSON-ként írható/olvasható (fájlon át is azonos)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "jg-backup-"));
    try {
      const { writeFileSync, readFileSync } = await import("node:fs");
      const file = join(dir, "backup.json");
      writeFileSync(file, JSON.stringify(await exportBackup(src.db, "local")), { mode: 0o600 });
      const empty = await makeTestDb(kind);
      const counts = await restoreBackup(empty.db, JSON.parse(readFileSync(file, "utf8")), "local");
      expect(counts.customers).toBe(1);
      await empty.cleanup();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
