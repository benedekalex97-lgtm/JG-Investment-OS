import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { XlsxWorkbook } from "@/server/data/files/xlsx";
import { ZipReader } from "@/server/data/files/zip";
import { decodeCsv, parseCsv } from "@/server/data/files/csv";
import { CUSTOMER_COLUMNS } from "@/server/data/export";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";
import { grant } from "./data-helpers";

/** CRM-017 / CRM-018: szűrt ügyfélexport valódi PostgreSQL-en, fiktív adattal. */
const L = { maxRows: 1000, maxColumns: 50, maxCellChars: 5000, deadline: Date.now() + 60_000 };

describe.each(DRIVERS)("ügyfélexport (%s)", (kind) => {
  let t: TestDb;
  let admin: Client, worker: Client;
  let ids: Record<string, string> = {};

  beforeAll(async () => {
    t = await makeTestDb(kind);
    const { a } = await addPilotUsers(t.db);
    await grant(t.db, "pilot.egy@example.test", "crm.customer.export");
    const handle = makeApi(t.db);
    admin = client(handle);
    worker = client(handle);
    await admin.login("pilot.egy@example.test", PASSWORD_A);
    await worker.login("pilot.ketto@example.test", PASSWORD_B);
    const mk = async (key: string, input: Record<string, unknown>) => {
      ids[key] = (await admin.op<{ customer: { id: string } }>("customer.create", { input, confirmDuplicates: true })).body.result.value!.customer.id;
    };
    ids = {};
    await mk("anna", { type: "individual", name: "Export Anna", phone: "+36 30 000 0201", email: "anna@example.test", source: "Rendezvény", notes: "BIZALMAS JEGYZET" });
    await mk("bela", { type: "individual", name: "=HYPERLINK(\"http://tamado.example.test\")", email: "bela@example.test", source: "Ajánlás" });
    await mk("ceg", { type: "company", companyName: "Export Kft.", phone: "+36 1 000 0202", contactName: "Elsődleges Elek", contactPosition: "ügyvezető", source: "Rendezvény" });
    await mk("torolt", { type: "individual", name: "Törölt Tóbiás", email: "tobias@example.test", source: "Rendezvény" });
    await admin.op("customer.changeStatus", { customerId: ids.anna, input: { toStatus: "meeting" } });
    await t.db.system(async (tx) => {
      await tx.query("insert into company_contacts (id, company_id, first_name, last_name, position, email, phone, is_primary, created_at, updated_at) values ('kont-masodik', $1, 'Kata', 'Második', 'pénzügy', 'kata@export-kft.example.test', '+36 1 000 0203', false, now(), now())", [ids.ceg]);
      await tx.query("update customers set deleted_at = now(), deleted_by = $2 where id = $1", [ids.torolt, a.id]);
      await tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ($1, 'objection', 'fiktív tiltakozás szövege', now(), $2)", [ids.bela, a.id]);
      await tx.query("insert into oauth_identities (issuer, subject, user_id) values ('https://accounts.google.com', 'fiktiv-oauth-subject', $1)", [a.id]);
    });
  });
  afterAll(async () => { await t.cleanup(); });

  const exportOf = (c: Client, format: string, filters: Record<string, unknown> = {}) => c.post("/api/data/export", { format, filters });
  const csvRows = async (res: Response) => parseCsv(decodeCsv(Buffer.from(await res.arrayBuffer()), "utf-8"), L).rows;

  it("E01/E03/E08/E09/E12: CSV - csak aktív ügyfelek, engedélyezett mezők, képletinjekció ellen semlegesítve, nem cache-elhető", async () => {
    const res = await exportOf(admin, "csv");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/csv; charset=utf-8");
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="JG_CRM_Ugyfelek_\d{4}-\d{2}-\d{2}_\d{4}\.csv"$/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    expect(res.headers.get("cache-control")).toContain("private");
    expect(res.headers.get("cdn-cache-control")).toBe("no-store");
    expect(res.headers.get("x-jg-export-count")).toBe("3");
    const raw = Buffer.from(await res.clone().arrayBuffer());
    expect([...raw.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    const rows = await csvRows(res);
    expect(rows[0]).toEqual([...CUSTOMER_COLUMNS]);
    expect(rows).toHaveLength(4);
    const text = raw.toString("utf8");
    for (const banned of ["Törölt Tóbiás", "BIZALMAS JEGYZET", "fiktív tiltakozás szövege", "fiktiv-oauth-subject", "scrypt", "password", "pilot.egy@example.test"]) expect(text).not.toContain(banned);
    const bela = rows.find((r) => r[0] === ids.bela)!;
    expect(bela[2]).toBe("'=HYPERLINK(\"http://tamado.example.test\")");
    expect(bela[15]).toBe("Tiltakozás");
    const anna = rows.find((r) => r[0] === ids.anna)!;
    expect(anna.slice(1, 8)).toEqual(["Magánszemély", "Export Anna", "Export", "Anna", "", "'+36 30 000 0201", "anna@example.test"]);
    expect(anna[13]).toBe("Online/Személyes tárgyalás");
  });

  it("E02/E13: XLSX - Ügyfelek, Kapcsolattartók (minden kapcsolattartó, veszteségmentesen) és Exportinformáció; értékek változatlanok, képlet nincs", async () => {
    const res = await exportOf(admin, "xlsx");
    expect(res.headers.get("content-type")).toBe("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
    const buf = Buffer.from(await res.arrayBuffer());
    const wb = new XlsxWorkbook(buf, L);
    expect(wb.sheetInfo().map((s) => s.name)).toEqual(["Ügyfelek", "Kapcsolattartók", "Exportinformáció"]);
    const cust = wb.read(0).rows;
    expect(cust.find((r) => r[0] === ids.bela)![2]).toBe("=HYPERLINK(\"http://tamado.example.test\")");
    expect(wb.read(0).flags.formula.size).toBe(0);
    for (let i = 1; i <= 3; i++) expect(new ZipReader(buf).text(`xl/worksheets/sheet${i}.xml`)).not.toContain("<f>");
    const ceg = cust.find((r) => r[0] === ids.ceg)!;
    expect(ceg.slice(8, 13)).toEqual(["Elsődleges Elek", "ügyvezető", "", "", "1"]);
    const contacts = wb.read(1).rows;
    expect(contacts.slice(1).map((r) => [r[0], r[3], r[4], r[8]])).toEqual([[ids.ceg, "Elsődleges", "Elek", "Igen"], [ids.ceg, "Második", "Kata", "Nem"]]);
    expect(wb.read(2).rows.map((r) => r[0])).toEqual(["Megnevezés", "Exportálva", "Szűrés", "Ügyfelek száma", "Figyelmeztetés"]);
  });

  it("E04/E05/E06/E07: státusz-, típus-, adatforrás- és szöveges szűrés (a CRM keresőlogikájával: telefonszámra is); darabszám-előnézet", async () => {
    const ids1 = async (filters: Record<string, unknown>) => (await csvRows(await exportOf(admin, "csv", filters))).slice(1).map((r) => r[0]).sort();
    expect(await ids1({ crmStatus: "meeting" })).toEqual([ids.anna]);
    expect(await ids1({ type: "company" })).toEqual([ids.ceg]);
    expect(await ids1({ source: "rendezvény " })).toEqual([ids.anna, ids.ceg].sort());
    expect(await ids1({ query: "06 1 000 0203" })).toEqual([ids.ceg]);
    expect(await ids1({ query: "anna@" })).toEqual([ids.anna]);
    expect(await ids1({ query: "Tóbiás" })).toEqual([]);
    const cnt = (await (await admin.post("/api/data/export/count", { filters: { source: "Rendezvény" } })).json()) as { count: number; sources: string[] };
    expect(cnt).toEqual({ count: 2, sources: ["Ajánlás", "Rendezvény"] });
    expect((await exportOf(admin, "pdf")).status).toBe(400);
    expect((await exportOf(admin, "csv", { crmStatus: "ismeretlen" })).status).toBe(400);
  });

  it("E10/P02: munkatárs nem exportálhat (a szerver tilt); E11: export auditálva, a keresőkifejezés szövege nélkül", async () => {
    expect((await exportOf(worker, "csv")).status).toBe(403);
    expect((await worker.post("/api/data/export/count", { filters: {} })).status).toBe(403);
    expect((await (await worker.get("/api/auth/me")).json() as { permissions: string[] }).permissions).toEqual([]);
    expect((await (await admin.get("/api/auth/me")).json() as { permissions: string[] }).permissions).toEqual(["crm.customer.export"]);
    await exportOf(admin, "xlsx", { query: "Titkos Keresés", crmStatus: "meeting" });
    const rows = await t.db.system((tx) => tx.query<{ detail: Record<string, unknown> }>("select detail from audit_events where action = 'customer.export' order by id desc limit 1"));
    expect(rows[0].detail).toMatchObject({ format: "xlsx", ok: true, count: 0, filters: { crmStatus: "meeting", query: true, queryLength: 14 } });
    expect(JSON.stringify(rows)).not.toContain("Titkos");
    const denied = await t.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from audit_events where action = 'data.denied' and detail->>'route' like 'data/export%'"));
    expect(Number(denied[0].n)).toBeGreaterThanOrEqual(2);
  });

  it("CSRF és tartalomtípus: más eredetű export-kérés elutasítva", async () => {
    const res = await admin.post("/api/data/export", { format: "csv", filters: {} }, { origin: "https://tamado.example.test" });
    expect(res.status).toBe(403);
  });
});
