import { describe, expect, it } from "vitest";
import { customerMatches, mailtoHref, phoneKey, quickActions, searchCustomerHits, telHref } from "@/domain/logic";
import { emptySnapshot, type DataSnapshot } from "@/domain/types";
import { U, newRepo, val } from "./helpers";

const build = () => {
  const r = newRepo(emptySnapshot());
  const anna = val(r.createCustomerFromForm({ type: "individual", name: "Kovács Anna", phone: "+36 30 123 4567", email: "Anna.Kovacs@Example.test", recordedBy: U })).customer;
  const co = val(r.createCustomerFromForm({ type: "company", companyName: "Minta Kft.", contactName: "Szabó Géza", recordedBy: U })).customer;
  const contact = r.getSnapshot().contacts.find((k) => k.companyId === co.id)!;
  val(r.updateContact(contact.id, { firstName: "Géza", lastName: "Szabó", phone: "06 (1) 234-5678", email: "geza@minta.test", isPrimaryContact: true }));
  const bare = val(r.createCustomerFromForm({ type: "individual", name: "Adat Nélküli", recordedBy: U })).customer;
  return { r, anna, co, bare };
};
const ids = (s: DataSnapshot, q: string) => searchCustomerHits(s, q).map((h) => h.customer.id);

describe("CRM-012 — keresés telefonszámra és e-mailre", () => {
  it("K1/K2/K3: név, cégnév, kapcsolattartó neve", () => {
    const { r, anna, co } = build();
    const s = r.getSnapshot();
    expect(ids(s, "kovács")).toEqual([anna.id]);
    expect(ids(s, "minta")).toEqual([co.id]);
    expect(searchCustomerHits(s, "Géza")[0]).toMatchObject({ customer: { id: co.id }, matches: [{ field: "contact", value: "Szabó Géza" }] });
  });
  it("K4/K6/K7: telefonszám formázva, formázás nélkül, részlegesen és 06 / +36 / 0036 alakban is", () => {
    const { r, anna } = build();
    const s = r.getSnapshot();
    for (const q of ["+36 30 123 4567", "36301234567", "+36301234567", "06301234567", "06 30 123 4567", "0036 30 123 4567", "(30) 123-4567", "3012345", "30 123"]) {
      expect(ids(s, q), q).toEqual([anna.id]);
    }
    expect(searchCustomerHits(s, "06301234567")[0].matches).toEqual([{ field: "phone", label: "Telefonszám", value: "+36 30 123 4567" }]);
    expect(ids(s, "123")).toEqual([]); // 4 számjegy alatt nincs telefonkeresés (és név sem egyezik)
  });
  it("K5/K8: e-mail kis- és nagybetűfüggetlenül, szóközökkel, teljes és részleges címre", () => {
    const { r, anna } = build();
    const s = r.getSnapshot();
    for (const q of ["anna.kovacs@example.test", "  ANNA.KOVACS@EXAMPLE.TEST ", "example.test", "kovacs@"]) expect(ids(s, q), q).toEqual([anna.id]);
    expect(searchCustomerHits(s, "kovacs@")[0].matches.map((m) => m.field)).toEqual(["email"]);
  });
  it("K9: a céges kapcsolattartó telefonszáma és e-mail-címe is kereshető, a találat a céghez vezet és megmondja, miért", () => {
    const { r, co } = build();
    const s = r.getSnapshot();
    expect(searchCustomerHits(s, "+36 1 234 5678")[0]).toMatchObject({ customer: { id: co.id }, matches: [{ field: "contactPhone", label: "Kapcsolattartó telefonszáma (Szabó Géza)", value: "06 (1) 234-5678" }] });
    expect(searchCustomerHits(s, "geza@minta")[0].matches).toEqual([{ field: "contactEmail", label: "Kapcsolattartó e-mail-címe (Szabó Géza)", value: "geza@minta.test" }]);
  });
  it("K10: ugyanaz az ügyfél csak egyszer szerepel, akkor is, ha több mezője egyezik", () => {
    const { r, anna } = build();
    const s = r.getSnapshot();
    const hits = searchCustomerHits(s, "anna");
    expect(hits.filter((h) => h.customer.id === anna.id)).toHaveLength(1);
    expect(hits[0].matches.map((m) => m.field)).toEqual(["name", "email"]);
  });
  it("a normalizálás nem agresszív: rövid vagy eltérő számok nem válnak azonossá", () => {
    expect(phoneKey("+36 30 123 4567")).toBe("36301234567");
    expect(phoneKey("06 30 123 4567")).toBe("36301234567");
    expect(phoneKey("0036301234567")).toBe("36301234567");
    expect(phoneKey("06 1234")).toBe("061234");
    expect(phoneKey("+44 20 7946 0000")).toBe("442079460000");
    const { r, anna } = build();
    expect(customerMatches(r.getSnapshot(), anna, "+36 30 123 4568")).toEqual([]);
    expect(customerMatches(r.getSnapshot(), anna, "a")).toEqual([{ field: "name", label: "Név", value: "Kovács Anna" }]);
  });
});

describe("CRM-011 — gyorsműveletek", () => {
  it("G4/G5: szabványos tel: és mailto: hivatkozás; cégnél az elsődleges kapcsolattartó adata", () => {
    const { r, anna, co } = build();
    const s = r.getSnapshot();
    expect(quickActions(s, anna)).toEqual({
      call: { value: "+36 30 123 4567", href: "tel:+36301234567" },
      email: { value: "Anna.Kovacs@Example.test", href: "mailto:Anna.Kovacs@Example.test" },
    });
    expect(quickActions(s, co).call.href).toBe("tel:0612345678");
    expect(telHref("06 (1) 234-5678")).toBe("tel:0612345678");
    expect(mailtoHref("a+b?x=1&y#z@ex.test")).toBe("mailto:a+b%3Fx=1%26y%23z@ex.test");
  });
  it("G6: hiányzó telefonszám / e-mail: nincs hivatkozás, érthető magyar jelzés", () => {
    const { r, bare } = build();
    expect(quickActions(r.getSnapshot(), bare)).toEqual({ call: { blockedReason: "Nincs megadva telefonszám." }, email: { blockedReason: "Nincs megadva e-mail-cím." } });
  });
  it("G7: rögzített tiltakozás/korlátozás vagy tiltott megkereshetőség mellett nem indítható (nem kerülhető meg)", () => {
    const { r, anna } = build();
    const restricted = { ...anna, restriction: { kind: "objection" as const, note: "fiktív", recordedAt: "2026-01-01T00:00:00.000Z", recordedBy: U } };
    const q = quickActions(r.getSnapshot(), restricted);
    expect(q.call).toEqual({ value: "+36 30 123 4567", blockedReason: "Tiltakozás van rögzítve: kimenő megkeresés nem indítható." });
    expect(q.email.href).toBeUndefined();
    val(r.setContactability({ customerId: anna.id }, "service", "phone", "prohibited", "documented_demo"));
    const q2 = quickActions(r.getSnapshot(), anna);
    expect(q2.call).toMatchObject({ blockedReason: "A(z) telefonos megkeresés tiltottként van rögzítve." });
    expect(q2.email.href).toBe("mailto:Anna.Kovacs@Example.test");
  });
  it("G8: a gyorsművelet állapotának lekérdezése nem hoz létre naplóbejegyzést", () => {
    const { r, anna } = build();
    const before = r.getSnapshot().activities.length;
    quickActions(r.getSnapshot(), anna);
    expect(r.getSnapshot().activities).toHaveLength(before);
  });
});
