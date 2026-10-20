import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { crmPipeline, searchCustomers, tasksByStatus } from "@/domain/logic";
import type { Customer, DataSnapshot, Task } from "@/domain/types";
import { setActive } from "@/server/auth/service";
import { createUser } from "@/server/auth/service";
import { revokePermission } from "@/server/data/permissions";
import { grant, OPERATOR } from "./data-helpers";
import { addPilotUsers, client, DRIVERS, makeApi, makeTestDb, PASSWORD_A, PASSWORD_B, type Client, type TestDb } from "./helpers";

/**
 * v1.1 Beállítások (SET-002-SET-008) szerveroldali integrációs tesztjei a HTTP API-n át, valódi PostgreSQL-en (PGlite; natív PG-n is,
 * ha a JG_TEST_DATABASE_URL meg van adva). Kizárólag fiktív felhasználók és ügyfelek. A tesztazonosítók a v1.1 tesztmátrixot követik.
 */
const EMAIL_A = "pilot.egy@example.test";
const EMAIL_B = "pilot.ketto@example.test";
const EMAIL_C = "adat.csak@example.test";
const PASSWORD_C = "fiktiv-jelszo-C-24680";
const VERIFY = { sourceCategory: "provider_notification", complianceAcknowledged: true };

interface Item { key: string; label: string; version: number; isActive: boolean; isSystem: boolean; sortOrder: number; color?: string; semantic?: string; allowsNote?: boolean; labelLocked?: boolean; usage: { customers?: number; tasks: number; openTasks: number } }

