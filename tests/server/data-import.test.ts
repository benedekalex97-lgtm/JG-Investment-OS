import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { revokePermission } from "@/server/data/permissions";
import { XlsxWorkbook } from "@/server/data/files/xlsx";
import type { DataSnapshot } from "@/domain/types";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";
import { OPERATOR, baseOptions, csv, grant, uploader, type Uploader } from "./data-helpers";

/**
 * CRM-014-016, CRM-018: ügyféladat-import valódi PostgreSQL-en (PGlite, és JG_TEST_DATABASE_URL esetén külön szerveren is).
 * Kizárólag fiktív adat (example.test, 000-s telefonszámok).
 */
const FIXTURE = join(__dirname, "..", "fixtures", "openpyxl-customers.xlsx");
const MAP = ["type", "fullName", "companyName", "phone", "email", "contactName", "status"];
const HEAD = ["Ügyféltípus", "Név", "Cégnév", "Telefon", "E-mail", "Kapcsolattartó", "Státusz"];
const T0 = new Date("2026-10-20T08:00:00.000Z");

describe.each(DRIVERS)("ügyféladat-import (%s)", (kind) => {
  let t: TestDb;
  let now = T0;
  let handle: (r: Request) => Promise<Response>;
  let admin: Client, worker: Client;
  let A: Uploader, W: Uploader;
  let adminId = "";
  const prevFlag = process.env.JG_CUSTOMER_IMPORT_ENABLED;

  beforeAll(async () => {
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    t = await makeTestDb(kind);
    adminId = (await addPilotUsers(t.db)).a.id;
    await grant(t.db, "pilot.egy@example.test", "crm.customer.import", "crm.import.history.read");
    handle = makeApi(t.db, "local", () => now);
    admin = client(handle);
    worker = client(handle);
    await admin.login("pilot.egy@example.test", PASSWORD_A);
    await worker.login("pilot.ketto@example.test", PASSWORD_B);
    A = uploader(handle, admin);
    W = uploader(handle, worker);
  });
  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.JG_CUSTOMER_IMPORT_ENABLED; else process.env.JG_CUSTOMER_IMPORT_ENABLED = prevFlag;
    await t.cleanup();
  });

  const snapshot = async (c: Client = admin) => ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: DataSnapshot }).snapshot;
  const count = async (sql: string, p: unknown[] = []) => Number((await t.db.system((tx) => tx.query<{ n: string }>(sql, p)))[0].n);
  const previewOf = async (rows: string[][], extra: Record<string, unknown> = {}, map = MAP, u = A) => u.upload("/api/data/import/preview", csv([HEAD.slice(0, map.length), ...rows]), baseOptions(map, extra));
  const commitOf = async (rows: string[][], jobId: string, decisions: Record<string, string> = {}, map = MAP) => A.upload("/api/data/import/commit", csv([HEAD.slice(0, map.length), ...rows]), { jobId, decisions });

  it("P01/P05/P09/P10: munkatárs (régi 'admin' szerepkörű, kiosztott jog nélkül) nem importálhat - a szerver a felülettől függetlenül tilt, és naplóz", async () => {
    const me = (await (await worker.get("/api/auth/me")).json()) as { permissions: string[] };
    expect(me.permissions).toEqual([]);
    const [{ role }] = await t.db.system((tx) => tx.query<{ role: string }>("select role from users where email = 'pilot.ketto@example.test'"));
    expect(role).toBe("admin");
    for (const p of ["inspect", "preview", "commit"]) {
      const r = await W.upload(`/api/data/import/${p}`, csv([HEAD, ["Magánszemély", "Tiltott Tamás"]]), baseOptions(MAP, { jobId: "x", decisions: {} }));
      expect(r.status).toBe(403);
      expect(r.body.message).toBe("Ehhez a művelethez nincs jogosultságod.");
    }
    expect((await worker.get("/api/data/import/template")).status).toBe(403);
    expect((await worker.get("/api/data/import/jobs")).status).toBe(403);
    expect(await count("select count(*) as n from audit_events where action = 'data.denied'")).toBeGreaterThanOrEqual(5);
    expect(await count("select count(*) as n from import_jobs")).toBe(0);
    expect(await count("select count(*) as n from customers")).toBe(0);
  });

  it("P03/I01/V01/V09/V10/I10/D10: CSV import - javaslat, előnézet (mentés nélkül), jóváhagyás után tartós mentés „Feldolgozásra vár” státusszal, auditálva", async () => {
    const rows = [
      ["Magánszemély", "Import Ilona", "", "06 30 000 0001", "Ilona@Example.test", "", "Tőke elhelyezve"],
      ["Cég", "", "Import Kft.", "+36 1 000 0002", "info@import-kft.example.test", "Kapcsoló Kornélia", ""],
      ["Magánszemély", "", "", "", "hibas-email", "", ""],
      ["", "", "", "", "", "", ""],
      ["Magánszemély", "Elérhetetlen Elemér", "", "", "", "", ""],
    ];
    const ins = await A.upload("/api/data/import/inspect", csv([HEAD, ...rows]), { fileType: "csv" });
    expect(ins.status).toBe(200);
    expect(ins.body).toMatchObject({ headers: HEAD, suggestedMapping: MAP, rowCount: 4, delimiter: ";", importEnabled: true });
    const pv = await previewOf(rows);
    expect(pv.status).toBe(200);
    const body = pv.body as unknown as { jobId: string; summary: Record<string, number>; rows: { rowNo: number; state: string; issues: { code: string }[] }[]; commitAllowed: boolean };
    expect(body.summary).toMatchObject({ total: 4, valid: 1, warning: 2, error: 1, empty: 1, duplicate: 0, importByDefault: 1 });
    expect(body.rows.map((r) => [r.rowNo, r.state])).toEqual([[2, "W"], [3, "V"], [4, "E"], [5, "X"], [6, "W"]]);
    expect(body.rows[0].issues.map((i) => i.code)).toContain("status_not_applied");
    expect(body.commitAllowed).toBe(true);
    // V10: az előnézet nem hoz létre ügyfelet.
    expect(await count("select count(*) as n from customers")).toBe(0);
    const [job] = await t.db.system((tx) => tx.query<Record<string, unknown>>("select * from import_jobs where id = $1", [body.jobId]));
    expect(job).toMatchObject({ status: "previewed", file_type: "csv", source_name: "Fiktív teszt-adatbázis", row_states: "WVEXW", total_rows: 4 });
    expect(JSON.stringify(job)).not.toMatch(/Ilona|import-kft|Kornélia/);

    const cm = await commitOf(rows, body.jobId, { 2: "import" });
    expect(cm.status).toBe(200);
    expect(cm.body).toMatchObject({ replayed: false, created: 2, skipped: 2, outcomes: { created: 2, skipped_error: 1, skipped_empty: 1, skipped_user: 1 } });
    const snap = await snapshot();
    const ilona = snap.customers.find((c) => c.type === "individual" && c.displayName === "Import Ilona")!;
    expect(ilona).toMatchObject({ crmStatus: "waiting_for_contact", phone: "+36 30 000 0001", email: "ilona@example.test", source: "Fiktív teszt-adatbázis", ownerId: adminId });
    expect(ilona.restriction).toBeUndefined();
    const kft = snap.customers.find((c) => c.type === "company")!;
    expect(snap.contacts.filter((k) => k.companyId === kft.id).map((k) => [k.lastName, k.firstName, k.isPrimaryContact])).toEqual([["Kapcsoló", "Kornélia", true]]);
    expect(snap.customers.find((c) => c.type === "individual" && c.displayName === "Elérhetetlen Elemér")).toBeUndefined();
    expect(await count("select count(*) as n from audit_events where action = 'customer.create' and detail->>'via' = 'import' and detail->>'importId' = $1", [body.jobId])).toBe(2);
    expect(await count("select count(*) as n from audit_events where action = 'import.commit' and entity_id = $1", [body.jobId])).toBe(1);
    expect(await count("select count(*) as n from import_results where job_id = $1", [body.jobId])).toBe(5);
    const [done] = await t.db.system((tx) => tx.query<Record<string, unknown>>("select status, created_count, skipped_count, committed_by from import_jobs where id = $1", [body.jobId]));
    expect(done).toMatchObject({ status: "completed", created_count: 2, skipped_count: 2, committed_by: adminId });
  });

  it("I09/D11: a véglegesítés ismétlése (és párhuzamos dupla kérés) nem importál kétszer", async () => {
    const rows = [["Magánszemély", "Ismétlő Ida", "", "", "ida@example.test", "", ""]];
    const pv = await previewOf(rows);
    const jobId = String(pv.body.jobId);
    const [r1, r2] = await Promise.all([commitOf(rows, jobId), commitOf(rows, jobId)]);
    expect([r1.status, r2.status]).toEqual([200, 200]);
    expect([r1.body.replayed, r2.body.replayed].sort()).toEqual([false, true]);
    const r3 = await commitOf(rows, jobId);
    expect(r3.body).toMatchObject({ replayed: true, created: 1 });
    expect(await count("select count(*) as n from customers where email = 'ida@example.test'")).toBe(1);
  });

  it("D01-D08: fájlon belüli és meglévő ügyféllel való egyezés; kihagyás; explicit új rekord; nincs felülírás és nincs összevonás", async () => {
    const existing = (await admin.op<{ customer: { id: string } }>("customer.create", { input: { type: "individual", name: "Meglévő Márta", email: "marta@example.test", phone: "+36 20 000 0010" } })).body.result.value!.customer;
    const before = (await snapshot()).customers.find((c) => c.id === existing.id);
    const rows = [
      ["Magánszemély", "Másik Márta", "", "", "MARTA@example.test", "", ""],       // 2: erős (e-mail) a meglévővel
      ["Magánszemély", "Meglévő Márta", "", "", "", "", ""],                      // 3: lehetséges (név)
      ["Magánszemély", "Fájl Ferenc", "", "06 30 000 0011", "", "", ""],          // 4: új
      ["Magánszemély", "Fájl Ferenc Kettő", "", "+36 30 000 0011", "", "", ""],   // 5: erős fájlon belül (telefon) a 4. sorral
      ["Magánszemély", "Telefonos Tibor", "", "06-20-000-0010", "", "", ""],      // 6: erős (telefon) a meglévővel
    ];
    const pv = await previewOf(rows);
    const b = pv.body as unknown as { jobId: string; rows: { rowNo: number; state: string; matches: { customerId: string | null; level: string; reasons: string[] }[]; fileMatches: { rowNo: number; level: string }[] }[] };
    expect(b.rows.map((r) => r.state)).toEqual(["S", "P", "V", "S", "S"]);
    expect(b.rows[0].matches[0]).toMatchObject({ customerId: existing.id, level: "strong", reasons: ["Azonos e-mail-cím"] });
    expect(b.rows[1].matches[0]).toMatchObject({ customerId: existing.id, level: "possible" });
    expect(b.rows[3].fileMatches).toEqual([{ rowNo: 4, level: "strong" }]);
    expect(b.rows[4].matches[0]).toMatchObject({ customerId: existing.id, reasons: ["Azonos telefonszám"] });
    // D05: 2 kihagyva; D06: 3 kifejezetten új rekord; 5 és 6 döntés nélkül nem importálódik.
    const cm = await commitOf(rows, b.jobId, { 2: "skip", 3: "import" });
    expect(cm.body).toMatchObject({ created: 2, outcomes: { created: 2, skipped_user: 1, skipped_duplicate: 2 } });
    const after = await snapshot();
    // D07/D08: a meglévő ügyfél bájtra azonos, nincs összevonás (két „Meglévő Márta” rekord).
    expect(after.customers.find((c) => c.id === existing.id)).toEqual(before);
    expect(after.customers.filter((c) => c.type === "individual" && c.displayName === "Meglévő Márta")).toHaveLength(2);
  });

  it("D09/D12: párhuzamos import - a véglegesítés az aktuális adatbázist újraellenőrzi; a közben létrejött egyezés nem importálódik csendben", async () => {
    const rows = [["Magánszemély", "Párhuzamos Pál", "", "", "pal@example.test", "", ""]];
    const p1 = await previewOf(rows);
    const p2 = await previewOf(rows);
    expect([(p1.body.rows as { state: string }[])[0].state, (p2.body.rows as { state: string }[])[0].state]).toEqual(["V", "V"]);
    const [c1, c2] = await Promise.all([commitOf(rows, String(p1.body.jobId)), commitOf(rows, String(p2.body.jobId))]);
    const outcomes = [c1.body.outcomes, c2.body.outcomes].map((o) => Object.keys(o as object)[0]).sort();
    expect(outcomes).toEqual(["created", "skipped_changed"]);
    expect(await count("select count(*) as n from customers where email = 'pal@example.test'")).toBe(1);
    // Kifejezett „import” döntés sem elég, ha a sor besorolása az előnézet óta súlyosabb lett (V -> S).
    const p3 = await previewOf([["Magánszemély", "Párhuzamos Pál Kettő", "", "", "pal2@example.test", "", ""]]);
    await admin.op("customer.create", { input: { type: "individual", name: "Közbejött Kázmér", email: "pal2@example.test" } });
    const c3 = await commitOf([["Magánszemély", "Párhuzamos Pál Kettő", "", "", "pal2@example.test", "", ""]], String(p3.body.jobId), { 2: "import" });
    expect(c3.body.outcomes).toEqual({ skipped_changed: 1 });
  });

  it("megkeresési korlátozás / tiltakozás: erős egyezés nem importálható kifejezett döntéssel sem; eltávolított ügyfél adatai nem jelennek meg", async () => {
    const r = (await admin.op<{ customer: { id: string } }>("customer.create", { input: { type: "individual", name: "Tiltakozó Tódor", email: "todor@example.test" } })).body.result.value!.customer;
    await t.db.system((tx) => tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ($1, 'objection', 'fiktív tiltakozás', now(), $2)", [r.id, adminId]));
    const gone = (await admin.op<{ customer: { id: string } }>("customer.create", { input: { type: "individual", name: "Eltávolított Etelka", email: "etelka@example.test" } })).body.result.value!.customer;
    await t.db.system((tx) => tx.query("update customers set deleted_at = now(), deleted_by = $2 where id = $1", [gone.id, adminId]));
    const rows = [["Magánszemély", "Tódor Újra", "", "", "todor@example.test", "", ""], ["Magánszemély", "Etelka Újra", "", "", "etelka@example.test", "", ""]];
    const pv = await previewOf(rows);
    const b = pv.body as unknown as { jobId: string; rows: { state: string; issues: { code: string }[]; matches: { customerId: string | null; name: string; restricted: boolean }[] }[] };
    expect(b.rows[0]).toMatchObject({ state: "R", matches: [{ restricted: true }] });
    expect(b.rows[0].issues.map((i) => i.code)).toContain("restricted_match");
    expect(b.rows[1]).toMatchObject({ state: "S", matches: [{ customerId: null, name: "Eltávolított ügyfélrekord" }] });
    expect(JSON.stringify(b.rows[1])).not.toContain("Eltávolított Etelka");
    const cm = await commitOf(rows, b.jobId, { 2: "import", 3: "skip" });
    expect(cm.body.outcomes).toEqual({ skipped_restricted: 1, skipped_user: 1 });
    // A tiltakozás változatlan.
    expect(await count("select count(*) as n from customer_restrictions where customer_id = $1 and kind = 'objection'", [r.id])).toBe(1);
  });

  it("I02: XLSX import (valós táblázatkezelő kimenete) - képletes cella hibás sor, telefonszám számként is normalizált", async () => {
    const file = readFileSync(FIXTURE);
    const ins = await A.upload("/api/data/import/inspect", file, { fileType: "xlsx" });
    expect(ins.body).toMatchObject({ sheets: [{ name: "Ügyfelek" }, { name: "Másik lap" }, { name: "Rejtett", hidden: true }], sheetIndex: 0, rowCount: 5 });
    const mapping = ins.body.suggestedMapping as (string | null)[];
    expect(mapping).toEqual(["fullName", "phone", "email", "type", "companyName", "contactName", "notes"]);
    const pv = await A.upload("/api/data/import/preview", file, { ...baseOptions(mapping), fileType: "xlsx" });
    const b = pv.body as unknown as { jobId: string; rows: { rowNo: number; state: string; issues: { code: string }[]; display?: { phone?: string } }[] };
    expect(b.rows.map((r) => [r.rowNo, r.state])).toEqual([[2, "V"], [3, "V"], [4, "E"], [5, "V"], [6, "X"], [7, "V"]]);
    expect(b.rows[0].display?.phone).toBe("+36 30 000 0101");
    expect(b.rows[2].issues.map((i) => i.code)).toContain("formula_cell");
    const cm = await A.upload("/api/data/import/commit", file, { jobId: b.jobId, decisions: {} });
    expect(cm.body).toMatchObject({ created: 4, outcomes: { created: 4, skipped_error: 1, skipped_empty: 1 } });
    const snap = await snapshot();
    expect(snap.customers.find((c) => c.type === "individual" && c.displayName === "Ékezetes Őrs Űrhajós")).toMatchObject({ email: "ors@example.test", phone: "+36 20 000 0104", notes: "Több soros" });
    // Másik munkalap is választható.
    const other = await A.upload("/api/data/import/inspect", file, { fileType: "xlsx", sheetIndex: 1 });
    expect(other.body).toMatchObject({ headers: ["Cégnév", "Ügyféltípus"], rowCount: 1 });
  });

  it("I03-I06/I07: hibás, túl nagy, üres, nem támogatott fájl, hiányzó kötelező mező; érthető magyar hibaüzenettel, mentés nélkül", async () => {
    const before = await count("select count(*) as n from customers");
    expect((await A.upload("/api/data/import/inspect", "nem zip", { fileType: "xlsx" })).body.message).toMatch(/nem felel meg a kiterjesztésének/);
    expect((await A.upload("/api/data/import/inspect", Buffer.from("PK\x03\x04csonka"), { fileType: "xlsx" })).status).toBe(400);
    expect((await A.upload("/api/data/import/inspect", "", { fileType: "csv" })).body.message).toBe("A fájl üres.");
    expect((await A.upload("/api/data/import/inspect", "a;b", { fileType: "xlsm" })).body.message).toMatch(/Nem támogatott/);
    expect((await A.upload("/api/data/import/inspect", '"nincs lezárva;x\n', { fileType: "csv" })).body.message).toMatch(/lezáratlan idézőjel/);
    process.env.JG_IMPORT_MAX_FILE_BYTES = "2000";
    try {
      const big = await A.upload("/api/data/import/inspect", "x".repeat(5000), { fileType: "csv" });
      expect(big.status).toBe(413);
      expect(big.body.message).toBe("A fájl túl nagy.");
    } finally { delete process.env.JG_IMPORT_MAX_FILE_BYTES; }
    const noName = await previewOf([["Magánszemély", "", "", "", "a@example.test", "", ""]]);
    expect((noName.body.rows as { issues: { code: string }[] }[])[0].issues.map((i) => i.code)).toContain("missing_name");
    const badMap = await A.upload("/api/data/import/preview", csv([["E-mail"], ["a@example.test"]]), baseOptions(["email"]));
    expect(badMap.status).toBe(400);
    expect(badMap.body.message).toMatch(/névmezőt/);
    const noSource = await A.upload("/api/data/import/preview", csv([["Név"], ["X Y"]]), baseOptions(["fullName"], { defaultType: "individual", sourceName: " " }));
    expect(noSource.body.message).toBe("Az adatforrás megnevezése kötelező.");
    expect(await count("select count(*) as n from customers")).toBe(before);
  });

  it("compliance-kapu: nem ellenőrzött forrás / hiányzó nyilatkozat / kikapcsolt funkció mellett az előnézet elkészül, a véglegesítés tiltott", async () => {
    const rows = [["Magánszemély", "Kapu Kálmán", "", "", "kalman@example.test", "", ""]];
    const p1 = await previewOf(rows, { sourceVerification: "in_progress" });
    expect(p1.body).toMatchObject({ commitAllowed: false });
    expect((await commitOf(rows, String(p1.body.jobId))).status).toBe(403);
    const p2 = await previewOf(rows, { complianceDeclared: false });
    expect((await commitOf(rows, String(p2.body.jobId))).body.message).toMatch(/nyilatkozat/);
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "false";
    try {
      const p3 = await previewOf(rows);
      expect(p3.body.commitAllowed).toBe(false);
      const c3 = await commitOf(rows, String(p3.body.jobId));
      expect(c3.status).toBe(403);
      expect(c3.body.message).toMatch(/nincs engedélyezve/);
    } finally { process.env.JG_CUSTOMER_IMPORT_ENABLED = "true"; }
    expect(await count("select count(*) as n from customers where email = 'kalman@example.test'")).toBe(0);
  });

  it("eltérő fájl, lejárt előnézet, más felhasználó előnézete: véglegesítés elutasítva", async () => {
    const rows = [["Magánszemély", "Lejáró Lenke", "", "", "lenke@example.test", "", ""]];
    const pv = await previewOf(rows);
    const other = await commitOf([["Magánszemély", "Más Tartalom", "", "", "mas@example.test", "", ""]], String(pv.body.jobId));
    expect(other.status).toBe(409);
    expect(other.body.message).toMatch(/eltér az előnézetben/);
    now = new Date(T0.getTime() + 3 * 3600_000);
    try {
      expect((await commitOf(rows, String(pv.body.jobId))).status).toBe(409);
    } finally { now = T0; }
    await grant(t.db, "pilot.ketto@example.test", "crm.customer.import");
    try {
      const r = await W.upload("/api/data/import/commit", csv([HEAD, ...rows]), { jobId: pv.body.jobId, decisions: {} });
      expect(r.status).toBe(404);
    } finally { await revokePermission(t.db, { email: "pilot.ketto@example.test", permission: "crm.customer.import", operator: OPERATOR, env: "local" }); }
    expect(await count("select count(*) as n from customers where email = 'lenke@example.test'")).toBe(0);
  });

  it("CSRF: más eredetű, illetve nem multipart feltöltés elutasítva", async () => {
    const r = await A.upload("/api/data/import/inspect", "a;b\n1;2", { fileType: "csv" }, { origin: "https://tamado.example.test" });
    expect(r.status).toBe(403);
    expect((await admin.post("/api/data/import/inspect", { fileType: "csv" })).status).toBe(403);
  });

  it("importsablon: csak jogosultnak, fiktív példasorokkal; importnapló személyes adat nélkül", async () => {
    const res = await admin.get("/api/data/import/template");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toContain("JG_CRM_Import_Template.xlsx");
    expect(res.headers.get("cache-control")).toContain("no-store");
    const wb = new XlsxWorkbook(Buffer.from(await res.arrayBuffer()), { maxRows: 100, maxColumns: 50, maxCellChars: 5000, deadline: Date.now() + 10_000 });
    expect(wb.sheetInfo().map((s) => s.name)).toEqual(["Ügyfelek", "Útmutató"]);
    const sample = wb.read(0).rows;
    expect(sample.slice(1).flat().filter((v) => v.includes("@")).every((v) => v.endsWith("example.test"))).toBe(true);
    const jobs = (await (await admin.get("/api/data/import/jobs")).json()) as { jobs: Record<string, unknown>[] };
    expect(jobs.jobs.length).toBeGreaterThanOrEqual(5);
    expect(jobs.jobs[0]).toHaveProperty("fileSha256");
    expect(JSON.stringify(jobs)).not.toMatch(/@example\.test|Ilona|Márta|import\.bin/);
  });

  it("P06: jog visszavonása azonnal hat a meglévő munkamenetre is; P07: a napi CRM-funkciók a munkatársnál változatlanok", async () => {
    await grant(t.db, "pilot.ketto@example.test", "crm.customer.import");
    const ok = await W.upload("/api/data/import/inspect", csv([HEAD, ["Magánszemély", "X Y"]]), { fileType: "csv" });
    expect(ok.status).toBe(200);
    await revokePermission(t.db, { email: "pilot.ketto@example.test", permission: "crm.customer.import", operator: OPERATOR, env: "local" });
    expect((await W.upload("/api/data/import/inspect", csv([HEAD, ["Magánszemély", "X Y"]]), { fileType: "csv" })).status).toBe(403);
    const created = await worker.op<{ customer: { id: string } }>("customer.create", { input: { type: "individual", name: "Munkatárs Mária" } });
    expect(created.body.result.ok).toBe(true);
    expect((await worker.op("task.create", { input: { customerId: created.body.result.value!.customer.id, taskType: "phone_call" } })).body.result.ok).toBe(true);
    expect((await worker.get("/api/crm/snapshot")).status).toBe(200);
    const log = await t.db.system((tx) => tx.query<{ operation: string }>("select operation from ops_log where operation like 'permission.%' order by id"));
    expect(log.map((l) => l.operation)).toEqual(expect.arrayContaining(["permission.grant", "permission.revoke"]));
  });

  it("a teljes adatbázismentés/-visszaállítás HTTP-n nem érhető el", async () => {
    for (const p of ["/api/data/backup", "/api/backup", "/api/data/restore", "/api/admin/restore", "/api/data/export/backup"]) {
      const r = await admin.post(p, {});
      expect([404, 405]).toContain(r.status);
    }
  });

  it("kéréskorlát: óránként korlátozott számú előnézet felhasználónként", async () => {
    process.env.JG_IMPORT_PREVIEWS_PER_HOUR = "1";
    try {
      const r = await previewOf([["Magánszemély", "Korlát Károly"]].map((x) => [...x, "", "", "", "", ""]));
      expect(r.status).toBe(429);
      expect(r.body.message).toMatch(/Túl sok kérés/);
    } finally { delete process.env.JG_IMPORT_PREVIEWS_PER_HOUR; }
  });
});

