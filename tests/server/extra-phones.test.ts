import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { evaluateRow, suggestMapping, type ColumnMapping } from "@/domain/data-import";
import { findDuplicates } from "@/domain/duplicates";
import { customerMatches } from "@/domain/logic";
import { EXTRA_PHONES_MAX, splitPhoneList, uniquePhones } from "@/domain/phones";
import { customerUpdateInput, newCustomerForm } from "@/domain/schemas";
import { emptySnapshot, type Customer, type DataSnapshot } from "@/domain/types";
import { exportBackup, restoreBackup, tableChecksum, type Backup } from "@/server/backup";
import { decodeCsv, parseCsv } from "@/server/data/files/csv";
import { CUSTOMER_COLUMNS } from "@/server/data/export";
import { TEMPLATE_HEADERS } from "@/server/data/template";
import { checkSchema, LATEST_MIGRATION, migrate, MIGRATIONS } from "@/server/db/migrate";
import { baseOptions, csv, grant, uploader, type Uploader } from "./data-helpers";
import { addPilotUsers, client, DRIVERS, makeApi, makeTestDb, PASSWORD_A, type Client, type TestDb } from "./helpers";

/**
 * v1.4 több telefonszám ügyfelenként: tartományi szabályok, migráció és visszagörgetés, API (felvétel, szerkesztés), import (több szám egy
 * cellában), egyezésvizsgálat, tiltólista, anonimizálás, export, mentés. Kizárólag fiktív adat (000-s számok, example.test).
 */
const T0 = "2026-05-01T08:00:00.000Z";
const L = { maxRows: 1000, maxColumns: 50, maxCellChars: 5000, deadline: Date.now() + 60_000 };
const V13 = MIGRATIONS.slice(0, 12);

