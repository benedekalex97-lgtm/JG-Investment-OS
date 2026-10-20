import { describe, expect, it } from "vitest";
import { findDuplicates, maskRemoved, nameKey } from "@/domain/duplicates";
import { emptySnapshot } from "@/domain/types";
import { U, newRepo, val } from "./helpers";

const build = () => {
  const r = newRepo(emptySnapshot());
  const anna = val(r.createCustomerFromForm({ type: "individual", name: "Kovács Anna", phone: "+36 30 123 4567", email: "Anna.Kovacs@Example.test", recordedBy: U })).customer;
  const co = val(r.createCustomerFromForm({ type: "company", companyName: "Minta Kft.", contactName: "Szabó Géza", recordedBy: U })).customer;
  const k = r.getSnapshot().contacts.find((x) => x.companyId === co.id)!;
  val(r.updateContact(k.id, { firstName: "Géza", lastName: "Szabó", phone: "06 1 234 5678", email: "geza@minta.test", isPrimaryContact: true }));
  return { r, anna, co };
};

describe("CRM-013 — duplikált ügyfelek felismerése", () => {
  it("U1: azonos (normalizált) e-mail-cím → erős egyezés", () => {
    const { r, anna } = build();
    expect(findDuplicates(r.getSnapshot(), { type: "individual", name: "Más Név", email: "  anna.kovacs@EXAMPLE.test " })).toEqual([
      { customerId: anna.id, name: "Kovács Anna", typeLabel: "Magánszemély", level: "strong", reasons: ["Azonos e-mail-cím"], codes: ["email"] },
    ]);
  });
  it("U2: azonos telefonszám bármilyen formázással (06 / +36) → erős; a céges kapcsolattartó adata is", () => {
    const { r, anna, co } = build();
    expect(findDuplicates(r.getSnapshot(), { type: "individual", name: "X Y", phone: "06-30-123-45-67" })[0]).toMatchObject({ customerId: anna.id, level: "strong", reasons: ["Azonos telefonszám"] });
    expect(findDuplicates(r.getSnapshot(), { type: "individual", name: "X Y", phone: "+36 1 234 5678" })[0]).toMatchObject({ customerId: co.id, level: "strong", reasons: ["Azonos telefonszám (kapcsolattartó: Szabó Géza)"] });
    expect(findDuplicates(r.getSnapshot(), { type: "company", companyName: "Új Bt.", email: "GEZA@minta.test" })[0]).toMatchObject({ customerId: co.id, level: "strong" });
  });
  it("U3/U4: azonos név (szórendtől, ékezettől, kis/nagybetűtől függetlenül) vagy cégnév (cégforma nélkül) → lehetséges egyezés", () => {
    const { r, anna, co } = build();
    expect(findDuplicates(r.getSnapshot(), { type: "individual", name: "anna kovacs" })).toEqual([{ customerId: anna.id, name: "Kovács Anna", typeLabel: "Magánszemély", level: "possible", reasons: ["Azonos név"], codes: ["name"] }]);
    expect(findDuplicates(r.getSnapshot(), { type: "company", companyName: "MINTA kft" })[0]).toMatchObject({ customerId: co.id, level: "possible", reasons: ["Azonos cégnév"] });
    expect(findDuplicates(r.getSnapshot(), { type: "company", companyName: "Minta Zrt." })[0]).toMatchObject({ customerId: co.id, level: "possible" });
    expect(findDuplicates(r.getSnapshot(), { type: "company", companyName: "Egészen Más Kft.", contactName: "Géza Szabó" })[0]).toMatchObject({ customerId: co.id, level: "possible", reasons: ["Azonos kapcsolati személy neve (Szabó Géza)"] });
    expect(nameKey("Kovács  Anna.")).toBe(nameKey("anna kovacs"));
  });
  it("U10: egyezés nélküli felvitelnél nincs figyelmeztetés; rövid töredékek és hasonló, de nem azonos adatok nem egyeznek", () => {
    const { r } = build();
    for (const draft of [
      { type: "individual" as const, name: "Teljesen Új", phone: "+36 30 123 4568", email: "anna.kovacs@example.tes" },
      { type: "individual" as const, name: "Kovács Annamária" },
      { type: "company" as const, companyName: "Minta Plusz Kft." },
      { type: "individual" as const, name: "", phone: "1234" },
    ]) expect(findDuplicates(r.getSnapshot(), draft), JSON.stringify(draft)).toEqual([]);
  });
  it("az erős egyezések elöl; több ok egy találatban; nem módosít semmit (U7/U8)", () => {
    const { r, anna } = build();
    const before = JSON.stringify(r.getSnapshot());
    const res = findDuplicates(r.getSnapshot(), { type: "individual", name: "Kovács Anna", phone: "+36301234567", email: "anna.kovacs@example.test" });
    expect(res).toEqual([{ customerId: anna.id, name: "Kovács Anna", typeLabel: "Magánszemély", level: "strong", reasons: ["Azonos e-mail-cím", "Azonos telefonszám", "Azonos név"], codes: ["email", "phone", "name"] }]);
    expect(JSON.stringify(r.getSnapshot())).toBe(before);
  });
  it("U11: eltávolított rekord egyezésénél csak a tény látszik, a név és a kapcsolattartó neve nem (a szövegtől függetlenül, kódok alapján)", () => {
    expect(maskRemoved({ customerId: "cust-x", name: "Titkos Tamás", typeLabel: "Magánszemély", level: "strong", reasons: ["Azonos e-mail-cím", "Azonos telefonszám (kapcsolattartó: Titkos (T) Tamás)"], codes: ["email", "contact_phone"] }))
      .toEqual({ customerId: null, name: "Eltávolított ügyfélrekord", typeLabel: "Magánszemély", level: "strong", reasons: ["Azonos e-mail-cím", "Azonos telefonszám"], codes: ["email", "contact_phone"] });
  });
});

