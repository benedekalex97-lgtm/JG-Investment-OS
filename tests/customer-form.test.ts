import { describe, expect, it } from "vitest";
import { otherContactsOf, primaryContactOf } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, VERIFY, byName, errs, newRepo, seed, val } from "./helpers";

const person = { type: "individual", firstName: "Próba", lastName: "Elek", phone: "+36 30 555 0199", ownerId: U, recordedBy: U } as const;
const company = { type: "company", companyName: "Űrlap Kft.", contact: { firstName: "Kata", lastName: "Kapcsolat", phone: "+36 1 555 0100" }, ownerId: U, recordedBy: U } as const;

describe("új ügyfél űrlap — üzleti minimum", () => {
  it("magánszemély: név + telefon elég; e-mail opcionális; Potenciális ügyfél; nincs cégnév", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(person));
    expect(customer.contactStatus).toBe("prospect");
    expect("companyName" in customer).toBe(false);
    expect(customer.email).toBeUndefined();
  });
  it("magánszemély: telefonszám nélkül elutasítva", () => {
    const { phone: _p, ...noPhone } = person;
    expect(errs(newRepo(emptySnapshot()).createCustomerFromForm(noPhone)).phone).toMatch(/kötelező/);
  });
  it("cég: cégnév + kapcsolati személy neve + telefon elég; e-mail és beosztás nem kötelező", () => {
    const r = newRepo(emptySnapshot());
    const { customer, contact } = val(r.createCustomerFromForm(company));
    expect(customer.type).toBe("company");
    expect(contact).toMatchObject({ companyId: customer.id, isPrimaryContact: true, lastName: "Kapcsolat", phone: "+36 1 555 0100" });
    expect(contact?.email).toBeUndefined();
    expect(contact?.position).toBeUndefined();
  });
  it("cég: a cégnév, a kapcsolati személy neve és a telefon is kötelező; hibánál semmi nem jön létre", () => {
    const r = newRepo(emptySnapshot());
    expect(errs(r.createCustomerFromForm({ ...company, companyName: " " })).companyName).toBeTruthy();
    expect(errs(r.createCustomerFromForm({ ...company, contact: { ...company.contact, lastName: "" } })).lastName).toBeTruthy();
    expect(errs(r.createCustomerFromForm({ ...company, contact: { firstName: "K", lastName: "K" } })).phone).toBeTruthy();
    expect(r.getSnapshot().customers).toHaveLength(0);
    expect(r.getSnapshot().contacts).toHaveLength(0);
  });
  it("érvénytelen e-mail és telefon elutasítva", () => {
    const r = newRepo(emptySnapshot());
    expect(errs(r.createCustomerFromForm({ ...person, email: "nem-email" })).email).toBeTruthy();
    expect(errs(r.createCustomerFromForm({ ...person, phone: "abc" })).phone).toBeTruthy();
  });
  it("igazolt kapcsolati státusz igazolási forrás nélkül elutasítva, és semmi nem jön létre", () => {
    const r = newRepo(emptySnapshot());
    expect(errs(r.createCustomerFromForm({ ...person, contactStatus: "existing_verified" })).verification).toBeTruthy();
    expect(r.getSnapshot().customers).toHaveLength(0);
  });
  it("igazolt státusz igazolással: létrejön, és naplózott kapcsolati státuszváltás keletkezik", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm({ ...company, contactStatus: "existing_verified", verification: VERIFY }));
    expect(customer.contactStatus).toBe("existing_verified");
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "contact_status_change", customerId: customer.id, meta: { toContactStatus: "existing_verified" } });
  });
  it("archivált státusz igazolás nélkül is megadható", () => {
    expect(val(newRepo(emptySnapshot()).createCustomerFromForm({ ...person, contactStatus: "archived" })).customer.contactStatus).toBe("archived");
  });
});

describe("ügyféladatlap szerkesztése", () => {
  it("magánszemély adatai szerkeszthetők, a megjelenített név frissül", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(person));
    const up = val(r.updateCustomer(customer.id, { type: "individual", firstName: "Új", lastName: "Név", phone: "+36 20 555 0123", email: "uj@minta.example", ownerId: "user-2", source: "ajánlás" }));
    expect(up.type === "individual" && up.displayName).toBe("Név Új");
    expect(up).toMatchObject({ ownerId: "user-2", source: "ajánlás", email: "uj@minta.example" });
  });
  it("a cégnév nem üríthető ki, és az ügyfél típusa nem módosítható", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(company));
    expect(errs(r.updateCustomer(customer.id, { type: "company", companyName: "", ownerId: U, source: "x" })).companyName).toBeTruthy();
    expect(errs(r.updateCustomer(customer.id, { type: "individual", firstName: "A", lastName: "B", phone: "+36 20 555 0123", ownerId: U, source: "x" }))._form).toMatch(/típusa/);
  });
  it("a kapcsolati státusz nem szerkeszthető az űrlapon (a séma elutasítja)", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(company));
    expect(r.updateCustomer(customer.id, { type: "company", companyName: "X", ownerId: U, source: "x", contactStatus: "archived" }).ok).toBe(false);
  });
});

