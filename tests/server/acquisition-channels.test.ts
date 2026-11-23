import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { BUILTIN_CRM_CONFIG } from "@/domain/config";
import { customerHistory } from "@/domain/history";
import { channelReport, customerName } from "@/domain/logic";
import type { Customer, DataSnapshot } from "@/domain/types";
import { exportBackup, restoreBackup, tableChecksum, type Backup } from "@/server/backup";
import { loadConfig } from "@/server/crm/store";
import { decodeCsv, parseCsv } from "@/server/data/files/csv";
import { XlsxWorkbook } from "@/server/data/files/xlsx";
import { CUSTOMER_COLUMNS } from "@/server/data/export";
import { checkSchema, migrate, MIGRATIONS } from "@/server/db/migrate";
import { baseOptions, csv, grant, uploader, type Uploader } from "./data-helpers";
import { addPilotUsers, client, DRIVERS, makeApi, makeTestDb, PASSWORD_A, PASSWORD_B, type Client, type TestDb } from "./helpers";

/**
 * v1.2 érkezési csatornák: migráció és visszagörgetés, katalógus-védelmek (DB és API), kötelező csatorna kézi felvételnél, ügyféltörténet,
 * export (oszlopok, szűrés, képletvédelem), import (opcionális oszlop, kapu változatlan), kimutatás, mentés/visszaállítás.
 * Valódi PostgreSQL-en (PGlite; JG_TEST_DATABASE_URL esetén külön szerveren is). Kizárólag fiktív adat.
 */
const T0 = "2026-05-01T08:00:00.000Z";
const L = { maxRows: 1000, maxColumns: 50, maxCellChars: 5000, deadline: Date.now() + 60_000 };
const V10_11 = MIGRATIONS.slice(0, 10);
const KEYS = ["weboldal", "google_kereses", "google_cegprofil", "facebook", "linkedin", "bemutatkozo_level", "ajanlas", "szemelyes_ismeretseg", "kh_ertekpapir", "rendezveny", "egyeb", "ismeretlen"];

interface Item { key: string; label: string; version: number; isActive: boolean; isSystem: boolean; sortOrder: number; description?: string | null; usage: { customers?: number; tasks: number; openTasks: number } }

