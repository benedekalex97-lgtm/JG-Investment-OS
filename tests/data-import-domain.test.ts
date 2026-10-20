import { describe, expect, it } from "vitest";
import { evaluateRow, mappingProblems, normalizePhone, parseCustomerType, suggestMapping, type ColumnMapping } from "@/domain/data-import";
import { TEMPLATE_HEADERS } from "@/server/data/template";

/** CRM-015: oszlopfelismerés, megfeleltetés, normalizálás és soronkénti validáció (tisztán tartományi, fiktív adat). */
describe("V01: automatikus oszlopjavaslat", () => {
  it("magyar és angol oszlopnevek pontos felismerése", () => {
    expect(suggestMapping(["Név", "Telefonszám", "E-mail-cím", "Ügyféltípus", "Cégnév", "Kapcsolattartó neve", "Adatforrás"]))
      .toEqual(["fullName", "phone", "email", "type", "companyName", "contactName", "source"]);
    expect(suggestMapping(["Name", "Phone", "Email", "Company", "Mobile"])).toEqual(["fullName", "phone", "email", "companyName", null]);
    expect(suggestMapping(["Ügyfél neve", "Telefon", "E-mail", "Teljes név"])).toEqual(["fullName", "phone", "email", null]);
  });
  it("bizonytalan oszlopot nem javasol (csak pontos egyezés), ütköző név-mezőt nem párosít", () => {
    expect(suggestMapping(["Ügyfél neve és címe", "Telefonszám 2", "Valami"])).toEqual([null, null, null]);
    expect(suggestMapping(["Vezetéknév", "Keresztnév", "Név"])).toEqual(["lastName", "firstName", null]);
  });
  it("a letölthető sablon minden oszlopát felismeri", () => {
    expect(suggestMapping(TEMPLATE_HEADERS).every((m) => m !== null)).toBe(true);
  });
});

describe("V02: megfeleltetés szerkezeti ellenőrzése", () => {
  it("duplikált mező, név-ütközés, hiányzó név, hiányzó típus", () => {
    expect(mappingProblems(["email", "email"], "individual").map((p) => p.code)).toContain("duplicate_field");
    expect(mappingProblems(["fullName", "lastName"], "individual").map((p) => p.code)).toContain("name_conflict");
    expect(mappingProblems(["email"], "individual").map((p) => p.code)).toContain("no_name");
    expect(mappingProblems(["fullName"], null).map((p) => p.code)).toContain("no_type");
    expect(mappingProblems(["fullName", null, "type"], null)).toEqual([]);
  });
});

describe("V04: telefonszám-normalizálás", () => {
  it.each([
    ["+36 30 123 4567", "+36 30 123 4567"], ["06301234567", "+36 30 123 4567"], ["06-30/123-4567", "+36 30 123 4567"],
    ["0036 30 123 4567", "+36 30 123 4567"], ["36301234567", "+36 30 123 4567"], ["(06 1) 234 5678", "+36 1 234 5678"], ["+36.20.000.0001", "+36 20 000 0001"],
  ])("%s -> %s", (raw, want) => {
    expect(normalizePhone(raw)).toEqual({ ok: true, value: want });
  });
  it("külföldi / előhívó nélküli szám: megtisztítva, figyelmeztetéssel; érvénytelen: hiba", () => {
    expect(normalizePhone("+44 20 7946 0958")).toEqual({ ok: true, value: "+44 20 7946 0958", warning: "unusual_format" });
    expect(normalizePhone("301234567")).toMatchObject({ ok: true, warning: "unusual_format" });
    expect(normalizePhone("hívj fel")).toEqual({ ok: false });
    expect(normalizePhone("12")).toEqual({ ok: false });
  });
});

const M: ColumnMapping = ["type", "fullName", "companyName", "phone", "email", "contactName", "contactPhone", "notes", "status"];
const row = (o: Partial<Record<"type" | "name" | "company" | "phone" | "email" | "contact" | "contactPhone" | "notes" | "status", string>>) =>
  [o.type ?? "", o.name ?? "", o.company ?? "", o.phone ?? "", o.email ?? "", o.contact ?? "", o.contactPhone ?? "", o.notes ?? "", o.status ?? ""];
const codes = (cells: string[], defaultType: "individual" | "company" | null = null) => evaluateRow(cells, M, defaultType).issues.map((i) => i.code);