describe("kapcsolati személy és a meglévő kapcsolattartók megőrzése", () => {
  it("a mentés a meglévő elsődleges rekordot frissíti (azonosító és hivatkozások érvényesek maradnak), a többi kapcsolattartó érintetlen", () => {
    const r = newRepo(seed());
    const epito = byName(r.getSnapshot(), "Minta Építő");
    const before = r.getSnapshot();
    const primary = primaryContactOf(before, epito.id)!;
    const others = otherContactsOf(before, epito.id);
    expect(others.length).toBe(2);
    const refsBefore = {
      processes: before.processes.filter((p) => p.companyContactId === primary.id).map((p) => p.id),
      activities: before.activities.filter((a) => a.companyContactId === primary.id).map((a) => a.id),
    };
    const saved = val(r.savePrimaryContact(epito.id, { firstName: "Gábor", lastName: "Gyakorlati", phone: "+36 20 555 0777", position: "Társtulajdonos" }));
    const after = r.getSnapshot();
    expect(saved.id).toBe(primary.id);
    expect(saved).toMatchObject({ phone: "+36 20 555 0777", position: "Társtulajdonos", isPrimaryContact: true });
    expect(after.contacts.filter((k) => k.companyId === epito.id)).toHaveLength(3);
    expect(otherContactsOf(after, epito.id).map((k) => k.id)).toEqual(others.map((k) => k.id));
    expect(after.processes.filter((p) => p.companyContactId === primary.id).map((p) => p.id)).toEqual(refsBefore.processes);
    expect(after.activities.filter((a) => a.companyContactId === primary.id).map((a) => a.id)).toEqual(refsBefore.activities);
    for (const p of after.processes) if (p.companyContactId) expect(after.contacts.some((k) => k.id === p.companyContactId)).toBe(true);
  });
  it("kapcsolattartó nélküli cégnél a mentés létrehozza az elsődleges kapcsolati személyt", () => {
    const r = newRepo(seed());
    const pekseg = byName(r.getSnapshot(), "Teszt Pékség");
    expect(primaryContactOf(r.getSnapshot(), pekseg.id)).toBeUndefined();
    const c = val(r.savePrimaryContact(pekseg.id, { firstName: "Pék", lastName: "Péter", phone: "+36 1 555 0188" }));
    expect(primaryContactOf(r.getSnapshot(), pekseg.id)?.id).toBe(c.id);
  });
  it("kapcsolati személy nevével és telefonszámával együtt validál; magánszemélynél nem adható meg", () => {
    const r = newRepo(seed());
    const epito = byName(r.getSnapshot(), "Minta Építő");
    expect(errs(r.savePrimaryContact(epito.id, { firstName: "", lastName: "X", phone: "+36 1 555 0100" })).firstName).toBeTruthy();
    expect(errs(r.savePrimaryContact(epito.id, { firstName: "A", lastName: "B" })).phone).toBeTruthy();
    expect(r.savePrimaryContact(byName(r.getSnapshot(), "Mintaváry").id, { firstName: "A", lastName: "B", phone: "+36 1 555 0100" }).ok).toBe(false);
  });
  it("elsődlegesnek jelölés után cégenként pontosan egy elsődleges marad", () => {
    const r = newRepo(seed());
    const epito = byName(r.getSnapshot(), "Minta Építő");
    const other = otherContactsOf(r.getSnapshot(), epito.id)[0];
    val(r.makePrimaryContact(other.id));
    const list = r.getSnapshot().contacts.filter((k) => k.companyId === epito.id);
    expect(list.filter((k) => k.isPrimaryContact).map((k) => k.id)).toEqual([other.id]);
    expect(primaryContactOf(r.getSnapshot(), epito.id)?.id).toBe(other.id);
  });
});

describe("az elsődleges kapcsolati személy kijelölése determinisztikus", () => {
  const mk = (id: string, createdAt: string, primary: boolean) => ({ id, companyId: "c", firstName: id, lastName: id, isPrimaryContact: primary, createdAt, updatedAt: createdAt });
  const snap = (contacts: ReturnType<typeof mk>[]) => ({ ...emptySnapshot(), contacts });
  it("a jelölt kapcsolattartó az elsődleges", () => {
    expect(primaryContactOf(snap([mk("a", "2026-01-01T00:00:00Z", false), mk("b", "2026-02-01T00:00:00Z", true)]), "c")?.id).toBe("b");
  });
  it("jelölés nélkül a legkorábban felvett; azonos idő esetén az azonosító szerinti első", () => {
    expect(primaryContactOf(snap([mk("b", "2026-02-01T00:00:00Z", false), mk("a", "2026-01-01T00:00:00Z", false)]), "c")?.id).toBe("a");
    expect(primaryContactOf(snap([mk("z", "2026-01-01T00:00:00Z", false), mk("m", "2026-01-01T00:00:00Z", false)]), "c")?.id).toBe("m");
  });
  it("több jelölt esetén a legkorábban felvett, a tárolási sorrendtől függetlenül", () => {
    const list = [mk("x", "2026-03-01T00:00:00Z", true), mk("y", "2026-02-01T00:00:00Z", true), mk("w", "2026-01-01T00:00:00Z", false)];
    expect(primaryContactOf(snap(list), "c")?.id).toBe("y");
    expect(primaryContactOf(snap([...list].reverse()), "c")?.id).toBe("y");
  });
  it("kapcsolattartó nélküli cégnél undefined", () => {
    expect(primaryContactOf(snap([]), "c")).toBeUndefined();
  });
});