describe.each(DRIVERS)("v1.2 migráció és visszagörgetés (%s)", (kind) => {
  it("a meglévő ügyfelek `ismeretlen` csatornát kapnak, a `source` és minden más adat változatlan; a katalógus a 12 kezdő elem; a rollback működik és adatvesztés ellen véd", async () => {
    const t = await makeTestDb(kind, { migrate: false });
    const sql12 = readFileSync(join(__dirname, "../../scripts/sql/v1.2-schema-rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    try {
      await migrate(t.db, { env: "local", migrations: V10_11 });
      await t.db.system(async (tx) => {
        await tx.query("insert into users (id, email, name, password_hash) values ('u-1','m12@example.test','M12','x')");
        await tx.query("insert into customers (id, type, display_name, owner_id, source, crm_status, created_at, updated_at) values ('c-1','individual','Régi Rita','u-1','Fiktív import','contact',$1,$1)", [T0]);
        await tx.query("insert into customers (id, type, company_name, owner_id, source, created_at, updated_at) values ('c-2','company','Régi Kft.','u-1','',$1,$1)", [T0]);
      });
      const before = await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by id"));
      expect(await checkSchema(t.db, "local")).toEqual({ ok: false, reason: "schema_outdated" });
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0011_crm_acquisition_channels"]);
      const after = await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by id"));
      expect(after.map(({ acquisition_channel, acquisition_detail, ...rest }) => { expect([acquisition_channel, acquisition_detail]).toEqual(["ismeretlen", null]); return rest; })).toEqual(before);
      const cat = await t.db.system((tx) => tx.query<{ key: string; label: string; is_system: boolean; is_active: boolean; sort_order: number; version: number }>("select * from crm_acquisition_channels order by sort_order"));
      expect(cat.map((c) => c.key)).toEqual(KEYS);
      expect(cat.map((c) => c.label)).toEqual(BUILTIN_CRM_CONFIG.acquisitionChannels.map((c) => c.label));
      expect(cat.filter((c) => c.is_system).map((c) => c.key)).toEqual(["ismeretlen"]);
      expect(cat.every((c) => c.is_active && c.version === 1)).toBe(true);
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from settings_audit"))).toEqual([{ n: 0 }]);
      expect(await migrate(t.db, { env: "local" })).toEqual({ applied: [], alreadyApplied: MIGRATIONS.map((m) => m.id) });

      // Rollback: adatvesztés ellen véd (nem alapértelmezett csatorna), és semmi nem változik.
      await t.db.system((tx) => tx.query("update customers set acquisition_channel = 'ajanlas', acquisition_detail = 'fiktív' where id = 'c-1'"));
      await expect(t.db.system((tx) => tx.exec(sql12))).rejects.toThrow(/érkezési csatorna\/részlet/);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
      // Tudatos vállalás (mentés után): a kapcsolat beállításával engedélyezhető.
      await t.db.system((tx) => tx.query("insert into crm_acquisition_channels (key, label, sort_order) values ('uj','Új fiktív',130)"));
      await t.db.system(async (tx) => { await tx.query("select set_config('jg.rollback_discard_channels', 'yes', true)"); await tx.exec(sql12); });
      expect(await checkSchema(t.db, "local", V10_11)).toEqual({ ok: true });
      expect(await t.db.system((tx) => tx.query("select to_regclass('crm_acquisition_channels') as a"))).toEqual([{ a: null }]);
      const cols = await t.db.system((tx) => tx.query<{ column_name: string }>("select column_name from information_schema.columns where table_name = 'customers' and column_name like 'acquisition%'"));
      expect(cols).toEqual([]);
      const back = await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by id"));
      expect(back).toEqual(before);
      // A katalógus-napló megmaradt (nem módosítható napló), a régi CHECK az új sorokra érvényes.
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from settings_audit where entity_type = 'acquisition_channel'"))).toEqual([{ n: 1 }]);
      // A v1.1.x működés a visszagörgetett sémán: a katalógus-triggerek (pipeline) épek.
      await t.db.system((tx) => tx.query("insert into crm_pipeline_statuses (key, label, sort_order) values ('proba','Próba',80)"));
      // Újra előre: a migráció ismét alkalmazható, az ügyfelek ismét `ismeretlen` alapértéket kapnak.
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0011_crm_acquisition_channels"]);
      expect(await t.db.system((tx) => tx.query("select distinct acquisition_channel from customers"))).toEqual([{ acquisition_channel: "ismeretlen" }]);
    } finally {
      await t.cleanup();
    }
  });

  it("ha a 0011 egy utasítása hibázik, az egész visszagördül (nincs félkész séma)", async () => {
    const t = await makeTestDb(kind, { migrate: false });
    try {
      await migrate(t.db, { env: "local", migrations: V10_11 });
      const broken = { ...MIGRATIONS[10], sql: `${MIGRATIONS[10].sql}\nselect 1/0;` };
      await expect(migrate(t.db, { env: "local", migrations: [...V10_11, broken] })).rejects.toThrow();
      expect(await t.db.system((tx) => tx.query("select to_regclass('crm_acquisition_channels') as a"))).toEqual([{ a: null }]);
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from information_schema.columns where table_name = 'customers' and column_name like 'acquisition%'"))).toEqual([{ n: 0 }]);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: false, reason: "schema_outdated" });
    } finally {
      await t.cleanup();
    }
  });
});

describe.each(DRIVERS)("v1.2 érkezési csatornák - API és adatbázis-védelmek (%s)", (kind) => {
  let t: TestDb;
  let admin: Client;
  let worker: Client;
  let A: Uploader;
  let ids: { a: string; b: string };
  const prevFlag = process.env.JG_CUSTOMER_IMPORT_ENABLED;

  const body = async <T = Record<string, unknown>>(r: Response) => (await r.json()) as T;
  const list = async (c: Client = admin) => (await body<{ items: Item[] }>(await c.get("/api/settings/acquisition-channels"))).items;
  const snap = async (c: Client = admin) => (await body<{ snapshot: DataSnapshot }>(await c.get("/api/crm/snapshot"))).snapshot;
  const create = async (input: Record<string, unknown>, c: Client = admin) => (await c.op<{ customer: Customer }>("customer.create", { input, confirmDuplicates: true })).body.result;
  const audit = () => t.db.system((tx) => tx.query<{ action: string; entity_type: string; entity_key: string; actor_user_id: string | null; changes: Record<string, { from: unknown; to: unknown }> | null; outcome: string }>("select * from settings_audit where entity_type = 'acquisition_channel' order by id"));

  beforeAll(async () => {
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    ids = { a: u.a.id, b: u.b.id };
    await grant(t.db, "pilot.egy@example.test", "crm.settings.manage", "crm.settings.audit.read", "crm.customer.export", "crm.customer.import", "crm.import.history.read");
    const handle = makeApi(t.db);
    admin = client(handle);
    worker = client(handle);
    await admin.login("pilot.egy@example.test", PASSWORD_A);
    await worker.login("pilot.ketto@example.test", PASSWORD_B);
    A = uploader(handle, admin);
  });
  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.JG_CUSTOMER_IMPORT_ENABLED; else process.env.JG_CUSTOMER_IMPORT_ENABLED = prevFlag;
    await t.cleanup();
  });

  it("katalógus: a 12 kezdő elem, használati számokkal; jogosulatlan felhasználó nem olvashatja és nem írhatja a szerkesztő végpontot (403), az elutasítás naplózott", async () => {
    const items = await list();
    expect(items.map((i) => [i.key, i.isSystem, i.isActive, i.usage.customers])).toEqual(KEYS.map((k) => [k, k === "ismeretlen", true, 0]));
    expect(items.map((i) => i.sortOrder)).toEqual([10, 20, 30, 40, 50, 60, 70, 80, 90, 100, 110, 120]);
    expect((await worker.get("/api/settings/acquisition-channels")).status).toBe(403);
    expect((await worker.post("/api/settings/acquisition-channels", { label: "Behatoló" })).status).toBe(403);
    expect((await worker.patch("/api/settings/acquisition-channels", { key: "egyeb", version: 1, label: "X" })).status).toBe(403);
    expect((await worker.patch("/api/settings/acquisition-channels/order", { order: [{ key: "egyeb", version: 1 }] })).status).toBe(403);
    expect((await client(makeApi(t.db)).get("/api/settings/acquisition-channels")).status).toBe(401);
    expect((await list()).find((i) => i.label === "Behatoló")).toBeUndefined();
    const denied = await t.db.system((tx) => tx.query<{ entity_type: string; outcome: string }>("select entity_type, outcome from settings_audit where actor_user_id = $1 and outcome = 'rejected'", [ids.b]));
    expect(denied.length).toBeGreaterThanOrEqual(3);
    expect(denied.every((d) => d.entity_type === "acquisition_channel")).toBe(true);
    // A munkatárs a katalógust (snapshot) olvassa, hogy válasszon - írni nem tud.
    expect((await snap(worker)).config.acquisitionChannels.map((c) => c.key)).toEqual(KEYS);
    expect((await body<{ catalogs: Record<string, { active: number }> }>(await admin.get("/api/settings/overview"))).catalogs.acquisitionChannels).toEqual({ active: 12, archived: 0 });
  });

  it("katalógus: új elem (stabil kulcs), átnevezés, leírás, sorrend, archiválás és újraaktiválás - verzióval, naplóval; a kulcs és a rendszerjelölés nem módosítható", async () => {
    const r = await admin.post("/api/settings/acquisition-channels", { label: "TBSZ-kampány", description: "Fiktív kampány" });
    expect(r.status).toBe(201);
    const it1 = (await body<{ item: Item }>(r)).item;
    expect(it1).toMatchObject({ key: "tbsz_kampany", label: "TBSZ-kampány", description: "Fiktív kampány", isSystem: false, isActive: true, version: 1, sortOrder: 130 });
    const bad = async (b: unknown, status = 400) => expect((await admin.post("/api/settings/acquisition-channels", b)).status, JSON.stringify(b)).toBe(status);
    await bad({ label: "" });
    await bad({ label: "x".repeat(61) });
    await bad({ label: "Sor\ntörés" });
    await bad({ label: "Kulcs", key: "weboldal" });
    await bad({ label: "Rendszer", isSystem: true });
    await bad({ label: "Szín", color: "ok" });
    await bad({ label: "google-keresés" }, 409);
    const ren = await admin.patch("/api/settings/acquisition-channels", { key: it1.key, version: 1, label: "TBSZ kampány 2026", description: null });
    expect(ren.status).toBe(200);
    expect((await body<{ item: Item }>(ren)).item).toMatchObject({ key: "tbsz_kampany", label: "TBSZ kampány 2026", description: null, version: 2 });
    // Elavult verzió: 409, nincs csendes felülírás.
    expect((await admin.patch("/api/settings/acquisition-channels", { key: it1.key, version: 1, label: "Elavult" })).status).toBe(409);
    expect((await admin.patch("/api/settings/acquisition-channels", { key: it1.key, version: 2, isSystem: false })).status).toBe(400);
    expect((await admin.patch("/api/settings/acquisition-channels", { key: it1.key, version: 2, newKey: "masik" })).status).toBe(400);
    // Sorrend: teljes lista, a szerver ellenőrzi.
    const cur = await list();
    const order = [...cur].reverse().map((i) => ({ key: i.key, version: i.version }));
    expect((await admin.patch("/api/settings/acquisition-channels/order", { order })).status).toBe(200);
    expect((await list()).map((i) => i.key)).toEqual([...KEYS, "tbsz_kampany"].reverse());
    expect((await admin.patch("/api/settings/acquisition-channels/order", { order: order.slice(1) })).status).toBe(409);
    const restore = (await list()).reverse().map((i) => ({ key: i.key, version: i.version }));
    expect((await admin.patch("/api/settings/acquisition-channels/order", { order: restore })).status).toBe(200);
    // Archiválás és újraaktiválás.
    const cur2 = (await list()).find((i) => i.key === "tbsz_kampany")!;
    const arch = await admin.patch("/api/settings/acquisition-channels", { key: "tbsz_kampany", version: cur2.version, isActive: false });
    expect(arch.status).toBe(200);
    const archived = (await list()).find((i) => i.key === "tbsz_kampany")!;
    expect(archived.isActive).toBe(false);
    expect((await admin.patch("/api/settings/acquisition-channels", { key: "tbsz_kampany", version: archived.version, isActive: true })).status).toBe(200);
    const actions = (await audit()).filter((a) => a.outcome === "success" && a.entity_key === "tbsz_kampany").map((a) => a.action);
    expect(actions).toEqual(["acquisition_channel.create", "acquisition_channel.update", "acquisition_channel.reorder", "acquisition_channel.reorder", "acquisition_channel.archive", "acquisition_channel.reactivate"]);
    const renameEntry = (await audit()).find((a) => a.action === "acquisition_channel.update" && a.entity_key === "tbsz_kampany")!;
    expect(renameEntry.changes).toMatchObject({ label: { from: "TBSZ-kampány", to: "TBSZ kampány 2026" }, description: { from: "Fiktív kampány", to: null } });
    expect(renameEntry.actor_user_id).toBe(ids.a);
  });

  it("DB-védelmek: kulcs és rendszerjelölés nem írható, törlés nincs, rendszerelem nem archiválható (API és közvetlen DB), jog nélkül közvetlenül sem írható", async () => {
    // Az „Ismeretlen” rendszerelem nem archiválható: API-n érthető 400 + naplózott elutasítás, DB-n őr-trigger.
    const unk = (await list()).find((i) => i.key === "ismeretlen")!;
    const r = await admin.patch("/api/settings/acquisition-channels", { key: "ismeretlen", version: unk.version, isActive: false });
    expect(r.status).toBe(400);
    expect((await body<{ error: string }>(r)).error).toBe("system_archive");
    expect((await audit()).some((a) => a.outcome === "rejected" && a.entity_key === "ismeretlen")).toBe(true);
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_acquisition_channels set is_active = false where key = 'ismeretlen'"))).rejects.toThrow(/system_archive/);
    await expect(t.db.system((tx) => tx.query("update crm_acquisition_channels set is_active = false where key = 'ismeretlen'"))).rejects.toThrow(/system_archive/);
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_acquisition_channels set key = 'masik' where key = 'egyeb'"))).rejects.toThrow();
    await expect(t.db.system((tx) => tx.query("update crm_acquisition_channels set key = 'masik' where key = 'egyeb'"))).rejects.toThrow(/protected_field/);
    await expect(t.db.system((tx) => tx.query("update crm_acquisition_channels set is_system = true where key = 'egyeb'"))).rejects.toThrow(/protected_field/);
    await expect(t.db.asUser(ids.a, (tx) => tx.query("update crm_acquisition_channels set is_system = false where key = 'ismeretlen'"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into crm_acquisition_channels (key, label, sort_order, is_system) values ('hamis','Hamis',5,true)"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("delete from crm_acquisition_channels where key = 'egyeb'"))).rejects.toThrow();
    // Jog nélkül (munkatárs) közvetlenül sem írható, beszúrni sem lehet.
    await expect(t.db.asUser(ids.b, (tx) => tx.query("update crm_acquisition_channels set label = 'X' where key = 'egyeb'"))).resolves.toEqual([]);
    await expect(t.db.asUser(ids.b, (tx) => tx.query("insert into crm_acquisition_channels (key, label, sort_order) values ('behato','Behatoló',5)"))).rejects.toThrow();
    expect((await list()).find((i) => i.key === "egyeb")!.label).toBe("Egyéb");
    // Egyedi megnevezés (kis-/nagybetűtől függetlenül) és formai korlátok az adatbázisban is.
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into crm_acquisition_channels (key, label, sort_order) values ('dup','EGYÉB',5)"))).rejects.toThrow();
    await expect(t.db.asUser(ids.a, (tx) => tx.query("insert into crm_acquisition_channels (key, label, sort_order) values ('Rossz Kulcs','Rossz',5)"))).rejects.toThrow();
  });

  it("kézi felvétel: az érkezési csatorna kötelező (alapértelmezés nincs), csak aktív elem; az `ismeretlen` kifejezetten választható; a szerver a szabályt a felülettől függetlenül érvényesíti", async () => {
    const without = await create({ type: "individual", name: "Csatorna Nélküli Csaba" });
    expect(without.ok).toBe(false);
    expect(without.errors).toMatchObject({ acquisitionChannel: expect.stringMatching(/kötelező/) });
    expect((await create({ type: "individual", name: "Csatorna Nélküli Csaba", acquisitionChannel: "" })).errors?.acquisitionChannel).toBeTruthy();
    expect((await create({ type: "individual", name: "Csatorna Nélküli Csaba", acquisitionChannel: "nincs_ilyen" })).errors?.acquisitionChannel).toMatch(/nem választható/);
    expect((await create({ type: "individual", name: "Csatorna Nélküli Csaba", acquisitionChannel: "weboldal", acquisitionDetail: "x".repeat(201) })).errors?.acquisitionDetail).toMatch(/200/);
    expect((await snap()).customers.filter((c) => customerName(c).startsWith("Csatorna Nélküli"))).toHaveLength(0);
    const ok = await create({ type: "individual", name: "Kézi Kata", acquisitionChannel: "ajanlas", acquisitionDetail: "ajánlotta: meglévő ügyfél", recordedBy: "valaki-mas" });
    expect(ok.ok).toBe(true);
    expect(ok.value!.customer).toMatchObject({ acquisitionChannel: "ajanlas", acquisitionDetail: "ajánlotta: meglévő ügyfél", ownerId: ids.a });
    expect((await create({ type: "company", companyName: "Ismeretlen Kft.", acquisitionChannel: "ismeretlen" })).value!.customer.acquisitionChannel).toBe("ismeretlen");
    // Archivált csatorna új ügyfélhez nem választható (API), közvetlenül az adatbázisban sem (trigger).
    const fb = (await list()).find((i) => i.key === "facebook")!;
    expect((await admin.patch("/api/settings/acquisition-channels", { key: "facebook", version: fb.version, isActive: false, confirmInUse: true })).status).toBe(200);
    expect((await create({ type: "individual", name: "Archív Árpád", acquisitionChannel: "facebook" })).errors?.acquisitionChannel).toMatch(/nem választható/);
    await expect(t.db.asUser(ids.b, (tx) => tx.query("insert into customers (id, type, display_name, owner_id, acquisition_channel, created_at, updated_at) values ('c-x','individual','X',$1,'facebook',now(),now())", [ids.b]))).rejects.toThrow(/inactive_channel/);
    await expect(t.db.asUser(ids.b, (tx) => tx.query("insert into customers (id, type, display_name, owner_id, acquisition_channel, created_at, updated_at) values ('c-y','individual','Y',$1,'nincs_ilyen',now(),now())", [ids.b]))).rejects.toThrow();
    await admin.patch("/api/settings/acquisition-channels", { key: "facebook", version: fb.version + 1, isActive: true });
  });

  it("adatlap: a módosítás az ügyféltörténetbe kerül (ki, mikor, régi → új); idempotens újraküldés nem duplikál; archivált csatornán lévő ügyfél más adata menthető; DB-upsert is", async () => {
    const c = (await create({ type: "individual", name: "Előzmény Eszter", acquisitionChannel: "linkedin" })).value!.customer;
    const up = await worker.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter", acquisitionChannel: "bemutatkozo_level", acquisitionDetail: "bemutatkozó levél, 2026. nov." } }, "11111111-1111-4111-8111-111111111111");
    expect(up.body.result.ok).toBe(true);
    const again = await worker.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter", acquisitionChannel: "bemutatkozo_level", acquisitionDetail: "bemutatkozó levél, 2026. nov." } }, "11111111-1111-4111-8111-111111111111");
    expect(again.body.replayed).toBe(true);
    const s = await snap();
    const acts = s.activities.filter((a) => a.customerId === c.id && a.type === "acquisition_change");
    expect(acts).toHaveLength(1);
    expect(acts[0]).toMatchObject({ recordedBy: ids.b, meta: { fromAcquisitionChannel: "linkedin", toAcquisitionChannel: "bemutatkozo_level", fromAcquisitionDetail: null, toAcquisitionDetail: "bemutatkozó levél, 2026. nov." } });
    expect(Date.parse(acts[0].occurredAt)).toBeGreaterThan(Date.parse("2026-01-01"));
    const h = customerHistory(s, c.id, (v) => v ?? "")[0];
    expect(h.title).toBe("Érkezési csatorna módosítva");
    expect(h.details.slice(0, 2)).toEqual([{ label: "Korábbi érkezési csatorna", value: "LinkedIn" }, { label: "Új érkezési csatorna", value: "Bemutatkozó levél" }]);
    // Csak egy részlet változik / a változatlan mentés nem naplóz.
    await admin.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter", acquisitionChannel: "bemutatkozo_level", acquisitionDetail: "bemutatkozó levél, 2026. nov." } });
    expect((await snap()).activities.filter((a) => a.customerId === c.id && a.type === "acquisition_change")).toHaveLength(1);
    await admin.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter", acquisitionDetail: "" } });
    expect((await snap()).activities.filter((a) => a.customerId === c.id && a.type === "acquisition_change")).toHaveLength(2);
    // Audit: csak mezőnevek, érték nélkül.
    const aud = await t.db.system((tx) => tx.query<{ detail: { fields: string[] } }>("select detail from audit_events where action = 'customer.update' and customer_id = $1 order by id", [c.id]));
    expect(aud[0].detail.fields).toEqual(expect.arrayContaining(["acquisitionChannel", "acquisitionDetail"]));
    expect(JSON.stringify(aud)).not.toContain("bemutatkozó levél");
    // Archivált csatornán lévő ügyfél: a név módosítható (változatlan csatornával), a csatorna nem választható újra.
    const li = (await list()).find((i) => i.key === "bemutatkozo_level")!;
    expect((await admin.patch("/api/settings/acquisition-channels", { key: "bemutatkozo_level", version: li.version, isActive: false, confirmInUse: true })).status).toBe(200);
    expect((await admin.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter Új", acquisitionChannel: "bemutatkozo_level" } })).body.result.ok).toBe(true);
    expect((await admin.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter Új", acquisitionChannel: "linkedin" } })).body.result.ok).toBe(true);
    expect((await admin.op("customer.update", { id: c.id, input: { type: "individual", name: "Előzmény Eszter Új", acquisitionChannel: "bemutatkozo_level" } })).body.result.errors?.acquisitionChannel).toMatch(/nem választható/);
    await t.db.asUser(ids.b, (tx) => tx.query("update customers set acquisition_channel = 'linkedin' where id = $1", [c.id]));
    await t.db.asUser(ids.b, (tx) => tx.query("update customers set display_name = 'Upsert Eszter', acquisition_channel = 'linkedin' where id = $1", [c.id]));
    await admin.patch("/api/settings/acquisition-channels", { key: "bemutatkozo_level", version: li.version + 1, isActive: true });
    // Használt csatorna archiválása megerősítést kér (nincs csendes átsorolás).
    const used = (await list()).find((i) => i.key === "linkedin")!;
    expect(used.usage.customers).toBeGreaterThanOrEqual(1);
    const noConfirm = await admin.patch("/api/settings/acquisition-channels", { key: "linkedin", version: used.version, isActive: false });
    expect(noConfirm.status).toBe(409);
    expect((await body<{ error: string }>(noConfirm)).error).toBe("in_use");
    expect((await snap()).customers.find((x) => x.id === c.id)!.acquisitionChannel).toBe("linkedin");
  });

  it("ügyféllista és kimutatás: a számok egyeznek az adatbázissal (csatornánként, státuszonként, időszakra)", async () => {
    const mk = (name: string, ch: string) => create({ type: "individual", name, acquisitionChannel: ch });
    const id = async (name: string, ch: string) => (await mk(name, ch)).value!.customer.id;
    const g1 = await id("Kimutatás Géza", "google_kereses");
    await id("Kimutatás Gizi", "google_kereses");
    const r1 = await id("Kimutatás Rita", "rendezveny");
    await admin.op("customer.changeStatus", { customerId: g1, input: { toStatus: "meeting" } });
    await admin.op("customer.changeStatus", { customerId: r1, input: { toStatus: "contact" } });
    const s = await snap();
    const rep = channelReport(s);
    const dbCounts = await t.db.system((tx) => tx.query<{ acquisition_channel: string; n: string }>("select acquisition_channel, count(*) as n from customers where deleted_at is null group by 1"));
    for (const r of dbCounts) expect(rep.rows.find((x) => x.channel === r.acquisition_channel)!.total).toBe(Number(r.n));
    expect(rep.totals.total).toBe(dbCounts.reduce((n, r) => n + Number(r.n), 0));
    const row = rep.rows.find((x) => x.channel === "google_kereses")!;
    expect(row).toMatchObject({ total: 2, byStatus: { meeting: 1, waiting_for_contact: 1 } });
    expect(channelReport(s, { from: "2099-01-01" }).totals.total).toBe(0);
    // Logikailag eltávolított ügyfél nem számít a kimutatásban.
    await t.db.system((tx) => tx.query("update customers set deleted_at = now(), deleted_by = $2 where id = $1", [g1, ids.a]));
    expect(channelReport(await snap()).rows.find((x) => x.channel === "google_kereses")!.total).toBe(1);
  });

  it("export: új oszlopok (csatorna megnevezése, részlet), szűrés csatornára, képletinjekció elleni védelem; ismeretlen csatorna a szűrőben 400", async () => {
    const lab = (await list()).find((i) => i.key === "szemelyes_ismeretseg")!;
    await admin.patch("/api/settings/acquisition-channels", { key: "szemelyes_ismeretseg", version: lab.version, label: "+Személyes (fiktív)" });
    await create({ type: "individual", name: "Export Ede", acquisitionChannel: "szemelyes_ismeretseg", acquisitionDetail: "=HYPERLINK(\"http://tamado.example.test\")" });
    await create({ type: "company", companyName: "Export Csatorna Kft.", acquisitionChannel: "kh_ertekpapir", acquisitionDetail: "K&H közvetítés, 2026. nov." });
    const exp = (format: string, filters: Record<string, unknown> = {}) => admin.post("/api/data/export", { format, filters });
    const rowsOf = async (filters: Record<string, unknown> = {}) => parseCsv(decodeCsv(Buffer.from(await (await exp("csv", filters)).arrayBuffer()), "utf-8"), L).rows;
    const all = await rowsOf();
    expect(all[0]).toEqual([...CUSTOMER_COLUMNS]);
    const cCh = CUSTOMER_COLUMNS.indexOf("Érkezési csatorna");
    const cDe = CUSTOMER_COLUMNS.indexOf("Érkezési csatorna részlete");
    expect([cCh, cDe]).toEqual([CUSTOMER_COLUMNS.indexOf("Adatforrás") + 1, CUSTOMER_COLUMNS.indexOf("Adatforrás") + 2]);
    const ede = all.find((r) => r[2] === "Export Ede")!;
    expect(ede[cCh]).toBe("'+Személyes (fiktív)");
    expect(ede[cDe]).toBe("'=HYPERLINK(\"http://tamado.example.test\")");
    const kft = all.find((r) => r[2] === "Export Csatorna Kft.")!;
    expect([kft[cCh], kft[cDe]]).toEqual(["K&H Értékpapír közvetítése", "K&H közvetítés, 2026. nov."]);
    expect((await rowsOf({ acquisitionChannel: "kh_ertekpapir" })).slice(1).map((r) => r[2])).toEqual(["Export Csatorna Kft."]);
    expect((await rowsOf({ acquisitionChannel: "szemelyes_ismeretseg", type: "individual" })).slice(1).map((r) => r[2])).toEqual(["Export Ede"]);
    expect((await rowsOf({ acquisitionChannel: "linkedin", type: "company" })).slice(1)).toEqual([]);
    expect((await exp("csv", { acquisitionChannel: "nincs_ilyen" })).status).toBe(400);
    expect((await admin.post("/api/data/export/count", { filters: { acquisitionChannel: "kh_ertekpapir" } })).status).toBe(200);
    expect((await body<{ count: number }>(await admin.post("/api/data/export/count", { filters: { acquisitionChannel: "kh_ertekpapir" } }))).count).toBe(1);
    // XLSX: szöveges cellák, képlet nincs; a szűrés leírása a munkalapon.
    const buf = Buffer.from(await (await exp("xlsx", { acquisitionChannel: "szemelyes_ismeretseg" })).arrayBuffer());
    const wb = new XlsxWorkbook(buf, L);
    const cust = wb.read(0).rows;
    expect(cust[1][cCh]).toBe("+Személyes (fiktív)");
    expect(cust[1][cDe]).toBe("=HYPERLINK(\"http://tamado.example.test\")");
    expect(wb.read(0).flags.formula.size).toBe(0);
    expect(wb.read(2).rows.find((r) => r[0] === "Szűrés")![1]).toBe("Érkezési csatorna: +Személyes (fiktív)");
    expect((await worker.post("/api/data/export", { format: "csv", filters: { acquisitionChannel: "kh_ertekpapir" } })).status).toBe(403);
    await admin.patch("/api/settings/acquisition-channels", { key: "szemelyes_ismeretseg", version: lab.version + 1, label: "Személyes ismeretség" });
  });

  it("import: a csatorna opcionálisan megfeleltethető; ismeretlen vagy hiányzó érték `ismeretlen`; az import kapuja és szabályai változatlanok", async () => {
    const HEAD = ["Ügyféltípus", "Név", "E-mail", "Érkezési csatorna"];
    const MAP = ["type", "fullName", "email", "acquisitionChannel"];
    const rows = [
      ["Magánszemély", "Import Ilona", "ilona.i@example.test", "LinkedIn"],
      ["Magánszemély", "Import Imre", "imre.i@example.test", "ajanlas"],
      ["Magánszemély", "Import Irén", "iren.i@example.test", ""],
      ["Magánszemély", "Import István", "istvan.i@example.test", "Hirdetés"],
    ];
    const opts = baseOptions(MAP);
    const pv = await A.upload("/api/data/import/preview", csv([HEAD, ...rows]), opts);
    expect(pv.status).toBe(200);
    const b = pv.body as unknown as { jobId: string; summary: Record<string, number>; rows: { rowNo: number; state: string; issues: { code: string }[] }[]; commitAllowed: boolean };
    // Csak a felismerhetetlen érték ad figyelmeztetést (döntés kell); a hiányzó csendben `ismeretlen`.
    expect(b.summary).toMatchObject({ total: 4, valid: 3, warning: 1, error: 0, importByDefault: 3 });
    expect(b.rows.find((r) => r.issues.some((i) => i.code === "unknown_channel"))!.state).toBe("W");
    expect(await t.db.system((tx) => tx.query("select count(*)::int as n from customers where email like '%.i@example.test'"))).toEqual([{ n: 0 }]);
    const cm = await A.upload("/api/data/import/commit", csv([HEAD, ...rows]), { jobId: b.jobId, decisions: { 5: "import" } });
    expect(cm.status).toBe(200);
    const got = await t.db.system((tx) => tx.query<{ email: string; acquisition_channel: string; acquisition_detail: string | null; crm_status: string }>("select email, acquisition_channel, acquisition_detail, crm_status from customers where email like '%.i@example.test' order by email"));
    expect(got).toEqual([
      { email: "ilona.i@example.test", acquisition_channel: "linkedin", acquisition_detail: null, crm_status: "waiting_for_contact" },
      { email: "imre.i@example.test", acquisition_channel: "ajanlas", acquisition_detail: null, crm_status: "waiting_for_contact" },
      { email: "iren.i@example.test", acquisition_channel: "ismeretlen", acquisition_detail: null, crm_status: "waiting_for_contact" },
      { email: "istvan.i@example.test", acquisition_channel: "ismeretlen", acquisition_detail: null, crm_status: "waiting_for_contact" },
    ]);
    // Oszlop nélküli (régi) fájl: változatlan; a `source` az import adatforrása marad, nem a csatorna.
    const p2 = await A.upload("/api/data/import/preview", csv([["Ügyféltípus", "Név", "E-mail"], ["Magánszemély", "Régi Fájl Réka", "reka.r@example.test"]]), baseOptions(["type", "fullName", "email"]));
    const b2 = p2.body as unknown as { jobId: string; summary: Record<string, number> };
    expect(b2.summary).toMatchObject({ valid: 1, importByDefault: 1 });
    expect((await A.upload("/api/data/import/commit", csv([["Ügyféltípus", "Név", "E-mail"], ["Magánszemély", "Régi Fájl Réka", "reka.r@example.test"]]), { jobId: b2.jobId, decisions: {} })).status).toBe(200);
    expect(await t.db.system((tx) => tx.query("select acquisition_channel, source from customers where email = 'reka.r@example.test'"))).toEqual([{ acquisition_channel: "ismeretlen", source: "Fiktív teszt-adatbázis" }]);
    // Az import kapuja változatlan: kikapcsolt kapunál nincs véglegesítés.
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "false";
    try {
      const p3 = await A.upload("/api/data/import/preview", csv([HEAD, ["Magánszemély", "Kapu Kata", "kata.k@example.test", "Facebook"]]), opts);
      expect((p3.body as unknown as { commitAllowed: boolean }).commitAllowed).toBe(false);
      const c3 = await A.upload("/api/data/import/commit", csv([HEAD, ["Magánszemély", "Kapu Kata", "kata.k@example.test", "Facebook"]]), { jobId: (p3.body as unknown as { jobId: string }).jobId, decisions: {} });
      expect(c3.status).toBe(403);
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from customers where email = 'kata.k@example.test'"))).toEqual([{ n: 0 }]);
    } finally {
      process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    }
    // Sablon: új oszlop az útmutatóval.
    const tpl = await admin.get("/api/data/import/template");
    expect(tpl.status).toBe(200);
    const wb = new XlsxWorkbook(Buffer.from(await tpl.arrayBuffer()), L);
    expect(wb.read(0).rows[0]).toContain("Érkezési csatorna");
    expect(wb.read(1).rows.some((r) => r[0] === "Érkezési csatorna" && r[3].includes("Google-keresés"))).toBe(true);
  });

  it("mentés és visszaállítás: a csatorna-katalógus és az ügyfél-mezők bájtra azonosan állnak vissza; a triggerek utána élnek; régi (0010) formátumú mentés is visszaállítható", async () => {
    const backup = JSON.parse(JSON.stringify(await exportBackup(t.db, "local"))) as Backup;
    expect(backup.migration).toBe("0011_crm_acquisition_channels");
    expect(backup.counts.crm_acquisition_channels).toBeGreaterThanOrEqual(13);
    expect(backup.tables.customers.every((c) => "acquisition_channel" in c)).toBe(true);
    const dst = await makeTestDb(kind);
    try {
      await restoreBackup(dst.db, backup, "local");
      for (const [tbl, order] of [["crm_acquisition_channels", "key"], ["customers", "created_at, id"], ["settings_audit", "id"]] as const) {
        const rows = await dst.db.system((tx) => tx.query<Record<string, unknown>>(`select * from ${tbl} order by ${order}`));
        expect(tableChecksum(JSON.parse(JSON.stringify(rows))), tbl).toBe(tableChecksum(backup.tables[tbl]));
      }
      await expect(dst.db.system((tx) => tx.query("update crm_acquisition_channels set is_active = false where key = 'ismeretlen'"))).rejects.toThrow(/system_archive/);
    } finally { await dst.cleanup(); }
    // v1.1.1 (0010) formátum: a csatorna-tábla és az új oszlopok hiányoznak a mentésből - alapértékkel állnak vissza.
    const old = JSON.parse(JSON.stringify(backup)) as Backup;
    old.migration = "0010_crm_customer_delete_permission";
    delete old.tables.crm_acquisition_channels;
    delete old.counts.crm_acquisition_channels;
    old.tables.customers = old.tables.customers.map(({ acquisition_channel: _c, acquisition_detail: _d, ...rest }) => { void _c; void _d; return rest; });
    old.tables.settings_audit = old.tables.settings_audit.filter((r) => r.entity_type !== "acquisition_channel");
    old.counts.settings_audit = old.tables.settings_audit.length;
    const dst2 = await makeTestDb(kind);
    try {
      await restoreBackup(dst2.db, old, "local");
      expect(await dst2.db.system((tx) => tx.query("select distinct acquisition_channel, acquisition_detail from customers"))).toEqual([{ acquisition_channel: "ismeretlen", acquisition_detail: null }]);
      const cfg = await dst2.db.asUser(ids.a, (tx) => loadConfig(tx));
      expect(cfg.acquisitionChannels.map((c) => c.key)).toEqual(KEYS);
    } finally { await dst2.cleanup(); }
  });
});
