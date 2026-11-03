import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { describe, expect, it } from "vitest";
import { CsvError, decodeCsv, detectDelimiter, parseCsv, writeCsv } from "@/server/data/files/csv";
import { colIndex, colName, numberText, writeXlsx, XlsxError, XlsxWorkbook } from "@/server/data/files/xlsx";
import { decodeEntities, xmlEvents, XmlError } from "@/server/data/files/xml";
import { crc32, writeZip, ZipError, ZipReader } from "@/server/data/files/zip";
import { neutralizeCsv } from "@/server/data/export";
import { dataLimits } from "@/server/data/limits";
import { parseUpload, UploadError } from "@/server/data/upload";

/** v1.0 fájlkezelés (CRM-014 / CRM-017): ZIP, XML, XLSX, CSV - fiktív adattal, külső függőség nélkül. */
const L = { maxRows: 5000, maxColumns: 50, maxCellChars: 2000, deadline: Date.now() + 60_000 };
const FIXTURE = join(__dirname, "fixtures", "openpyxl-customers.xlsx");

/** Kézzel összeállított (Excel-szerű, megosztott szöveges) munkafüzet a ZIP-író felhasználásával. */
function excelLike(sheetXml: string, opts: { shared?: string; extra?: { name: string; data: string }[]; contentTypes?: string } = {}) {
  const ct = opts.contentTypes ?? `<?xml version="1.0"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/></Types>`;
  return writeZip([
    { name: "[Content_Types].xml", data: ct },
    { name: "xl/workbook.xml", data: `<workbook xmlns:r="r"><sheets><sheet name="Lap1" sheetId="1" r:id="rId1"/></sheets></workbook>` },
    { name: "xl/_rels/workbook.xml.rels", data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml" Type="ws"/></Relationships>` },
    { name: "xl/worksheets/sheet1.xml", data: sheetXml },
    ...(opts.shared ? [{ name: "xl/sharedStrings.xml", data: opts.shared }] : []),
    ...(opts.extra ?? []),
  ]);
}

describe("ZIP", () => {
  it("író és olvasó kör: tartalom és CRC egyezik", () => {
    const z = writeZip([{ name: "a.txt", data: "árvíztűrő tükörfúrógép" }, { name: "b/c.xml", data: "<x/>" }]);
    const r = new ZipReader(z);
    expect(r.text("a.txt")).toBe("árvíztűrő tükörfúrógép");
    expect(r.text("b/c.xml")).toBe("<x/>");
    expect(crc32(Buffer.from("123456789"))).toBe(0xcbf43926);
  });
  it("nem ZIP / csonka fájl elutasítva", () => {
    expect(() => new ZipReader(Buffer.from("nem zip tartalom, csak szöveg"))).toThrow(ZipError);
    const z = writeZip([{ name: "a.txt", data: "x".repeat(1000) }]);
    expect(() => new ZipReader(z.subarray(0, z.length - 10))).toThrow(ZipError);
  });
  it("zip-bomba: a deklarált méret a korlát felett -> kibontás előtt elutasítva", () => {
    const z = writeZip([{ name: "big.xml", data: "0".repeat(1000) }]);
    const r = new ZipReader(z, { maxEntries: 10, maxEntryBytes: 500, maxTotalBytes: 1000 });
    expect(() => r.read("big.xml")).toThrow("too_large");
  });
  it("zip-bomba: hamis (kicsi) deklarált méret, valójában óriási tartalom -> a kibontás a korlátnál megszakad", () => {
    // 20 MB nulla ~20 KB-ra tömörítve, a fejlécben 100 bájtnak deklarálva.
    const z = writeZip([{ name: "bomb.xml", data: Buffer.alloc(20 * 1024 * 1024) }]);
    const cdOffset = z.readUInt32LE(z.length - 22 + 16);
    z.writeUInt32LE(100, cdOffset + 24);
    const r = new ZipReader(z);
    expect(() => r.read("bomb.xml")).toThrow(ZipError);
  });
  it("titkosított és túl sok bejegyzéses archívum elutasítva", () => {
    const z = writeZip([{ name: "a", data: "x" }]);
    const cd = z.readUInt32LE(z.length - 22 + 16);
    const enc = Buffer.from(z);
    enc.writeUInt16LE(enc.readUInt16LE(cd + 8) | 1, cd + 8);
    expect(() => new ZipReader(enc)).toThrow("encrypted");
    const many = writeZip(Array.from({ length: 20 }, (_v, i) => ({ name: `f${i}`, data: "x" })));
    expect(() => new ZipReader(many, { maxEntries: 10, maxEntryBytes: 1e6, maxTotalBytes: 1e6 })).toThrow("too_many_entries");
  });
  it("hibás CRC -> sérült", () => {
    const data = Buffer.from("hello world hello world");
    const z = writeZip([{ name: "a", data }]);
    const cd = z.readUInt32LE(z.length - 22 + 16);
    z.writeUInt32LE(12345, cd + 16);
    expect(() => new ZipReader(z).read("a")).toThrow("corrupt");
    expect(deflateRawSync(data).length).toBeGreaterThan(0);
  });
});

describe("XML", () => {
  it("entitások: csak az előre definiáltak és a numerikus hivatkozások", () => {
    expect(decodeEntities("a &amp; b &lt; &#233;&#x151;")).toBe("a & b < éő");
    expect(() => decodeEntities("&foo;")).toThrow(XmlError);
    expect(() => decodeEntities("a & b")).toThrow(XmlError);
  });
  it("DOCTYPE / ENTITY (XXE) elutasítva", () => {
    expect(() => [...xmlEvents(`<?xml version="1.0"?><!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>`)]).toThrow("doctype");
  });
  it("névtér-előtag levágva, attribútumok olvasva", () => {
    const ev = [...xmlEvents(`<x:c r="A1" t="s"><x:v>3</x:v></x:c>`)];
    expect(ev[0]).toMatchObject({ kind: "open", name: "c", attrs: { r: "A1", t: "s" } });
  });
});

describe("XLSX olvasás", () => {
  it("valós táblázatkezelő (openpyxl) kimenete: munkalapok, ékezetek, szám telefonszámként, képlet jelölve, üres sor", () => {
    const wb = new XlsxWorkbook(readFileSync(FIXTURE), L);
    expect(wb.sheetInfo()).toEqual([{ name: "Ügyfelek", hidden: false }, { name: "Másik lap", hidden: false }, { name: "Rejtett", hidden: true }]);
    const { rows, flags } = wb.read(0);
    expect(rows[0]).toEqual(["Név", "Telefon", "E-mail", "Ügyféltípus", "Cégnév", "Kapcsolattartó", "Megjegyzés"]);
    expect(rows[1][1]).toBe("36300000101");
    expect(rows[2].slice(0, 6)).toEqual(["", "06 1 000 0102", "info@fiktiv-bt.example.test", "Cég", "Fiktív Bt.", "Kapcsoló Klára"]);
    expect(flags.formula.has("3:1")).toBe(true);
    expect(rows[3][1]).toBe("");
    expect(rows[4][0]).toBe("Ékezetes Őrs Űrhajós");
    expect(rows[4][6]).toBe("Több\nsoros");
    expect(rows[5]).toEqual([]);
    expect(rows[6][0]).toBe("Üres sor utáni Üzenet");
    expect(wb.read(1).rows[1]).toEqual(["Második Lap Kft.", "Cég"]);
  });
  it("Excel-szerű megosztott szövegek (rich text, fonetikus futam nélkül), boolean, hibaérték", () => {
    const shared = `<sst><si><t>Név</t></si><si><r><t>Rich </t></r><r><t>Text</t></r><rPh><t>XX</t></rPh></si></sst>`;
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2" t="b"><v>1</v></c><c r="B2" t="e"><v>#N/A</v></c><c r="C2"><v>1.5E+10</v></c></row></sheetData></worksheet>`;
    const wb = new XlsxWorkbook(excelLike(sheet, { shared }), L);
    const { rows, flags } = wb.read(0);
    expect(rows[0]).toEqual(["Név", "Rich Text"]);
    expect(rows[1][0]).toBe("IGAZ");
    expect(flags.error.has("1:1")).toBe(true);
    expect(rows[1][2]).toBe("15000000000");
  });
  it("makrós (xlsm), külső hivatkozás, beágyazott objektum, nem munkafüzet: elutasítva", () => {
    const sheet = `<worksheet><sheetData/></worksheet>`;
    expect(() => new XlsxWorkbook(excelLike(sheet, { extra: [{ name: "xl/vbaProject.bin", data: "x" }] }), L)).toThrow(XlsxError);
    const macroCt = `<Types><Override PartName="/xl/workbook.xml" ContentType="application/vnd.ms-excel.sheet.macroEnabled.main+xml"/></Types>`;
    expect(() => new XlsxWorkbook(excelLike(sheet, { contentTypes: macroCt }), L)).toThrow("macro");
    expect(() => new XlsxWorkbook(excelLike(sheet, { extra: [{ name: "xl/externalLinks/externalLink1.xml", data: "<x/>" }] }), L)).toThrow("external");
    expect(() => new XlsxWorkbook(excelLike(sheet, { extra: [{ name: "xl/embeddings/oleObject1.bin", data: "x" }] }), L)).toThrow("external");
    expect(() => new XlsxWorkbook(writeZip([{ name: "a.txt", data: "x" }]), L)).toThrow("not_xlsx");
  });
  it("sor-, oszlop- és cellahossz-korlát", () => {
    const rows = Array.from({ length: 12 }, (_v, i) => `<row r="${i + 1}"><c r="A${i + 1}" t="inlineStr"><is><t>s${i}</t></is></c></row>`).join("");
    expect(() => new XlsxWorkbook(excelLike(`<worksheet><sheetData>${rows}</sheetData></worksheet>`), { ...L, maxRows: 10 }).read(0)).toThrow("too_many_rows");
    const wide = `<worksheet><sheetData><row r="1"><c r="AZ1" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`;
    expect(() => new XlsxWorkbook(excelLike(wide), L).read(0)).toThrow("too_many_columns");
    const long = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>${"x".repeat(3000)}</t></is></c></row></sheetData></worksheet>`;
    expect(() => new XlsxWorkbook(excelLike(long), L).read(0)).toThrow("cell_too_long");
  });
  it("oszlophivatkozás és szám-szöveg", () => {
    expect([colIndex("A1"), colIndex("Z9"), colIndex("AA3"), colIndex("AZ1")]).toEqual([0, 25, 26, 51]);
    expect([colName(0), colName(25), colName(26), colName(51)]).toEqual(["A", "Z", "AA", "AZ"]);
    expect(numberText("36301234567")).toBe("36301234567");
    expect(numberText("12.0")).toBe("12");
  });
});

describe("F3: fizikai sorkorlát a parserekben", () => {
  it("CSV: az üres sorok nem materializálódnak a következő tartalmas sorig; a kereten túli tartalmas sor hiba", () => {
    const { rows } = parseCsv("Fej\n\n\nAdat\n\n\n\n", { ...L, maxPhysicalRows: 4 });
    expect(rows).toEqual([["Fej"], [], [], ["Adat"]]);
    expect(() => parseCsv("Fej\n\n\n\nAdat\n", { ...L, maxPhysicalRows: 4 })).toThrow("too_many_physical_rows");
    expect(() => parseCsv("Fej\n" + "\n".repeat(100_000), { ...L, maxPhysicalRows: 4 })).not.toThrow();
  });
  it("XLSX: cella nélküli (formázott) sor nem foglal helyet; a képletet tartalmazó sor tartalmasnak számít; a ritkás sor a kereten túl hiba", () => {
    const sheet = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Fej</t></is></c></row><row r="3"><c r="A3"><f>1+1</f><v>2</v></c></row><row r="900000" ht="15"/></sheetData></worksheet>`;
    const { rows, flags } = new XlsxWorkbook(excelLike(sheet), { ...L, maxPhysicalRows: 3 }).read(0);
    expect(rows).toEqual([["Fej"], [], [""]]);
    expect(flags.formula.has("2:0")).toBe(true);
    const far = `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Fej</t></is></c></row><row r="5"><c r="A5" t="inlineStr"><is><t>x</t></is></c></row></sheetData></worksheet>`;
    expect(() => new XlsxWorkbook(excelLike(far), { ...L, maxPhysicalRows: 4 }).read(0)).toThrow("too_many_physical_rows");
  });
});

describe("XLSX írás", () => {
  it("csak szöveges cellák, képlet nincs; visszaolvasva az érték változatlan (a képletszerű szöveg is)", () => {
    const tricky = ["=HYPERLINK(\"http://x\")", "+36 30 000 0000", "-5", "@SUM(A1)", "a & <b> \"c\"", "Több\nsoros"];
    const buf = writeXlsx([{ name: "Teszt/lap?", rows: [["Fejléc"], ...tricky.map((t) => [t])], boldHeader: true }]);
    const zip = new ZipReader(buf);
    const xml = zip.text("xl/worksheets/sheet1.xml") as string;
    expect(xml).not.toContain("<f>");
    expect(xml).toContain('t="inlineStr"');
    const wb = new XlsxWorkbook(buf, L);
    expect(wb.sheetInfo()[0].name).toBe("Teszt lap ");
    expect(wb.read(0).rows.slice(1).map((r) => r[0])).toEqual(tricky);
    expect(wb.read(0).flags.formula.size).toBe(0);
  });
});

describe("CSV", () => {
  it("elválasztó-felismerés és RFC 4180 idézőjelezés, mezőn belüli sortörés", () => {
    expect(detectDelimiter("a;b;c\n1;2;3")).toBe(";");
    expect(detectDelimiter('a,"b;c",d\n')).toBe(",");
    expect(detectDelimiter("a\tb\n")).toBe("\t");
    const { rows } = parseCsv('Név;Megjegyzés\r\n"Teszt, Elek";"Első ""idézet""\nmásodik sor"\r\n\r\n', L);
    expect(rows).toEqual([["Név", "Megjegyzés"], ["Teszt, Elek", 'Első "idézet"\nmásodik sor']]);
  });
  it("lezáratlan idézőjel, túl sok sor/oszlop, túl hosszú cella: hiba", () => {
    expect(() => parseCsv('a;b\n"nincs vége;x\n', L)).toThrow(CsvError);
    expect(() => parseCsv(Array.from({ length: 13 }, () => "x").join("\n"), { ...L, maxRows: 10 })).toThrow("too_many_rows");
    expect(() => parseCsv(Array.from({ length: 60 }, () => "x").join(";"), L)).toThrow("too_many_columns");
    expect(() => parseCsv(`a\n${"x".repeat(2500)}`, L)).toThrow("cell_too_long");
  });
  it("kódolás: UTF-8 (BOM-mal is), Windows-1250 csak kifejezetten; hibás UTF-8 és bináris elutasítva", () => {
    const text = "Név;Város\nŐrs Ádám;Győr\n";
    expect(decodeCsv(Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(text)]), "utf-8")).toBe(text);
    const cp1250 = Buffer.from([0x4e, 0xe9, 0x76, 0x3b, 0xd5, 0x72, 0x73]); // "Név;Őrs" Windows-1250-ben
    expect(() => decodeCsv(cp1250, "utf-8")).toThrow("bad_encoding");
    expect(decodeCsv(cp1250, "windows-1250")).toBe("Név;Őrs");
    expect(() => decodeCsv(Buffer.from([0x61, 0x00, 0x62]), "utf-8")).toThrow("binary");
  });
  it("írás: BOM, pontosvessző, CRLF, idézőjelezés", () => {
    const b = writeCsv([["a", "b;c"], ['d"e', "f\ng"]]);
    expect([...b.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(b.subarray(3).toString("utf8")).toBe('a;"b;c"\r\n"d""e";"f\ng"\r\n');
  });
  it("E09: képletinjekció elleni semlegesítés a veszélyes kezdőkarakterekre", () => {
    for (const v of ["=1+1", "+36 30", "-2", "@SUM(A1)", "\tx", "\rx", "\nx", "＝1"]) expect(neutralizeCsv(v)).toBe(`'${v}`);
    for (const v of ["Teszt Elek", "36 30", "a=b", "", "info@example.test"]) expect(neutralizeCsv(v)).toBe(v);
  });
});

describe("feltöltés értelmezése", () => {
  const limits = dataLimits({});
  it("I03/I06: a kiterjesztés és a tartalom egyezése kötelező; ismeretlen formátum elutasítva", () => {
    expect(() => parseUpload(Buffer.from("a;b\n1;2"), "xlsx", {}, limits)).toThrow(UploadError);
    expect(() => parseUpload(readFileSync(FIXTURE), "csv", {}, limits)).toThrow(/kiterjesztésének/);
    expect(() => parseUpload(Buffer.from("x"), "xlsm", {}, limits)).toThrow(/Nem támogatott/);
    expect(() => parseUpload(Buffer.from("x"), "pdf", {}, limits)).toThrow(/Nem támogatott/);
  });
  it("I04/I05: túl nagy és üres fájl", () => {
    expect(() => parseUpload(Buffer.alloc(0), "csv", {}, limits)).toThrow(/üres/);
    expect(() => parseUpload(Buffer.alloc(2000, 0x61), "csv", {}, { ...limits, maxFileBytes: 1000 })).toThrow(/túl nagy/);
    expect(() => parseUpload(Buffer.from("\n\n;;\n"), "csv", {}, limits)).toThrow(/fejléc/);
  });
  it("a sorszám a táblázat sorszáma (fejléc = 1); a képletes cella a sorszámmal jelölt", () => {
    const u = parseUpload(readFileSync(FIXTURE), "xlsx", {}, limits);
    expect(u.headerRowNo).toBe(1);
    expect(u.rows.map((r) => r.rowNo)).toEqual([2, 3, 4, 5, 6, 7]);
    expect(u.formulaCells.has("4:1")).toBe(true);
    expect(u.sha256).toMatch(/^[0-9a-f]{64}$/);
  });
  it("az alapértelmezett limitek konzervatívak és felülről korlátosak", () => {
    expect(limits.maxFileBytes).toBe(4_000_000);
    expect(limits.maxRows).toBe(5000);
    expect(dataLimits({ JG_IMPORT_MAX_FILE_BYTES: "999999999", JG_IMPORT_MAX_ROWS: "abc" })).toMatchObject({ maxFileBytes: 10_000_000, maxRows: 5000 });
  });
});