describe("v1.4 tartományi szabályok", () => {
  it("bontás és ismétlődés-szűrés: vessző, pontosvessző, sortörés; a formázás és az előhívó nem számít", () => {
    expect(splitPhoneList("+36205550001, +36 20 555 0002;06 20 555 0003\n\n +36 1 555 0004 ")).toEqual(["+36205550001", "+36 20 555 0002", "06 20 555 0003", "+36 1 555 0004"]);
    expect(uniquePhones(["+36 20 555 0001", "06 20 555 0001", "+36 20 555 0002"], ["06-20-555-0002"])).toEqual(["+36 20 555 0001"]);
  });

  it("űrlap: a további számok szövegként és tömbként is megadhatók; érvénytelen elem és 9-nél több szám elutasítva", () => {
    const base = { type: "company", companyName: "Fiktív Kft.", acquisitionChannel: "egyeb", recordedBy: "u-1" } as const;
    const a = newCustomerForm.safeParse({ ...base, extraPhones: "+36 20 555 0001, +36 20 555 0001\n+36 1 555 0002" });
    expect(a.success && a.data.type === "company" && a.data.extraPhones).toEqual(["+36 20 555 0001", "+36 1 555 0002"]);
    const b = newCustomerForm.safeParse({ ...base, extraPhones: ["+36 20 555 0001"] });
    expect(b.success).toBe(true);
    const bad = newCustomerForm.safeParse({ ...base, extraPhones: "+36 20 555 0001, nem szám" });
    expect(bad.success).toBe(false);
    expect(bad.error?.issues[0]).toMatchObject({ path: ["extraPhones"], message: "Érvénytelen telefonszám a további számok között" });
    const many = Array.from({ length: EXTRA_PHONES_MAX + 1 }, (_, i) => `+36 20 555 ${String(1000 + i)}`);
    expect(newCustomerForm.safeParse({ ...base, extraPhones: many }).error?.issues[0].message).toMatch(/Legfeljebb 9 további/);
    // Szerkesztésnél a hiányzó mező = változatlan (undefined), az üres = törlés (üres lista).
    const u1 = customerUpdateInput.safeParse({ type: "company", companyName: "Fiktív Kft." });
    expect(u1.success && u1.data.extraPhones).toBeUndefined();
    const u2 = customerUpdateInput.safeParse({ type: "company", companyName: "Fiktív Kft.", extraPhones: "" });
    expect(u2.success && u2.data.extraPhones).toEqual([]);
  });

  it("import: a Telefonszám cellában több szám - az első a fő, a többi további; a További telefonszámok oszlop is beolvad", () => {
    const map: ColumnMapping = ["companyName", "phone", "extraPhones"];
    const ok = evaluateRow(["Fiktív Kft.", "+36205550001, +36205550002, +36205550001;+36 1 555 0003", "06 30 555 0004, +36205550002"], map, "company");
    expect(ok.status).toBe("valid");
    expect(ok.draft).toMatchObject({ phone: "+36 20 555 0001", extraPhones: ["+36 20 555 0002", "+36 1 555 0003", "+36 30 555 0004"] });
    // Csak a További telefonszámok oszlop: az első szám lesz a fő szám.
    expect(evaluateRow(["Fiktív Kft.", "", "+36205550005; +36205550006"], map, "company").draft).toMatchObject({ phone: "+36 20 555 0005", extraPhones: ["+36 20 555 0006"] });
    // Egyetlen szám: nincs további.
    expect(evaluateRow(["Fiktív Kft.", "+36205550007", ""], map, "company").draft).not.toHaveProperty("extraPhones");
    const bad = evaluateRow(["Fiktív Kft.", "+36205550001, 12", ""], map, "company");
    expect(bad.status).toBe("error");
    expect(bad.issues).toEqual([expect.objectContaining({ code: "invalid_phone", field: "phone", message: "Érvénytelen telefonszám (a cellában szereplő számok egyike)." })]);
    const many = Array.from({ length: EXTRA_PHONES_MAX + 2 }, (_, i) => `+3620555${String(1000 + i)}`).join(", ");
    const tooMany = evaluateRow(["Fiktív Kft.", many, ""], map, "company");
    expect(tooMany.status).toBe("error");
    expect(tooMany.issues.map((i) => i.code)).toEqual(["too_many_phones"]);
    // A hibaüzenet nem tartalmaz cellaértéket.
    expect(JSON.stringify([bad.issues, tooMany.issues])).not.toMatch(/555/);
    // Pontosan 10 szám még elfogadott.
    const ten = Array.from({ length: EXTRA_PHONES_MAX + 1 }, (_, i) => `+3620555${String(1000 + i)}`).join("; ");
    expect(evaluateRow(["Fiktív Kft.", ten, ""], map, "company").draft?.extraPhones).toHaveLength(EXTRA_PHONES_MAX);
    // Felismert oszlopnevek; a sablon minden oszlopa felismerhető.
    expect(suggestMapping(["Cégnév", "Telefonszámok", "További telefonszámok"])).toEqual(["companyName", "phone", "extraPhones"]);
    expect(suggestMapping(TEMPLATE_HEADERS).every((m) => m !== null)).toBe(true);
  });

  it("v1.4.1: vidéki vezetékes szám (kétjegyű körzetszám + 6 jegy) figyelmeztetés nélkül normalizálódik; a cella végén levágott szám kimarad", () => {
    const map: ColumnMapping = ["companyName", "phone"];
    for (const raw of ["+3624520191", "06 24 520 191", "0036-24-520-191", "3624520191"]) {
      const r = evaluateRow(["Fiktív Kft.", raw], map, "company");
      expect(r.status, raw).toBe("valid");
      expect(r.draft?.phone, raw).toBe("+36 24 520 191");
    }
    // Budapest és mobil változatlan; a hiányos mobilszám és a külföldi szám továbbra is figyelmeztet.
    expect(evaluateRow(["Fiktív Kft.", "+3612610778"], map, "company").draft?.phone).toBe("+36 1 261 0778");
    expect(evaluateRow(["Fiktív Kft.", "+36205550001"], map, "company").draft?.phone).toBe("+36 20 555 0001");
    for (const raw of ["+3620555000", "+44 20 7946 0958", "24520191"]) expect(evaluateRow(["Fiktív Kft.", raw], map, "company").issues.map((i) => i.code), raw).toEqual(["phone_format"]);
    // Opten-minta: több szám, az utolsó levágva.
    const cut = evaluateRow(["Fiktív Kft.", "+3624520191, +3624520192, +3624520"], map, "company");
    expect(cut.status).toBe("warning");
    expect(cut.issues.map((i) => i.code)).toEqual(["phone_truncated"]);
    expect(cut.draft).toMatchObject({ phone: "+36 24 520 191", extraPhones: ["+36 24 520 192"] });
    // Egyetlen rövid szám nem „levágott vég”: a régi szabály (figyelmeztetés, változatlan érték) érvényes.
    expect(evaluateRow(["Fiktív Kft.", "+3624520"], map, "company").issues.map((i) => i.code)).toEqual(["phone_format"]);
    // Középen álló rövid szám sem kerül csendben eldobásra.
    expect(evaluateRow(["Fiktív Kft.", "+3624520, +3624520191"], map, "company").issues.map((i) => i.code)).toEqual(["phone_format"]);
  });

  it("egyezés és keresés: a további számok is erős egyezést adnak és kereshetők", () => {
    const snap: DataSnapshot = emptySnapshot();
    const c: Customer = {
      id: "c-1", type: "company", companyName: "Meglévő Kft.", contactStatus: "prospect", ownerId: "u-1", source: "", acquisitionChannel: "ismeretlen",
      verificationStatus: "demo", phone: "+36 1 555 0100", extraPhones: ["+36 20 555 0101"], createdAt: T0, updatedAt: T0,
    };
    snap.customers = [c];
    expect(findDuplicates(snap, { type: "company", companyName: "Más Kft.", phone: "06 20 555 0101" })).toEqual([expect.objectContaining({ customerId: "c-1", level: "strong", codes: ["phone"] })]);
    expect(findDuplicates(snap, { type: "company", companyName: "Más Kft.", phone: "+36 30 555 0999", extraPhones: ["+36 1 555 0100"] })[0]?.level).toBe("strong");
    expect(findDuplicates(snap, { type: "company", companyName: "Más Kft.", phone: "+36 30 555 0999" })).toEqual([]);
    expect(customerMatches(snap, c, "20 555 0101")).toEqual([{ field: "phone", label: "További telefonszám", value: "+36 20 555 0101" }]);
  });
});