describe("maskRemoved — eltávolított rekord egyezése személyes adat nélkül", () => {
  const mk = (contact: string, opts: { email?: string; phone?: string } = {}) => {
    const r = newRepo(emptySnapshot());
    const co = val(r.createCustomerFromForm({ type: "company", companyName: "Rejtett (Holding) Kft.", contactName: "Ideiglenes Név", recordedBy: U })).customer;
    const k = r.getSnapshot().contacts.find((x) => x.companyId === co.id)!;
    const [lastName, ...rest] = contact.split(" ");
    val(r.updateContact(k.id, { firstName: rest.join(" "), lastName, email: opts.email ?? "eva@rejtett.test", phone: opts.phone ?? "+36 1 777 8899", isPrimaryContact: true }));
    return { r, co };
  };
  const NASTY = ["Minta (belső) Éva", "Minta ((dupla)) Éva", "Minta (nyitott Éva", "Minta ) zárt ( Éva", "Minta (a (b) c) Éva", "Kovács (kapcsolattartó: X) Éva"];

  it("beágyazott vagy kiegyensúlyozatlan zárójelek mellett sem marad név, e-mail, telefon vagy azonosító", () => {
    for (const contact of NASTY) {
      const { r, co } = mk(contact);
      for (const draft of [
        { type: "individual" as const, name: "Bárki", email: "EVA@rejtett.test" },
        { type: "individual" as const, name: "Bárki", phone: "06 1 777 8899" },
        { type: "company" as const, companyName: "Rejtett Holding", contactName: contact, email: "eva@rejtett.test", phone: "+3617778899" },
      ]) {
        const [hit] = findDuplicates(r.getSnapshot(), draft);
        expect(hit, `${contact} / ${JSON.stringify(draft)}`).toBeDefined();
        const masked = maskRemoved(hit);
        const json = JSON.stringify(masked);
        for (const secret of ["Minta", "belső", "dupla", "Éva", "Kovács", "kapcsolattartó", "Rejtett", "Holding", "eva@", "777", "8899", co.id, "(", ")"]) {
          expect(json.includes(secret), `${contact}: „${secret}” szivárog: ${json}`).toBe(false);
        }
        expect(masked.customerId).toBeNull();
        expect(masked.name).toBe("Eltávolított ügyfélrekord");
      }
    }
  });
  it("a példa: „Azonos e-mail-cím (kapcsolattartó: Minta (belső) Éva)” → „Azonos e-mail-cím”", () => {
    const { r } = mk("Minta (belső) Éva");
    const [hit] = findDuplicates(r.getSnapshot(), { type: "individual", name: "Bárki", email: "eva@rejtett.test" });
    expect(hit.reasons).toEqual(["Azonos e-mail-cím (kapcsolattartó: Minta (belső) Éva)"]);
    expect(maskRemoved(hit).reasons).toEqual(["Azonos e-mail-cím"]);
  });
  it("minden egyezési ok csak általános szövegként, ismétlés nélkül", () => {
    const { r } = mk("Minta (belső) Éva");
    const [hit] = findDuplicates(r.getSnapshot(), { type: "company", companyName: "Rejtett (Holding) Kft.", contactName: "Minta (belső) Éva", email: "eva@rejtett.test", phone: "+36 1 777 8899" });
    expect(maskRemoved(hit)).toEqual({ customerId: null, name: "Eltávolított ügyfélrekord", typeLabel: "Cég", level: "strong", reasons: ["Azonos e-mail-cím", "Azonos telefonszám", "Azonos cégnév", "Azonos kapcsolati személy neve"], codes: ["contact_email", "contact_phone", "company_name", "contact_name"] });
    const r2 = newRepo(emptySnapshot());
    val(r2.createCustomerFromForm({ type: "individual", name: "Titok (Teszt) Tamás", phone: "+36 30 222 3344", email: "t@titok.test", recordedBy: U }));
    const [ind] = findDuplicates(r2.getSnapshot(), { type: "company", companyName: "Bármi", contactName: "Titok (Teszt) Tamás", email: "t@titok.test", phone: "06302223344" });
    expect(maskRemoved(ind).reasons).toEqual(["Azonos e-mail-cím", "Azonos telefonszám", "Azonos név"]);
  });
  it("az aktív ügyfelek figyelmeztetése változatlan (részletes ok, kattintható azonosító)", () => {
    const { r, co } = mk("Minta (belső) Éva");
    const [hit] = findDuplicates(r.getSnapshot(), { type: "individual", name: "Bárki", phone: "06 1 777 8899" });
    expect(hit).toMatchObject({ customerId: co.id, name: "Rejtett (Holding) Kft.", level: "strong", reasons: ["Azonos telefonszám (kapcsolattartó: Minta (belső) Éva)"], codes: ["contact_phone"] });
  });
});
