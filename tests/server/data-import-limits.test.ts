import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { ImportError, preview } from "@/server/data/import";
import { writeXlsx } from "@/server/data/files/xlsx";
import { writeZip } from "@/server/data/files/zip";
import { dataLimits } from "@/server/data/limits";
import { DRIVERS, PASSWORD_A, addPilotUsers, client, makeApi, makeTestDb, type TestDb } from "./helpers";
import { baseOptions, grant, uploader, type Uploader } from "./data-helpers";

/**
 * F3 (review): üres és ritkás sorokkal nem kerülhető meg az import erőforráskorlátja. A strukturális (fizikai) sorszám, az üres köztes
 * sorok száma és a kiértékelés ideje is korlátos; az üres sorok nem kerülnek az előnézeti válaszba és az import_results táblába; az
 * eredeti sorszámok megmaradnak. Kizárólag fiktív adat, eldobható adatbázis.
 */
const ENV_KEYS = ["JG_IMPORT_MAX_ROWS", "JG_IMPORT_MAX_EMPTY_ROWS", "JG_CUSTOMER_IMPORT_ENABLED"] as const;

/** Ritkás munkalap: a megadott (1-alapú) sorszámokon egy-egy cellasor. */
function sparseXlsx(rows: Record<number, string[]>): Buffer {
  const cells = (r: number, vals: string[]) => vals.map((v, i) => `<c r="${String.fromCharCode(65 + i)}${r}" t="inlineStr"><is><t>${v}</t></is></c>`).join("");
  const sheet = `<worksheet><sheetData>${Object.entries(rows).map(([r, v]) => `<row r="${r}">${cells(Number(r), v)}</row>`).join("")}</sheetData></worksheet>`;
  return writeZip([
    { name: "[Content_Types].xml", data: `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    { name: "xl/workbook.xml", data: `<workbook xmlns:r="r"><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="ws"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}

describe.each(DRIVERS)("import strukturális korlátjai (%s)", (kind) => {
  let t: TestDb;
  let U: Uploader;
  const saved: Record<string, string | undefined> = {};
  const count = async (sql: string, p: unknown[] = []) => Number((await t.db.system((tx) => tx.query<{ n: string }>(sql, p)))[0].n);
  const MAP = ["fullName", "email"];
  const opts = (extra: Record<string, unknown> = {}) => baseOptions(MAP, { defaultType: "individual", ...extra });

  beforeAll(async () => {
    for (const k of ENV_KEYS) saved[k] = process.env[k];
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    t = await makeTestDb(kind);
    await addPilotUsers(t.db);
    await grant(t.db, "pilot.egy@example.test", "crm.customer.import");
    const handle = makeApi(t.db);
    const c = client(handle);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    U = uploader(handle, c);
  });
  afterEach(() => {
    for (const k of ENV_KEYS) if (k !== "JG_CUSTOMER_IMPORT_ENABLED") { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
  });
  afterAll(async () => {
    for (const k of ENV_KEYS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k]; }
    await t.cleanup();
  });

  it("a review CSV-esete (maxRows=1): fejléc + 70 000 üres sor + 1 adatsor -> elutasítva, kis hibaválasszal, import nélkül", async () => {
    process.env.JG_IMPORT_MAX_ROWS = "1";
    const file = "Név;E-mail\n" + "\n".repeat(70_000) + "Fiktív Fanni;fanni@example.test\n";
    for (const p of ["inspect", "preview"] as const) {
      const r = await U.upload(`/api/data/import/${p}`, file, p === "inspect" ? { fileType: "csv" } : opts());
      expect(r.status, p).toBe(400);
      expect(r.body.message).toMatch(/üres sorokkal együtt túl sok sort/);
      expect(JSON.stringify(r.body).length).toBeLessThan(1000);
      expect(JSON.stringify(r.body)).not.toMatch(/Fanni|example\.test/);
    }
    expect(await count("select count(*) as n from import_jobs")).toBe(0);
  });

  it("a review XLSX-esete (maxRows=1): fejléc az 1., egyetlen adat a 100 001. sorban -> elutasítva", async () => {
    process.env.JG_IMPORT_MAX_ROWS = "1";
    const file = sparseXlsx({ 1: ["Név", "E-mail"], 100_001: ["Ritkás Rita", "rita@example.test"] });
    expect(file.length).toBeLessThan(4000);
    for (const p of ["inspect", "preview"] as const) {
      const r = await U.upload(`/api/data/import/${p}`, file, p === "inspect" ? { fileType: "xlsx" } : { ...opts(), fileType: "xlsx" });
      expect(r.status, p).toBe(400);
      expect(r.body.message).toMatch(/üres sorokkal együtt túl sok sort/);
    }
    expect(await count("select count(*) as n from import_jobs")).toBe(0);
  });

  it("határérték (maxRows=2, maxEmptyRows=3): pontosan a kereten belül elfogadva, eggyel fölötte elutasítva - CSV és XLSX", async () => {
    process.env.JG_IMPORT_MAX_ROWS = "2";
    process.env.JG_IMPORT_MAX_EMPTY_ROWS = "3";
    const csvOf = (empties: number) => `Név;E-mail\nElső Edit;edit@example.test\n${"\n".repeat(empties)}Második Márk;mark@example.test\n`;
    const ok = await U.upload("/api/data/import/inspect", csvOf(3), { fileType: "csv" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ rowCount: 2, emptyRows: 3 });
    const over = await U.upload("/api/data/import/inspect", csvOf(4), { fileType: "csv" });
    expect(over.status).toBe(400);
    expect(over.body.message).toMatch(/túl sok/);
    const xOk = await U.upload("/api/data/import/inspect", sparseXlsx({ 1: ["Név", "E-mail"], 2: ["Első Edit", "e@example.test"], 6: ["Második Márk", "m@example.test"] }), { fileType: "xlsx" });
    expect(xOk.status).toBe(200);
    expect(xOk.body).toMatchObject({ rowCount: 2, emptyRows: 3 });
    const xOver = await U.upload("/api/data/import/inspect", sparseXlsx({ 1: ["Név", "E-mail"], 2: ["Első Edit", "e@example.test"], 7: ["Második Márk", "m@example.test"] }), { fileType: "xlsx" });
    expect(xOver.status).toBe(400);
    // Csak formázott (cella nélküli) üres sorok a lap végén nem számítanak és nem foglalnak helyet.
    const trailing = await U.upload("/api/data/import/inspect", writeZipWithTrailingRows(), { fileType: "xlsx" });
    expect(trailing.status).toBe(200);
    expect(trailing.body).toMatchObject({ rowCount: 1, emptyRows: 0 });
  });

  it("rövid üres szakaszok: eredeti sorszámok; inspect / preview / commit következetes; üres sor nem kerül az import_results-ba", async () => {
    const file = "\n\nNév;E-mail\nAlfa Anna;anna@example.test\n\n;\nBéta Béla;bela@example.test\n\nGamma Gizi;gizi@example.test\n\n\n";
    const ins = await U.upload("/api/data/import/inspect", file, { fileType: "csv" });
    expect(ins.body).toMatchObject({ rowCount: 3, emptyRows: 3, headers: ["Név", "E-mail"] });
    const pv = await U.upload("/api/data/import/preview", file, opts());
    const b = pv.body as unknown as { jobId: string; summary: { total: number; empty: number }; rows: { rowNo: number; state: string }[] };
    expect(b.summary).toMatchObject({ total: 3, empty: 3 });
    expect(b.rows.map((r) => [r.rowNo, r.state])).toEqual([[4, "V"], [7, "V"], [9, "V"]]);
    const cm = await U.upload("/api/data/import/commit", file, { jobId: b.jobId, decisions: { 7: "skip" } });
    expect(cm.status).toBe(200);
    expect(cm.body).toMatchObject({ created: 2, skipped: 1, empty: 3, outcomes: { created: 2, skipped_user: 1 } });
    const res = await t.db.system((tx) => tx.query<{ row_no: number; outcome: string }>("select row_no, outcome from import_results where job_id = $1 order by row_no", [b.jobId]));
    expect(res.map((r) => [Number(r.row_no), r.outcome])).toEqual([[4, "created"], [7, "skipped_user"], [9, "created"]]);
    const [job] = await t.db.system((tx) => tx.query<{ empty_rows: number; row_states: string }>("select empty_rows, row_states from import_jobs where id = $1", [b.jobId]));
    expect(job).toMatchObject({ empty_rows: 3, row_states: "VXXVXV" });
    const again = await U.upload("/api/data/import/commit", file, { jobId: b.jobId, decisions: {} });
    expect(again.body).toMatchObject({ replayed: true, created: 2, empty: 3 });
  });

  it("elutasított véglegesítés (a keret közben szigorodott): nincs részleges ügyfélimport, az előnézet újrapróbálható marad", async () => {
    process.env.JG_IMPORT_MAX_EMPTY_ROWS = "5";
    const file = "Név;E-mail\nKeret Klára;klara@example.test\n\n\n\n\nKeret Kálmán;kalman@example.test\n";
    const pv = await U.upload("/api/data/import/preview", file, opts());
    expect(pv.status).toBe(200);
    process.env.JG_IMPORT_MAX_EMPTY_ROWS = "2";
    const cm = await U.upload("/api/data/import/commit", file, { jobId: pv.body.jobId, decisions: {} });
    expect(cm.status).toBe(400);
    expect(await count("select count(*) as n from customers where email in ('klara@example.test', 'kalman@example.test')")).toBe(0);
    expect(await count("select count(*) as n from import_results where job_id = $1", [pv.body.jobId])).toBe(0);
    const [job] = await t.db.system((tx) => tx.query<{ status: string }>("select status from import_jobs where id = $1", [pv.body.jobId]));
    expect(job.status).toBe("previewed");
  });

  it("a kiértékelés (validáció + duplikáció) teljes munkájának is van időkerete: túllépésnél hiba, import_jobs nélkül", async () => {
    const file = writeXlsx([{ name: "Lap", rows: [["Név", "E-mail"], ["Idő Ida", "ida@example.test"]] }]);
    const user = { id: (await t.db.system((tx) => tx.query<{ id: string }>("select id from users where email = 'pilot.egy@example.test'")))[0].id, name: "x", email: "pilot.egy@example.test" };
    const before = await count("select count(*) as n from import_jobs");
    await expect(t.db.asUser(user.id, (tx) => preview(tx, user, file, { ...opts(), fileType: "xlsx" }, { ...dataLimits({}), maxSeconds: -1 }, true, new Date())))
      .rejects.toSatisfy((e: unknown) => e instanceof ImportError && e.code === "timeout");
    expect(await count("select count(*) as n from import_jobs")).toBe(before);
  });
});

/** Munkalap egy adatsorral és sok, cella nélküli (csak formázott) sorral a végén - ilyen az Excel gyakori kimenete. */
function writeZipWithTrailingRows(): Buffer {
  const tail = Array.from({ length: 200 }, (_v, i) => `<row r="${i + 3}" ht="15" customHeight="1"/>`).join("") + `<row r="1048576" ht="15" customHeight="1"/>`;
  const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Név</t></is></c><c r="B1" t="inlineStr"><is><t>E-mail</t></is></c></row><row r="2"><c r="A2" t="inlineStr"><is><t>Formázott Feri</t></is></c></row>${tail}</sheetData></worksheet>`;
  return writeZip([
    { name: "[Content_Types].xml", data: `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>` },
    { name: "xl/workbook.xml", data: `<workbook xmlns:r="r"><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="ws"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: sheet },
  ]);
}