describe.each(DRIVERS)("v1.4 migráció és visszagörgetés (%s)", (kind) => {
  it("a meglévő ügyfelek üres listát kapnak, más adat nem változik; a CHECK véd; a rollback adatvesztés ellen véd, és újra előre alkalmazható", async () => {
    const t = await makeTestDb(kind, { migrate: false });
    const sql14 = readFileSync(join(__dirname, "../../scripts/sql/v1.4-schema-rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    try {
      await migrate(t.db, { env: "local", migrations: V13 });
      await t.db.system(async (tx) => {
        await tx.query("insert into users (id, email, name, password_hash) values ('u-1','m14@example.test','M14','x')");
        await tx.query("insert into customers (id, type, company_name, owner_id, phone, created_at, updated_at) values ('c-1','company','Régi Kft.','u-1','+36 1 555 0001',$1,$1)", [T0]);
      });
      const before = await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by id"));
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0013_customer_extra_phones"]);
      expect(LATEST_MIGRATION).toBe("0013_customer_extra_phones");
      const after = await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by id"));
      expect(after.map(({ extra_phones, ...rest }) => { expect(extra_phones).toEqual([]); return rest; })).toEqual(before);

      const set = (v: string) => t.db.system((tx) => tx.query(`update customers set extra_phones = ${v} where id = 'c-1'`));
      await set("array['+36 20 555 0002', '06 (30) 555-0003', '+36/1/555/0004']");
      expect((await t.db.system((tx) => tx.query<{ extra_phones: string[] }>("select extra_phones from customers")))[0].extra_phones).toEqual(["+36 20 555 0002", "06 (30) 555-0003", "+36/1/555/0004"]);
      for (const bad of ["array['nem telefonszám']", "array['+36 20 555 0002', null]", "array['12']", "array['+36 20 555 0002' || chr(10) || '+36 20 555 0003']",
        `array[${Array.from({ length: 10 }, (_, i) => `'+36 20 555 ${1000 + i}'`).join(", ")}]`]) {
        await expect(set(bad), bad).rejects.toThrow(/customers_extra_phones_chk/);
      }
      await expect(set("null")).rejects.toThrow();

      // Rollback: további számok mellett megáll, és semmi nem változik.
      await expect(t.db.system((tx) => tx.exec(sql14))).rejects.toThrow(/további telefonszám/);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
      await t.db.system(async (tx) => { await tx.query("select set_config('jg.rollback_discard_extra_phones', 'yes', true)"); await tx.exec(sql14); });
      expect(await checkSchema(t.db, "local", V13)).toEqual({ ok: true });
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from information_schema.columns where table_name = 'customers' and column_name = 'extra_phones'"))).toEqual([{ n: 0 }]);
      expect(await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by id"))).toEqual(before);
      // A visszaállított anonimizáló függvény a 0012-es változat (a további számokat nem ismeri), és működik.
      const fn = await t.db.system((tx) => tx.query<{ src: string }>("select prosrc as src from pg_proc where proname = 'privacy_anonymize_customer'"));
      expect(fn[0].src).not.toContain("extra_phones");
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0013_customer_extra_phones"]);
    } finally {
      await t.cleanup();
    }
  });
});

describe.each(DRIVERS)("v1.4 több telefonszám - API, import, adatvédelem, export, mentés (%s)", (kind) => {
  let t: TestDb;
  let admin: Client;
  let A: Uploader;
  let adminId = "";
  const prevFlag = process.env.JG_CUSTOMER_IMPORT_ENABLED;
  const raw = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => t.db.system((tx) => tx.query<T & Record<string, unknown>>(sql, p));
  const snap = async () => ((await (await admin.get("/api/crm/snapshot")).json()) as { snapshot: DataSnapshot }).snapshot;
  const create = async (input: Record<string, unknown>) => (await admin.op<{ customer: Customer }>("customer.create", { input: { acquisitionChannel: "egyeb", ...input }, confirmDuplicates: true })).body.result;

  beforeAll(async () => {
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    adminId = u.a.id;
    await grant(t.db, "pilot.egy@example.test", "crm.customer.import", "crm.customer.export", "crm.privacy.manage");
    const handle = makeApi(t.db);
    admin = client(handle);
    await admin.login("pilot.egy@example.test", PASSWORD_A);
    A = uploader(handle, admin);
  });
  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.JG_CUSTOMER_IMPORT_ENABLED; else process.env.JG_CUSTOMER_IMPORT_ENABLED = prevFlag;
    await t.cleanup();
  });

  it("felvétel és szerkesztés: a további számok mentődnek; a fő számmal azonos és ismétlődő elem kimarad; hiányzó mező = változatlan, üres = törlés", async () => {
    const r = await create({ type: "company", companyName: "Többszámú Kft.", phone: "+36 1 555 0200", extraPhones: "+36 20 555 0201, 06 1 555 0200\n+36 20 555 0201" });
    expect(r.ok).toBe(true);
    const id = r.value!.customer.id;
    expect(r.value!.customer.extraPhones).toEqual(["+36 20 555 0201"]);
    expect((await raw("select phone, extra_phones from customers where id = $1", [id]))[0]).toEqual({ phone: "+36 1 555 0200", extra_phones: ["+36 20 555 0201"] });
    const u1 = await admin.op<Customer>("customer.update", { id, input: { type: "company", companyName: "Többszámú Kft.", phone: "+36 1 555 0200" } });
    expect(u1.body.result.value?.extraPhones).toEqual(["+36 20 555 0201"]);
    const u2 = await admin.op<Customer>("customer.update", { id, input: { type: "company", companyName: "Többszámú Kft.", phone: "+36 1 555 0200", extraPhones: "+36 20 555 0201; +36 30 555 0202" } });
    expect(u2.body.result.value?.extraPhones).toEqual(["+36 20 555 0201", "+36 30 555 0202"]);
    // Az audit csak a mező nevét tartalmazza, értéket nem.
    const [a] = await raw<{ detail: { fields: string[] } }>("select detail from audit_events where action = 'customer.update' and entity_id = $1 order by id desc limit 1", [id]);
    expect(a.detail.fields).toEqual(["extraPhones"]);
    expect(JSON.stringify(a.detail)).not.toContain("555");
    const bad = await admin.op<Customer>("customer.update", { id, input: { type: "company", companyName: "Többszámú Kft.", extraPhones: "nem szám" } });
    expect(bad.body.result).toMatchObject({ ok: false, errors: { extraPhones: "Érvénytelen telefonszám a további számok között" } });
    const u3 = await admin.op<Customer>("customer.update", { id, input: { type: "company", companyName: "Többszámú Kft.", phone: "+36 1 555 0200", extraPhones: "" } });
    expect(u3.body.result.value).not.toHaveProperty("extraPhones");
    expect((await raw("select extra_phones from customers where id = $1", [id]))[0].extra_phones).toEqual([]);
    // Az ügyféllistában/kereséssel a további szám is megtalálható.
    await admin.op("customer.update", { id, input: { type: "company", companyName: "Többszámú Kft.", phone: "+36 1 555 0200", extraPhones: ["+36 70 555 0203"] } });
    const s = await snap();
    const c = s.customers.find((x) => x.id === id)!;
    expect(customerMatches(s, c, "06 70 555 0203").map((m) => m.label)).toEqual(["További telefonszám"]);
  });

  it("kézi felvétel: a további számra is van egyezés-figyelmeztetés", async () => {
    const first = await create({ type: "company", companyName: "Első Kft.", phone: "+36 1 555 0300", extraPhones: ["+36 20 555 0301"] });
    expect(first.ok).toBe(true);
    const dup = (await admin.op("customer.create", { input: { type: "company", acquisitionChannel: "egyeb", companyName: "Második Kft.", phone: "06 20 555 0301" } })).body.result as { ok: boolean; errors?: Record<string, string> };
    expect(dup.ok).toBe(false);
    expect(dup.errors).toHaveProperty("_duplicate");
    const dup2 = (await admin.op("customer.create", { input: { type: "company", acquisitionChannel: "egyeb", companyName: "Harmadik Kft.", extraPhones: "+36 1 555 0300" } })).body.result as { ok: boolean; errors?: Record<string, string> };
    expect(dup2.errors).toHaveProperty("_duplicate");
  });

  it("import: több szám egy cellában - előnézet, egyezés a meglévő további számmal és a fájlon belül, véglegesítés", async () => {
    await create({ type: "company", companyName: "Meglévő Import Kft.", phone: "+36 1 555 0400", extraPhones: ["+36 20 555 0401"] });
    const HEAD = ["Cégnév", "Cégjegyzésre jogosult", "Tisztsége", "Telefonszám", "Érkezési csatorna"];
    const rows = [
      ["Opten Minta Kft.", "Minta Márton", "ügyvezető (vezető tisztségviselő)", "+36205550410, +36205550411, +36205550412", "Egyéb"],
      ["Ütköző Kft.", "Ütköző Ödön", "ügyvezető", "+36205550401", "Egyéb"],
      ["Fájlon Belüli Bt.", "Belső Béla", "ügyvezető", "+36205550420, +36205550411", "Egyéb"],
      ["Hibás Szám Kft.", "Hibás Hugó", "ügyvezető", "+36205550430, 12", "Egyéb"],
    ];
    const map = ["companyName", "contactName", "contactPosition", "phone", "acquisitionChannel"];
    const opts = baseOptions(map, { defaultType: "company", sourceName: "Opten adatbázis (fiktív teszt)" });
    const pv = await A.upload("/api/data/import/preview", csv([HEAD, ...rows]), opts);
    expect(pv.status).toBe(200);
    const b = pv.body as unknown as { jobId: string; rows: { rowNo: number; state: string; issues: { code: string }[]; display?: { phone?: string; extraPhones?: string[] } }[] };
    expect(b.rows.map((r) => r.state)).toEqual(["V", "S", "S", "E"]);
    expect(b.rows[0].display).toMatchObject({ phone: "+36 20 555 0410", extraPhones: ["+36 20 555 0411", "+36 20 555 0412"] });
    expect(b.rows[3].issues.map((i) => i.code)).toEqual(["invalid_phone"]);
    const cm = await A.upload("/api/data/import/commit", csv([HEAD, ...rows]), { jobId: b.jobId, decisions: {} });
    expect(cm.status).toBe(200);
    const [c] = await raw<{ phone: string; extra_phones: string[]; source: string; crm_status: string; acquisition_channel: string }>("select phone, extra_phones, source, crm_status, acquisition_channel from customers where company_name = 'Opten Minta Kft.'");
    expect(c).toEqual({ phone: "+36 20 555 0410", extra_phones: ["+36 20 555 0411", "+36 20 555 0412"], source: "Opten adatbázis (fiktív teszt)", crm_status: "waiting_for_contact", acquisition_channel: "egyeb" });
    // Ismételt import: a korábban importált ügyfél TOVÁBBI számára is erős egyezés.
    const again = await A.upload("/api/data/import/preview", csv([HEAD, ["Új Név Kft.", "Új Ubul", "ügyvezető", "06 20 555 0412", "Egyéb"]]), opts);
    expect((again.body as unknown as { rows: { state: string }[] }).rows.map((r) => r.state)).toEqual(["S"]);
  });

  it("tiltakozás: az ügyfél további számai is a tiltólistára kerülnek, az import ezeket elutasítja; anonimizáláskor a további számok törlődnek", async () => {
    const r = await create({ type: "company", companyName: "Tiltakozó Többszámú Kft.", phone: "+36 1 555 0500", email: "tiltakozo@example.test", extraPhones: ["+36 20 555 0501", "+36 30 555 0502"] });
    const id = r.value!.customer.id;
    const res = await admin.post("/api/privacy/restriction", { customerId: id, kind: "objection", note: "Fiktív tiltakozás" });
    expect(res.status).toBe(200);
    expect(Number((await raw("select count(*) as n from privacy_suppressions where reason = 'objection'"))[0].n)).toBe(4);
    const pv = await A.upload("/api/data/import/preview", csv([["Cégnév", "Telefonszám"], ["Más Kft.", "+36 70 555 0599; 06 30 555 0502"]]), baseOptions(["companyName", "phone"], { defaultType: "company" }));
    const rows = (pv.body as unknown as { rows: { state: string; issues: { code: string }[] }[] }).rows;
    expect(rows[0].state).toBe("R");
    expect(rows[0].issues.map((i) => i.code)).toContain("suppressed");
    // Kézi felvétel további számként is tiltólistás.
    const w = (await admin.op("customer.create", { input: { type: "company", acquisitionChannel: "egyeb", companyName: "Új Kft.", extraPhones: ["+36 20 555 0501"] } })).body.result as { ok: boolean; errors?: Record<string, string> };
    expect(w.errors).toHaveProperty("_suppressed");
    // Anonimizálás (a tulajdonosi magfüggvény; a teljes, négy-szem elvű folyamatot a privacy tesztek fedik).
    await raw("select privacy_anonymize_customer($1, $2)", [id, adminId]);
    expect((await raw("select phone, email, extra_phones from customers where id = $1", [id]))[0]).toEqual({ phone: null, email: null, extra_phones: [] });
  });

  it("export (CSV) a További telefonszámok oszloppal; mentés és visszaállítás bájtra azonos, a 0012-es mentés is visszaállítható", async () => {
    await create({ type: "individual", name: "Export Többszám Teréz", phone: "+36 30 555 0600", extraPhones: ["+36 1 555 0601", "+36 20 555 0602"] });
    const res = await admin.post("/api/data/export", { format: "csv", filters: { query: "Többszám Teréz" } });
    expect(res.status).toBe(200);
    const rows = parseCsv(decodeCsv(Buffer.from(await res.arrayBuffer()), "utf-8"), L).rows;
    const col = CUSTOMER_COLUMNS.indexOf("További telefonszámok");
    expect(col).toBe(CUSTOMER_COLUMNS.indexOf("Telefonszám") + 1);
    expect(rows[1][col]).toBe("'+36 1 555 0601; +36 20 555 0602");

    const backup = JSON.parse(JSON.stringify(await exportBackup(t.db, "local"))) as Backup;
    expect(backup.tables.customers.some((c) => Array.isArray(c.extra_phones) && (c.extra_phones as string[]).length === 2)).toBe(true);
    const dst = await makeTestDb(kind);
    try {
      await restoreBackup(dst.db, backup, "local");
      const back = await dst.db.system((tx) => tx.query<Record<string, unknown>>("select * from customers order by created_at, id"));
      expect(tableChecksum(JSON.parse(JSON.stringify(back)))).toBe(tableChecksum(backup.tables.customers));
    } finally { await dst.cleanup(); }
    // v1.3 (0012) formátum: az oszlop hiányzik a mentésből - üres listával áll vissza.
    const old = JSON.parse(JSON.stringify(backup)) as Backup;
    old.migration = "0012_crm_privacy";
    old.tables.customers = old.tables.customers.map(({ extra_phones: _x, ...rest }) => { void _x; return rest; });
    const dst2 = await makeTestDb(kind);
    try {
      await restoreBackup(dst2.db, old, "local");
      expect(await dst2.db.system((tx) => tx.query("select distinct extra_phones from customers"))).toEqual([{ extra_phones: [] }]);
    } finally { await dst2.cleanup(); }
  });
});