describe.each(DRIVERS)("I08: több ezer soros import a konfigurált korláton belül (%s)", (kind) => {
  let t: TestDb;
  const prevFlag = process.env.JG_CUSTOMER_IMPORT_ENABLED;
  beforeAll(async () => {
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    t = await makeTestDb(kind);
    await addPilotUsers(t.db);
    await grant(t.db, "pilot.egy@example.test", "crm.customer.import");
  });
  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.JG_CUSTOMER_IMPORT_ENABLED; else process.env.JG_CUSTOMER_IMPORT_ENABLED = prevFlag;
    await t.cleanup();
  });

  it("5000 sor (a pilot-korlát) előnézete és mentése; 5001 sor elutasítva", async () => {
    const handle = makeApi(t.db);
    const c = client(handle);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    const U = uploader(handle, c);
    const rows = Array.from({ length: 5000 }, (_v, i) => i % 2
      ? ["Cég", "", `Tömeges ${i} Kft.`, `+36 1 ${String(1000000 + i).slice(1, 4)} ${String(i).padStart(4, "0")}`, `ceg${i}@example.test`, `Kapcsolat${i} Kata`, ""]
      : ["Magánszemély", `Tömeges${i} Tamás`, "", "", `szemely${i}@example.test`, "", ""]);
    const file = csv([HEAD, ...rows]);
    const started = Date.now();
    const pv = await U.upload("/api/data/import/preview", file, baseOptions(MAP));
    expect(pv.status).toBe(200);
    expect(pv.body.summary).toMatchObject({ total: 5000, valid: 5000, error: 0, duplicate: 0 });
    const cm = await U.upload("/api/data/import/commit", file, { jobId: pv.body.jobId, decisions: {} });
    expect(cm.status).toBe(200);
    expect(cm.body.created).toBe(5000);
    const elapsed = Date.now() - started;
    const [{ n }] = await t.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from customers"));
    expect(Number(n)).toBe(5000);
    const [{ k }] = await t.db.system((tx) => tx.query<{ k: string }>("select count(*) as k from company_contacts"));
    expect(Number(k)).toBe(2500);
    console.log(`[I08] 5000 sor előnézet + mentés: ${elapsed} ms (${kind})`);
    const tooMany = await U.upload("/api/data/import/inspect", csv([HEAD, ...rows, ["Magánszemély", "Egy Több", "", "", "", "", ""]]), { fileType: "csv" });
    expect(tooMany.status).toBe(400);
    expect(tooMany.body.message).toBe("A fájl túl sok adatsort tartalmaz.");
  }, 300_000);
});