describe.each(DRIVERS)("v1.1 Beállítások API (%s)", (kind) => {
  let t: TestDb;
  let admin: Client;
  let worker: Client;
  let dataOnly: Client;
  let ids: { a: string; b: string; c: string };

  const body = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const list = async (c: Client, k: string) => (await body<{ items: Item[] }>(await c.get(`/api/settings/${k}`))).items;
  const snap = async (c: Client) => (await body<{ snapshot: DataSnapshot }>(await c.get("/api/crm/snapshot"))).snapshot;
  const audit = async () => t.db.system((tx) => tx.query<{ action: string; entity_type: string; entity_key: string; outcome: string; actor_user_id: string | null; via: string; changes: Record<string, unknown> | null; reason: string | null }>("select * from settings_audit order by id"));
  const createCustomer = async (c: Client, input: Record<string, unknown>) => (await c.op<{ customer: Customer }>("customer.create", { input })).body.result;

  beforeAll(async () => {
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    const c = await createUser(t.db, { email: EMAIL_C, name: "Teszt Adatkezelő", password: PASSWORD_C });
    ids = { a: u.a.id, b: u.b.id, c: c.id };
    const api = makeApi(t.db);
    admin = client(api);
    worker = client(api);
    dataOnly = client(api);
    await admin.login(EMAIL_A, PASSWORD_A);
    await worker.login(EMAIL_B, PASSWORD_B);
    await dataOnly.login(EMAIL_C, PASSWORD_C);
  });
  afterAll(async () => { await t.cleanup(); });

  it("P05: a migráció senkinek nem ad jogot; a régi role='admin' sem jogosít; a menühöz szükséges jogok üresek", async () => {
    expect(await t.db.system((tx) => tx.query("select * from user_permissions"))).toEqual([]);
    const roles = await t.db.system((tx) => tx.query<{ role: string }>("select distinct role from users"));
    expect(roles.map((r) => r.role)).toEqual(["admin"]);
    const me = await body<{ permissions: string[] }>(await admin.get("/api/auth/me"));
    expect(me.permissions).toEqual([]);
    expect((await admin.get("/api/settings/overview")).status).toBe(403);
    expect((await admin.get("/api/settings/pipeline")).status).toBe(403);
    // Provisioning: kizárólag az üzemeltetői úton (CLI-függvény), kifejezett jóváhagyás után.
    await grant(t.db, EMAIL_A, "crm.settings.manage", "crm.users.manage", "crm.settings.audit.read");
    await grant(t.db, EMAIL_C, "crm.customer.export");
    expect((await body<{ permissions: string[] }>(await admin.get("/api/auth/me"))).permissions).toEqual(["crm.settings.manage", "crm.users.manage", "crm.settings.audit.read"]);
    const cli = (await audit()).filter((a) => a.via === "cli");
    expect(cli.map((a) => [a.action, a.outcome])).toEqual([...Array(4)].map(() => ["permission.grant", "success"]));
    expect(cli.every((a) => a.actor_user_id === null)).toBe(true);
  });

  it("P03/N03: hitelesítés nélkül 401; jogosulatlan felhasználó minden adminvégpontján 403 (direkt hívással is); az elutasított módosítás naplózódik", async () => {
    const anon = client(makeApi(t.db));
    expect((await anon.get("/api/settings/pipeline")).status).toBe(401);
    for (const p of ["/api/settings/overview", "/api/settings/pipeline", "/api/settings/task-types", "/api/settings/task-inputs", "/api/settings/users", "/api/settings/audit"]) {
      expect((await worker.get(p)).status, p).toBe(403);
    }
    expect((await worker.post("/api/settings/pipeline", { label: "Behatoló" })).status).toBe(403);
    expect((await worker.patch("/api/settings/pipeline", { key: "lost", version: 1, label: "X" })).status).toBe(403);
    expect((await worker.patch("/api/settings/users/permissions", { userId: ids.b, expected: [], grant: ["crm.settings.manage"] })).status).toBe(403);
    const denied = (await audit()).filter((a) => a.outcome === "rejected" && a.actor_user_id === ids.b);
    expect(denied.map((a) => a.action)).toEqual(["settings.denied", "settings.denied", "settings.denied"]);
    expect(await t.db.system((tx) => tx.query("select * from crm_pipeline_statuses where label = 'Behatoló'"))).toEqual([]);
  });

  it("CSRF: idegen eredetű vagy nem JSON módosító kérés elutasítva; nem gyorsítótárazható válasz", async () => {
    expect((await admin.post("/api/settings/pipeline", { label: "CSRF" }, { origin: "https://evil.example" })).status).toBe(403);
    expect((await admin.post("/api/settings/pipeline", { label: "CSRF" }, { "content-type": "text/plain" })).status).toBe(403);
    const r = await admin.get("/api/settings/pipeline");
    expect(r.headers.get("cache-control")).toContain("no-store");
  });

  it("S01/M02/M03: a hét meglévő státusz változatlan kulccsal, névvel, sorrenddel; védett jelentésük megvan", async () => {
    const items = await list(admin, "pipeline");
    expect(items.map((i) => [i.key, i.label, i.semantic, i.isSystem, i.isActive])).toEqual([
      ["waiting_for_contact", "Feldolgozásra vár", "default", true, true],
      ["contact", "Kapcsolatfelvétel", "outreach", true, true],
      ["relationship", "Kapcsolatépítés", "outreach", true, true],
      ["meeting", "Online/Személyes tárgyalás", "workflow", true, true],
      ["account_opening", "Számlanyitás", "workflow", true, true],
      ["capital_placed", "Tőke elhelyezve", "milestone", true, true],
      ["lost", "Elvesztett", "lost", true, true],
    ]);
  });

  let custom: Item;
  it("S02/S03/P02: új státusz létrehozása (stabil kulcs, belső munkafolyamat-jelentés); érvénytelen bemenet és védett mező elutasítva", async () => {
    const r = await admin.post("/api/settings/pipeline", { label: "Ajánlatkérés", color: "teal", description: "Fiktív belső lépés" });
    expect(r.status).toBe(201);
    custom = (await body<{ item: Item; message: string }>(r)).item;
    expect(custom).toMatchObject({ key: "ajanlatkeres", label: "Ajánlatkérés", color: "teal", semantic: "workflow", isSystem: false, isActive: true, version: 1, sortOrder: 80 });
    const bad = async (b: unknown, status = 400) => expect((await admin.post("/api/settings/pipeline", b)).status, JSON.stringify(b)).toBe(status);
    await bad({ label: "" });
    await bad({ label: "x".repeat(61) });
    await bad({ label: "Sor\ntörés" });
    await bad({ label: "Rossz szín", color: "#ff0000" });
    await bad({ label: "Mérföldkő", semanticType: "milestone" });
    await bad({ label: "Mérföldkő", requiresVerification: true });
    await bad({ label: "Kulcs", key: "capital_placed" });
    await bad({ label: "ajánlatkérés" }, 409);
    // Script/HTML nem értelmeződik: szövegként tárolódik, a felület szövegként jeleníti meg.
    const html = await body<{ item: Item }>(await admin.post("/api/settings/pipeline", { label: "<b>Teszt</b>" }));
    expect(html.item.label).toBe("<b>Teszt</b>");
    expect(html.item.key).toBe("b_teszt_b");
  });

  it("S12 (DB): az alkalmazás szerepköre közvetlenül sem hozhat létre védett jelentésű vagy rendszerstátuszt", async () => {
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into crm_pipeline_statuses (key, label, sort_order, semantic_type) values ('hamis','Hamis',5,'milestone')"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into crm_pipeline_statuses (key, label, sort_order, is_system) values ('hamis','Hamis',5,true)"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_pipeline_statuses set semantic_type = 'workflow' where key = 'capital_placed'"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_pipeline_statuses set key = 'x' where key = 'ajanlatkeres'"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("delete from crm_pipeline_statuses where key = 'ajanlatkeres'"))).rejects.toThrow();
    // Jog nélkül (munkatárs) közvetlenül sem írható.
    await expect(t.db.asUser(ids.b, (tx) => tx.query("update crm_pipeline_statuses set label = 'X' where key = 'lost'"))).resolves.toEqual([]);
    expect((await list(admin, "pipeline")).find((i) => i.key === "lost")!.label).toBe("Elvesztett");
  });

  it("S09/S14/S15: új státusszal ügyfél hozható létre és arra váltható; a snapshot konfigurációja azonnal frissül", async () => {
    const s = await snap(worker);
    expect(s.config.statuses.map((x) => x.key)).toContain("ajanlatkeres");
    const created = await createCustomer(worker, { type: "individual", name: "Fiktív Státusz Elek", crmStatus: "ajanlatkeres" });
    expect(created.ok, JSON.stringify(created)).toBe(true);
    const id = created.value!.customer.id;
    expect(created.value!.customer.crmStatus).toBe("ajanlatkeres");
    const other = await createCustomer(worker, { type: "individual", name: "Fiktív Váltó Vera" });
    const ch = await worker.op<Customer>("customer.changeStatus", { customerId: other.value!.customer.id, input: { toStatus: "ajanlatkeres" } });
    expect(ch.body.result.ok).toBe(true);
    expect(ch.body.snapshot.activities.find((a) => a.customerId === other.value!.customer.id && a.type === "crm_status_change")!.summary).toBe("Kapcsolati státusz: Feldolgozásra vár → Ajánlatkérés");
    const unknown = await createCustomer(worker, { type: "individual", name: "Fiktív Ismeretlen", crmStatus: "nincs_ilyen" });
    expect(unknown.ok).toBe(false);
    // S16/S18: szűrés és státusz szerinti feladatcsoportosítás az új státusszal.
    const task = await worker.op<Task>("task.create", { input: { customerId: id, taskType: "phone_call" } });
    expect(task.body.result.value!.crmStatus).toBe("ajanlatkeres");
    const s2 = task.body.snapshot;
    expect(searchCustomers(s2, { crmStatus: "ajanlatkeres" }).map((c) => c.id).sort()).toEqual([id, other.value!.customer.id].sort());
    const col = crmPipeline(s2).find((c) => c.status === "ajanlatkeres")!;
    expect(col.label).toBe("Ajánlatkérés");
    expect(col.customers).toHaveLength(2);
    expect(tasksByStatus(s2, s2.customers.find((c) => c.id === id)!).current.map((x) => x.id)).toEqual([task.body.result.value!.id]);
  });

  it("S04/S19: átnevezés verzióval; elavult verzió -> 409, nincs csendes felülírás; a felhasználók azonnal az új nevet látják", async () => {
    const before = (await list(admin, "pipeline")).find((i) => i.key === "ajanlatkeres")!;
    const r = await admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: before.version, label: "Ajánlatkérés folyamatban" });
    expect(r.status).toBe(200);
    expect((await body<{ item: Item; message: string }>(r))).toMatchObject({ item: { label: "Ajánlatkérés folyamatban", version: before.version + 1 }, message: "A beállítás mentve." });
    const stale = await admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: before.version, label: "Régi verzióból" });
    expect(stale.status).toBe(409);
    expect((await body<{ message: string }>(stale)).message).toBe("A beállítás időközben megváltozott. Frissítsd az adatokat az új mentés előtt.");
    // Két párhuzamos módosítás ugyanarról a verzióról: pontosan egy sikeres.
    const v = before.version + 1;
    const both = await Promise.all([
      admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: v, color: "indigo" }),
      admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: v, color: "warn" }),
    ]);
    expect(both.map((x) => x.status).sort()).toEqual([200, 409]);
    const s = await snap(worker);
    expect(s.config.statuses.find((x) => x.key === "ajanlatkeres")!.label).toBe("Ajánlatkérés folyamatban");
    // A korábbi naplóbejegyzés a rögzítéskori nevet őrzi; az előzmény az új nevet mutatja a kulcshoz.
    expect(s.activities.some((a) => a.summary === "Kapcsolati státusz: Feldolgozásra vár → Ajánlatkérés")).toBe(true);
  });

  it("S06: szín csak a palettából; S12: a „Tőke elhelyezve” neve zárolt, igazolási követelménye megmarad", async () => {
    const cp = (await list(admin, "pipeline")).find((i) => i.key === "capital_placed")!;
    expect((await admin.patch("/api/settings/pipeline", { key: "capital_placed", version: cp.version, color: "pink" })).status).toBe(400);
    expect((await admin.patch("/api/settings/pipeline", { key: "capital_placed", version: cp.version, color: "teal" })).status).toBe(200);
    const locked = await admin.patch("/api/settings/pipeline", { key: "capital_placed", version: cp.version + 1, label: "Pénz megjött" });
    expect(locked.status).toBe(400);
    expect((await body<{ error: string }>(locked)).error).toBe("label_locked");
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_pipeline_statuses set label = 'Pénz megjött' where key = 'capital_placed'"))).rejects.toThrow(/label_locked/);
    const c = await createCustomer(worker, { type: "individual", name: "Fiktív Mérföldkő" });
    const noVerify = await worker.op("customer.changeStatus", { customerId: c.value!.customer.id, input: { toStatus: "capital_placed" } });
    expect(noVerify.body.result.errors).toHaveProperty("verification");
    const ok = await worker.op("customer.changeStatus", { customerId: c.value!.customer.id, input: { toStatus: "capital_placed", verification: VERIFY } });
    expect(ok.body.result.ok).toBe(true);
    expect(ok.body.snapshot.activities.find((a) => a.customerId === c.value!.customer.id)!.type).toBe("provider_milestone");
  });

  it("S13: átnevezés után is érvényes a megkeresési korlátozás a kimenő megkeresési státuszokra", async () => {
    const contact = (await list(admin, "pipeline")).find((i) => i.key === "contact")!;
    expect((await admin.patch("/api/settings/pipeline", { key: "contact", version: contact.version, label: "Első hívás" })).status).toBe(200);
    const c = await createCustomer(worker, { type: "individual", name: "Fiktív Tiltakozó" });
    const id = c.value!.customer.id;
    await t.db.system((tx) => tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ($1,'objection','Fiktív tiltakozás',now(),$2)", [id, ids.b]));
    const r = await worker.op("customer.changeStatus", { customerId: id, input: { toStatus: "contact" } });
    expect(r.body.result.errors?.toStatus).toMatch(/Tiltakozás van rögzítve/);
    const r2 = await worker.op("customer.changeStatus", { customerId: id, input: { toStatus: "relationship" } });
    expect(r2.body.result.ok).toBe(false);
    const back = (await list(admin, "pipeline")).find((i) => i.key === "contact")!;
    expect((await admin.patch("/api/settings/pipeline", { key: "contact", version: back.version, label: "Kapcsolatfelvétel" })).status).toBe(200);
  });

  it("S05: sorrend módosítása tartósan; a teljes lista és a verziók ellenőrzöttek", async () => {
    const items = await list(admin, "pipeline");
    const order = [...items].reverse().map((i) => ({ key: i.key, version: i.version }));
    const r = await admin.patch("/api/settings/pipeline/order", { order });
    expect(r.status).toBe(200);
    expect((await list(admin, "pipeline")).map((i) => i.key)).toEqual(order.map((o) => o.key));
    expect((await snap(worker)).config.statuses.slice().sort((a, b) => a.sortOrder - b.sortOrder).map((s) => s.key)).toEqual(order.map((o) => o.key));
    expect((await admin.patch("/api/settings/pipeline/order", { order: order.slice(1) })).status).toBe(409);
    expect((await admin.patch("/api/settings/pipeline/order", { order })).status).toBe(409); // elavult verziók
    expect((await admin.patch("/api/settings/pipeline/order", { order: [...order, order[0]] })).status).toBe(409);
    const fresh = await list(admin, "pipeline");
    const restore = [...fresh].reverse().map((i) => ({ key: i.key, version: i.version }));
    expect((await admin.patch("/api/settings/pipeline/order", { order: restore })).status).toBe(200);
  });

  it("S07/S08/S09/S10/M11: archiválás megerősítéssel; nincs átsorolás; történetileg látható; új rekordhoz nem választható; újraaktiválható", async () => {
    const item = (await list(admin, "pipeline")).find((i) => i.key === "ajanlatkeres")!;
    expect(item.usage.customers).toBe(2);
    const need = await admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: item.version, isActive: false });
    expect(need.status).toBe(409);
    expect(await body(need)).toMatchObject({ error: "in_use", usage: { customers: 2 } });
    const r = await admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: item.version, isActive: false, confirmInUse: true });
    expect(r.status).toBe(200);
    expect((await body<{ item: Item }>(r)).item).toMatchObject({ isActive: false });
    const s = await snap(worker);
    const inArchived = s.customers.filter((c) => c.crmStatus === "ajanlatkeres");
    expect(inArchived).toHaveLength(2);
    expect(crmPipeline(s).find((c) => c.status === "ajanlatkeres")!.customers).toHaveLength(2);
    expect((await createCustomer(worker, { type: "individual", name: "Fiktív Archív", crmStatus: "ajanlatkeres" })).errors?.toStatus).toMatch(/archivált/);
    const other = await createCustomer(worker, { type: "individual", name: "Fiktív Másik" });
    expect((await worker.op("customer.changeStatus", { customerId: other.value!.customer.id, input: { toStatus: "ajanlatkeres" } })).body.result.errors?.toStatus).toMatch(/archivált/);
    // Az archivált státuszban lévő ügyfél adatai menthetők, feladat hozható létre és zárható le.
    const id = inArchived[0].id;
    expect((await worker.op("customer.update", { id, input: { type: "individual", name: "Fiktív Átnevezett" } })).body.result.ok).toBe(true);
    const task = await worker.op<Task>("task.create", { input: { customerId: id, taskType: "email" } });
    expect(task.body.result.value!.crmStatus).toBe("ajanlatkeres");
    expect((await worker.op("task.close", { taskId: task.body.result.value!.id, input: { outcome: "success", output: "Fiktív lezárás" } })).body.result.ok).toBe(true);
    // Más státuszba továbbléptethető.
    expect((await worker.op("customer.changeStatus", { customerId: id, input: { toStatus: "meeting" } })).body.result.ok).toBe(true);
    // DB-szint: a felület megkerülésével sem kerülhet ügyfél archivált státuszba.
    await expect(t.db.asUser(ids.b, (tx) => tx.query("update customers set crm_status = 'ajanlatkeres' where id = $1", [id]))).rejects.toThrow(/inactive_status/);
    const back = (await list(admin, "pipeline")).find((i) => i.key === "ajanlatkeres")!;
    expect((await admin.patch("/api/settings/pipeline", { key: "ajanlatkeres", version: back.version, isActive: true })).status).toBe(200);
    expect((await worker.op("customer.changeStatus", { customerId: other.value!.customer.id, input: { toStatus: "ajanlatkeres" } })).body.result.ok).toBe(true);
  });

  it("S11: rendszerstátusz (pl. alapértelmezett) nem archiválható - API és adatbázis szinten; a kísérlet naplózódik", async () => {
    const def = (await list(admin, "pipeline")).find((i) => i.key === "waiting_for_contact")!;
    const r = await admin.patch("/api/settings/pipeline", { key: "waiting_for_contact", version: def.version, isActive: false, confirmInUse: true });
    expect(r.status).toBe(400);
    expect((await body<{ error: string }>(r)).error).toBe("system_archive");
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_pipeline_statuses set is_active = false where key = 'lost'"))).rejects.toThrow(/system_archive/);
    expect((await audit()).some((a) => a.outcome === "rejected" && a.entity_key === "waiting_for_contact" && a.reason === "system_archive")).toBe(true);
  });

  it("T01-T08: feladattípusok - régiek megmaradnak, új típus, átnevezés (a meglévő feladat neve nem változik), sorrend, archiválás", async () => {
    const items = await list(admin, "task-types");
    expect(items.map((i) => [i.key, i.label])).toEqual([["phone_call", "Telefonhívás"], ["email", "E-mail"], ["online_meeting", "Online tárgyalás"], ["in_person_meeting", "Személyes tárgyalás"], ["follow_up", "Utánkövetés"], ["other", "Egyéb"]]);
    const created = (await body<{ item: Item }>(await admin.post("/api/settings/task-types", { label: "Videóhívás" }))).item;
    expect(created).toMatchObject({ key: "videohivas", isActive: true, isSystem: false });
    const c = await createCustomer(worker, { type: "individual", name: "Fiktív Feladatos" });
    const tk = await worker.op<Task>("task.create", { input: { customerId: c.value!.customer.id, taskType: "videohivas" } });
    expect(tk.body.result.value!.title).toBe("Videóhívás");
    expect((await admin.patch("/api/settings/task-types", { key: "videohivas", version: 1, label: "Videós egyeztetés" })).status).toBe(200);
    const s = await snap(worker);
    expect(s.tasks.find((x) => x.id === tk.body.result.value!.id)!.title).toBe("Videóhívás");
    expect(s.config.taskTypes.find((x) => x.key === "videohivas")!.label).toBe("Videós egyeztetés");
    const now = await list(admin, "task-types");
    const order = [now[now.length - 1], ...now.slice(0, -1)].map((i) => ({ key: i.key, version: i.version }));
    expect((await admin.patch("/api/settings/task-types/order", { order })).status).toBe(200);
    expect((await list(admin, "task-types"))[0].key).toBe("videohivas");
    const cur = (await list(admin, "task-types")).find((i) => i.key === "videohivas")!;
    expect(cur.usage).toMatchObject({ tasks: 1, openTasks: 1 });
    expect((await admin.patch("/api/settings/task-types", { key: "videohivas", version: cur.version, isActive: false })).status).toBe(409);
    expect((await admin.patch("/api/settings/task-types", { key: "videohivas", version: cur.version, isActive: false, confirmInUse: true })).status).toBe(200);
    expect((await worker.op("task.create", { input: { customerId: c.value!.customer.id, taskType: "videohivas" } })).body.result.errors?.taskType).toMatch(/archivált/);
    // T06: a régi feladat olvasható és lezárható.
    expect((await worker.op("task.close", { taskId: tk.body.result.value!.id, input: { outcome: "failure", output: "Fiktív: nem vette fel" } })).body.result.ok).toBe(true);
    // T08: a használt típus nem törölhető (nincs törlési jog, idegen kulcs is véd).
    await expect(t.db.asUser(ids.a, (tx) => tx.query("delete from crm_task_types where key = 'videohivas'"))).rejects.toThrow();
    await expect(t.db.system((tx) => tx.query("delete from crm_task_types where key = 'videohivas'"))).rejects.toThrow();
    const phone = (await list(admin, "task-types")).find((i) => i.key === "phone_call")!;
    expect((await admin.patch("/api/settings/task-types", { key: "phone_call", version: phone.version, isActive: false })).status).toBe(400);
  });

  it("I01-I08: Input-opciók - régiek, új (megjegyzést engedő) opció, átnevezés, archiválás; megjegyzés-szabály; Output-kötelezőség változatlan", async () => {
    const items = await list(admin, "task-inputs");
    expect(items.map((i) => [i.key, i.allowsNote])).toEqual([["first_contact", false], ["callback", false], ["scheduling", false], ["information", false], ["follow_up", false], ["other", true]]);
    const plain = (await body<{ item: Item }>(await admin.post("/api/settings/task-inputs", { label: "Ajánlás" }))).item;
    const noted = (await body<{ item: Item }>(await admin.post("/api/settings/task-inputs", { label: "Rendezvény", allowsNote: true }))).item;
    expect([plain.allowsNote, noted.allowsNote]).toEqual([false, true]);
    const c = await createCustomer(worker, { type: "individual", name: "Fiktív Inputos" });
    const cid = c.value!.customer.id;
    expect((await worker.op("task.create", { input: { customerId: cid, taskType: "email", inputKey: plain.key, inputNote: "nem engedett" } })).body.result.errors?.inputNote).toBeTruthy();
    const ok = await worker.op<Task>("task.create", { input: { customerId: cid, taskType: "email", inputKey: noted.key, inputNote: "Fiktív rendezvény" } });
    expect(ok.body.result.value).toMatchObject({ inputKey: noted.key, inputNote: "Fiktív rendezvény" });
    const legacyOther = await worker.op<Task>("task.create", { input: { customerId: cid, taskType: "email", inputKey: "other", inputNote: "Régi Egyéb" } });
    expect(legacyOther.body.result.ok).toBe(true);
    expect((await admin.patch("/api/settings/task-inputs", { key: noted.key, version: 1, label: "Rendezvényen" })).status).toBe(200);
    expect((await admin.patch("/api/settings/task-inputs", { key: noted.key, version: 2, isActive: false, confirmInUse: true })).status).toBe(200);
    expect((await worker.op("task.create", { input: { customerId: cid, taskType: "email", inputKey: noted.key } })).body.result.errors?.inputKey).toMatch(/archivált/);
    // I08: az Output továbbra is kötelező; a Sikeres/Sikertelen lezárás változatlan.
    const id = ok.body.result.value!.id;
    expect((await worker.op("task.close", { taskId: id, input: { outcome: "success", output: "   " } })).body.result.errors?.output).toBe("A feladat lezárásához az Output kitöltése kötelező.");
    expect((await worker.op("task.close", { taskId: id, input: { outcome: "success" } })).body.result.ok).toBe(false);
    const done = await worker.op<Task>("task.close", { taskId: id, input: { outcome: "success", output: "Fiktív eredmény" } });
    expect(done.body.result.value!.outputs!.at(-1)).toMatchObject({ outcome: "success", text: "Fiktív eredmény" });
    // DB-szint: archivált Input új feladathoz a felület megkerülésével sem.
    await expect(t.db.asUser(ids.b, (tx) => tx.query("insert into tasks (id, customer_id, title, assignee_id, status, input_key, created_at) values ('task-x', $1, 'X', $2, 'open', $3, now())", [cid, ids.b, noted.key]))).rejects.toThrow(/inactive_task_input/);
  });

  it("U01-U08/P04/P06/P07/P08: felhasználók és jogok kezelése - lista, kiosztás, visszavonás (azonnal hat), önjogosítás és tiltott jog elutasítva", async () => {
    await setActive(t.db, EMAIL_C, false);
    const r = await body<{ users: { id: string; name: string; email: string; active: boolean; lastLoginAt: string | null; permissions: string[] }[]; currentUserId: string; permissions: { key: string }[] }>(await admin.get("/api/settings/users"));
    expect(r.currentUserId).toBe(ids.a);
    expect(r.permissions.map((p) => p.key)).toEqual(["crm.customer.import", "crm.customer.export", "crm.import.history.read", "crm.settings.manage", "crm.users.manage", "crm.settings.audit.read"]);
    const byId = new Map(r.users.map((u) => [u.id, u]));
    expect(byId.get(ids.a)).toMatchObject({ name: "Teszt Pilot Egy", email: EMAIL_A, active: true, permissions: ["crm.settings.audit.read", "crm.settings.manage", "crm.users.manage"] });
    expect(byId.get(ids.a)!.lastLoginAt).not.toBeNull();
    expect(byId.get(ids.c)).toMatchObject({ active: false, permissions: ["crm.customer.export"] });
    expect(JSON.stringify(r)).not.toMatch(/password|hash|token/i);
    await setActive(t.db, EMAIL_C, true);
    await dataOnly.login(EMAIL_C, PASSWORD_C); // a letiltás a munkameneteit törölte

    const change = (b: Record<string, unknown>) => admin.patch("/api/settings/users/permissions", b);
    const g = await change({ userId: ids.b, expected: [], grant: ["crm.settings.manage", "crm.customer.export"] });
    expect(g.status).toBe(200);
    expect((await body<{ user: { permissions: string[] } }>(g)).user.permissions).toEqual(["crm.customer.export", "crm.settings.manage"]);
    expect((await worker.get("/api/settings/pipeline")).status).toBe(200);
    expect((await change({ userId: ids.b, expected: [], revoke: ["crm.settings.manage"] })).status).toBe(409); // elavult előnézet
    const v = await change({ userId: ids.b, expected: ["crm.customer.export", "crm.settings.manage"], revoke: ["crm.settings.manage"] });
    expect(v.status).toBe(200);
    expect((await worker.get("/api/settings/pipeline")).status).toBe(403); // P04: azonnal, a meglévő munkamenetre is
    const self = await change({ userId: ids.a, expected: ["crm.settings.audit.read", "crm.settings.manage", "crm.users.manage"], revoke: ["crm.users.manage"] });
    expect(self.status).toBe(403);
    expect((await change({ userId: ids.a, expected: ["crm.settings.audit.read", "crm.settings.manage", "crm.users.manage"], grant: ["crm.customer.import"] })).status).toBe(403);
    const bad = await change({ userId: ids.b, expected: ["crm.customer.export"], grant: ["ops.backup.restore"] });
    expect(bad.status).toBe(400);
    expect((await change({ userId: ids.b, expected: ["crm.customer.export"], grant: ["superuser"] })).status).toBe(400);
    // P08 (DB): a függvény engedélyezőlistája sem enged más jogot; ismeretlen felhasználó; közvetlen írás a táblába nincs.
    await expect(t.db.asUser(ids.a, (tx) => tx.query("select app_admin_set_permission($1, 'crm.db.restore', true)", [ids.b]))).rejects.toThrow(/invalid_permission/);
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into user_permissions (user_id, permission, granted_by) values ($1, 'crm.users.manage', 'x')", [ids.a]))).rejects.toThrow();
    await expect(t.db.asUser(ids.b, (tx) => tx.query("select app_admin_set_permission($1, 'crm.users.manage', true)", [ids.b]))).rejects.toThrow(/forbidden|self/);
    await expect(t.db.asUser(ids.b, (tx) => tx.query("select * from app_admin_users()"))).rejects.toThrow(/forbidden/);
    // P07: az egyetlen felhasználókezelő admin nem vonhatja vissza a saját jogát (a jogosultságkezelés elérhető marad).
    const holders = await t.db.system((tx) => tx.query("select user_id from user_permissions where permission = 'crm.users.manage' and revoked_at is null"));
    expect(holders).toEqual([{ user_id: ids.a }]);
    // Második admin kijelölése után az első admin jogát a második visszavonhatja; a saját magáét egyik sem.
    expect((await change({ userId: ids.b, expected: ["crm.customer.export"], grant: ["crm.users.manage"] })).status).toBe(200);
    const revokeA = await worker.patch("/api/settings/users/permissions", { userId: ids.a, expected: ["crm.settings.audit.read", "crm.settings.manage", "crm.users.manage"], revoke: ["crm.users.manage"] });
    expect(revokeA.status).toBe(200);
    expect((await admin.get("/api/settings/users")).status).toBe(403);
    expect((await worker.patch("/api/settings/users/permissions", { userId: ids.b, expected: ["crm.customer.export", "crm.users.manage"], revoke: ["crm.users.manage"] })).status).toBe(403);
    expect((await worker.patch("/api/settings/users/permissions", { userId: ids.a, expected: ["crm.settings.audit.read", "crm.settings.manage"], grant: ["crm.users.manage"] })).status).toBe(200);
    // A második admin jogát az első visszavonja; az utolsó-admin szabály az adatbázisban is véd (lásd migrációs teszt).
    expect((await change({ userId: ids.b, expected: ["crm.customer.export", "crm.users.manage"], revoke: ["crm.users.manage", "crm.customer.export"] })).status).toBe(200);
    // U06/A04/A05: minden változás naplózott, a módosító azonosítójával; a sorok megmaradnak (visszavont jelöléssel).
    const log = (await audit()).filter((a) => a.entity_type === "user_permission" && a.via === "app");
    expect(log.filter((a) => a.outcome === "success").map((a) => [a.action, a.entity_key, a.actor_user_id])).toEqual([
      ["permission.grant", `${ids.b}:crm.customer.export`, ids.a],
      ["permission.grant", `${ids.b}:crm.settings.manage`, ids.a],
      ["permission.revoke", `${ids.b}:crm.settings.manage`, ids.a],
      ["permission.grant", `${ids.b}:crm.users.manage`, ids.a],
      ["permission.revoke", `${ids.a}:crm.users.manage`, ids.b],
      ["permission.grant", `${ids.a}:crm.users.manage`, ids.b],
      ["permission.revoke", `${ids.b}:crm.customer.export`, ids.a],
      ["permission.revoke", `${ids.b}:crm.users.manage`, ids.a],
    ]);
    expect(log.filter((a) => a.outcome === "rejected").map((a) => a.reason)).toEqual(expect.arrayContaining(["self", "invalid_permission"]));
    const rows = await t.db.system((tx) => tx.query<{ revoked_at: unknown }>("select revoked_at from user_permissions where user_id = $1 and permission = 'crm.settings.manage'", [ids.b]));
    expect(rows).toHaveLength(1);
    expect(rows[0].revoked_at).not.toBeNull();
  });

  it("P07 (DB): ha a többi felhasználókezelő admin letiltott, az egyetlen aktív admin a saját jogát a függvényen át sem vonhatja vissza", async () => {
    // A felületen kívül, közvetlen függvényhívással is: az önmódosítás tiltott, így az utolsó aktív admin nem zárhatja ki a rendszert.
    // (A függvény ezen felül az "utolsó aktív admin" visszavonását is tiltja - védelem arra az esetre, ha a hívó szabálya később változna.)
    await grant(t.db, EMAIL_B, "crm.users.manage");
    await setActive(t.db, EMAIL_A, false);
    await expect(t.db.asUser(ids.b, (tx) => tx.query("select app_admin_set_permission($1, 'crm.users.manage', false)", [ids.b]))).rejects.toThrow(/self/);
    expect(await t.db.system((tx) => tx.query("select count(*)::int as n from user_permissions where permission = 'crm.users.manage' and revoked_at is null"))).toEqual([{ n: 2 }]);
    await setActive(t.db, EMAIL_A, true);
    await admin.login(EMAIL_A, PASSWORD_A); // a letiltás a munkameneteit törölte
    // Üzemeltetői helyreállítási út: a tulajdonosi CLI (külön jóváhagyással) ettől függetlenül kezelheti a jogokat.
    await revokePermission(t.db, { email: EMAIL_B, permission: "crm.users.manage", operator: OPERATOR, env: "local" });
  });

  it("A01-A03/A06/A07: a konfigurációs változások naplózottak (régi/új érték); a napló csak joggal olvasható és nem módosítható", async () => {
    const all = await audit();
    const acts = all.filter((a) => a.outcome === "success" && a.via === "app").map((a) => a.action);
    for (const a of ["pipeline_status.create", "pipeline_status.rename", "pipeline_status.recolor", "pipeline_status.reorder", "pipeline_status.archive", "pipeline_status.reactivate",
      "task_type.create", "task_type.rename", "task_type.reorder", "task_type.archive", "task_input.create", "task_input.rename", "task_input.archive"]) {
      expect(acts, a).toContain(a);
    }
    const rename = all.find((a) => a.action === "pipeline_status.rename" && a.entity_key === "ajanlatkeres")!;
    expect(rename.changes).toEqual({ label: { from: "Ajánlatkérés", to: "Ajánlatkérés folyamatban" } });
    expect(rename.actor_user_id).toBe(ids.a);
    // Csak konfigurációs érték és azonosító kerül a naplóba (ügyfélnév, jegyzet, Output nem).
    expect(JSON.stringify(all)).not.toMatch(/Fiktív Státusz Elek|Fiktív eredmény|password|token/);
    const page = await body<{ entries: { action: string; actorName: string; entityLabel?: string }[]; nextBefore: number | null }>(await admin.get("/api/settings/audit?limit=5"));
    expect(page.entries).toHaveLength(5);
    expect(page.nextBefore).not.toBeNull();
    expect((await admin.get(`/api/settings/audit?limit=5&before=${page.nextBefore}`)).status).toBe(200);
    expect((await admin.get("/api/settings/audit?limit=abc")).status).toBe(400);
    expect((await worker.get("/api/settings/audit")).status).toBe(403);
    // RLS: jog nélkül közvetlenül sem olvasható; módosítás és törlés senkinek (a tulajdonosnak sem) engedett.
    expect(await t.db.asUser(ids.b, (tx) => tx.query("select * from settings_audit"))).toEqual([]);
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update settings_audit set reason = 'x'"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("delete from settings_audit"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into settings_audit (via, actor_user_id, action, entity_type, entity_key) values ('app', $1, 'hamis', 'settings', 'x')", [ids.a]))).rejects.toThrow();
    await expect(t.db.system((tx) => tx.query("update settings_audit set reason = 'x'"))).rejects.toThrow(/nem módosítható/);
    await expect(t.db.system((tx) => tx.query("delete from settings_audit"))).rejects.toThrow(/nem módosítható/);
  });

  it("N01/N05/D04: áttekintés valós adatokkal; adatkezelési joggal az áttekintés elérhető, a konfiguráció nem; a v1.0 jogok változatlanul érvényesek", async () => {
    const o = await body<{ permissions: string[]; users: { active: number; settingsAdmins: number; userAdmins: number } | null; catalogs: Record<string, { active: number; archived: number }>; lastChangeAt: string | null; imports: { commitEnabled: boolean } }>(await admin.get("/api/settings/overview"));
    expect(o.users).toMatchObject({ active: 3, settingsAdmins: 1, userAdmins: 1 });
    expect(o.catalogs.pipeline).toEqual({ active: 9, archived: 0 });
    expect(o.catalogs.taskTypes).toEqual({ active: 6, archived: 1 });
    expect(o.lastChangeAt).not.toBeNull();
    expect(o.imports.commitEnabled).toBe(false);
    const d = await body<{ permissions: string[]; users: unknown }>(await dataOnly.get("/api/settings/overview"));
    expect(d.permissions).toEqual(["crm.customer.export"]);
    expect(d.users).toBeNull();
    expect((await dataOnly.get("/api/settings/pipeline")).status).toBe(403);
    expect((await dataOnly.post("/api/data/export/count", { filters: { crmStatus: "ajanlatkeres" } })).status).toBe(200);
    // S17: export az új státusszal (név az aktuális katalógusból); ismeretlen kulcs -> 400.
    const exp = await dataOnly.post("/api/data/export", { format: "csv", filters: { crmStatus: "ajanlatkeres" } });
    expect(exp.status).toBe(200);
    expect(Buffer.from(await exp.arrayBuffer()).toString("utf8")).toContain("Ajánlatkérés folyamatban");
    expect((await dataOnly.post("/api/data/export", { format: "csv", filters: { crmStatus: "nincs_ilyen" } })).status).toBe(400);
    expect((await admin.post("/api/data/export", { format: "csv", filters: {} })).status).toBe(403); // az adminjog nem ad exportjogot
  });
});