describe("V03-V07: soronkénti validáció", () => {
  it("érvényes magánszemély és cég: normalizált tervezet", () => {
    const a = evaluateRow(row({ type: "Magánszemély", name: "Teszt  Elek", phone: "06301234567", email: " TESZT@Example.TEST " }), M, null);
    expect(a.status).toBe("valid");
    expect(a.draft).toEqual({ type: "individual", name: "Teszt Elek", phone: "+36 30 123 4567", email: "teszt@example.test" });
    const b = evaluateRow(row({ type: "cég", company: "Fiktív Kft.", contact: "Kapcsoló Klára", contactPhone: "+36 1 000 0000" }), M, null);
    expect(b.status).toBe("valid");
    expect(b.draft).toMatchObject({ type: "company", companyName: "Fiktív Kft.", contactName: "Kapcsoló Klára", contactPhone: "+36 1 000 0000" });
  });
  it("V03: hibás e-mail; V05: hiányzó név; V06: hiányzó cégnév; V07: magánszemély/cég eltérés", () => {
    expect(codes(row({ type: "Magánszemély", name: "X Y", email: "nem-email" }))).toContain("invalid_email");
    expect(codes(row({ type: "Magánszemély", email: "a@example.test" }))).toContain("missing_name");
    expect(codes(row({ type: "Cég", email: "a@example.test" }))).toContain("missing_company_name");
    expect(codes(row({ type: "Magánszemély", name: "X Y", company: "Valami Kft." }))).toContain("type_mismatch");
    expect(codes(row({ type: "Cég", company: "Valami Kft.", name: "X Y" }))).toContain("type_mismatch");
    expect(codes(row({ type: "Magánszemély", name: "X Y", contact: "K L" }))).toContain("type_mismatch");
    expect(codes(row({ type: "Ügyfél", name: "X Y" }))).toContain("unknown_type");
    expect(codes(row({ name: "X Y" }))).toContain("missing_type");
    expect(evaluateRow(row({ name: "X Y", email: "x@example.test" }), M, "individual").status).toBe("valid");
  });
  it("túl hosszú mező, érvénytelen telefon, kapcsolattartói elérhetőség név nélkül", () => {
    expect(codes(row({ type: "Magánszemély", name: "x".repeat(201) }))).toContain("too_long");
    expect(codes(row({ type: "Magánszemély", name: "X Y", phone: "abc" }))).toContain("invalid_phone");
    expect(codes(row({ type: "Cég", company: "C Kft.", contactPhone: "+36 1 000 0000" }))).toContain("contact_name_required");
    expect(codes(row({ type: "Cég", company: "C Kft.", contact: "Egyszavas", contactPhone: "+36 1 000 0000" }))).toContain("contact_full_name_required");
  });
  it("státusz: soha nem kerül átvételre - más vagy ismeretlen státusz figyelmeztetés; „Feldolgozásra vár” rendben", () => {
    expect(codes(row({ type: "Magánszemély", name: "X Y", email: "x@example.test", status: "Tőke elhelyezve" }))).toContain("status_not_applied");
    expect(codes(row({ type: "Magánszemély", name: "X Y", email: "x@example.test", status: "Valami" }))).toContain("unknown_status");
    expect(evaluateRow(row({ type: "Magánszemély", name: "X Y", email: "x@example.test", status: "Feldolgozásra vár" }), M, null).status).toBe("valid");
    const d = evaluateRow(row({ type: "Magánszemély", name: "X Y", email: "x@example.test", status: "capital_placed" }), M, null).draft as unknown as Record<string, unknown>;
    expect(Object.keys(d)).not.toContain("crmStatus");
  });
  it("figyelmeztetések: nincs elérhetőség, képletszerű érték, cégnél megjegyzés", () => {
    expect(evaluateRow(row({ type: "Magánszemély", name: "X Y" }), M, null)).toMatchObject({ status: "warning" });
    expect(codes(row({ type: "Magánszemély", name: "=HYPERLINK(1)", email: "x@example.test" }))).toContain("formula_like");
    expect(codes(row({ type: "Cég", company: "C Kft.", email: "c@example.test", notes: "jegyzet" }))).toContain("notes_not_stored");
  });
  it("üres sor; képletes és hibás cella hibának számít", () => {
    expect(evaluateRow(["", " ", ""], M, null).status).toBe("empty");
    const f = evaluateRow(row({ type: "Magánszemély", name: "X Y" }), M, null, (c) => ({ formula: c === 3 }));
    expect(f.status).toBe("error");
    expect(f.issues[0].code).toBe("formula_cell");
  });
  it("a hibaüzenetek nem tartalmazzák a cellaértéket", () => {
    const ev = evaluateRow(row({ type: "Magánszemély", name: "Titkos Tódor", email: "titkos@@example", phone: "123abc" }), M, null);
    expect(JSON.stringify(ev.issues)).not.toMatch(/Titkos|titkos|123abc/);
  });
  it("ügyféltípus-értékek", () => {
    expect(["Magánszemély", "maganszemely", "Individual", "Cég", "ceg", "company", "Vállalat"].map(parseCustomerType)).toEqual(["individual", "individual", "individual", "company", "company", "company", "company"]);
    expect(parseCustomerType("ismeretlen")).toBeNull();
  });
});
