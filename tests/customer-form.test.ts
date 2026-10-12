import { describe, expect, it } from "vitest";
import { buildDisplayName, contactName, otherContactsOf, primaryContactOf, splitName } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, byName, errs, newRepo, seed, val } from "./helpers";

const person = { type: "individual", name: "Kovács Béla", recordedBy: U } as const;
const company = { type: "company", companyName: "Űrlap Kft.", recordedBy: U } as const;

describe("új ügyfél — egyszerű űrlap, üzleti minimum: a név", () => {
  it("magánszemély: csak a név kötelező; telefon, e-mail, adatforrás nélkül is létrejön", () => {
    const { customer } = val(newRepo(emptySnapshot()).createCustomerFromForm(person));
    expect(customer.type).toBe("individual");
    expect(customer.type === "individual" && customer.displayName).toBe("Kovács Béla");
    expect(customer.phone).toBeUndefined();
    expect(customer.email).toBeUndefined();
    expect("companyName" in customer).toBe(false);
  });
  it("cég: csak a cégnév kötelező; nincs kapcsolati személy, telefon és e-mail kényszer", () => {
    const r = newRepo(emptySnapshot());
    const { customer, contact } = val(r.createCustomerFromForm(company));
    expect(customer.type === "company" && customer.companyName).toBe("Űrlap Kft.");
    expect(contact).toBeUndefined();
    expect(r.getSnapshot().contacts).toHaveLength(0);
  });
  it("név, illetve cégnév nélkül elutasítva, és semmi nem jön létre", () => {
    const r = newRepo(emptySnapshot());
    expect(errs(r.createCustomerFromForm({ ...person, name: "  " })).name).toBeTruthy();
    expect(errs(r.createCustomerFromForm({ ...company, companyName: "" })).companyName).toBeTruthy();
    expect(r.getSnapshot().customers).toHaveLength(0);
  });
  it("ha megadják, a telefon és az e-mail formátuma érvényes kell legyen", () => {
    const r = newRepo(emptySnapshot());
    expect(errs(r.createCustomerFromForm({ ...person, email: "nem-email" })).email).toBeTruthy();
    expect(errs(r.createCustomerFromForm({ ...person, phone: "abc" })).phone).toBeTruthy();
    expect(r.createCustomerFromForm({ ...person, phone: "+36 30 555 0100", email: "ok@minta.example" }).ok).toBe(true);
  });
  it("a cég kapcsolati személye és szerepe opcionális metaadat; elsődleges kapcsolattartóként tárolódik", () => {
    const r = newRepo(emptySnapshot());
    const { customer, contact } = val(r.createCustomerFromForm({ ...company, contactName: "Szabó Kata", contactPosition: "Irodavezető", phone: "+36 1 555 0100" }));
    expect(contact).toMatchObject({ companyId: customer.id, isPrimaryContact: true, lastName: "Szabó", firstName: "Kata", position: "Irodavezető" });
    expect(contactName(contact!)).toBe("Szabó Kata");
    expect(customer.phone).toBe("+36 1 555 0100");
  });
  it("új ügyfél alapértelmezett státusza: Kapcsolatfelvételre vár, nincs automatikus feladat vagy folyamat", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(person));
    expect(customer.crmStatus).toBe("waiting_for_contact");
    expect(r.getSnapshot().tasks).toHaveLength(0);
    expect(r.getSnapshot().processes).toHaveLength(0);
  });
  it("más induló státusz naplózott váltásként rögzül; a „Tőke elhelyezve” igazolás nélkül nem, és nem jön létre részleges ügyfél", () => {
    const r = newRepo(emptySnapshot());
    expect(errs(r.createCustomerFromForm({ ...person, crmStatus: "capital_placed" })).verification).toBeTruthy();
    expect(r.getSnapshot().customers).toHaveLength(0);
    const { customer } = val(r.createCustomerFromForm({ ...person, crmStatus: "relationship" }));
    expect(customer.crmStatus).toBe("relationship");
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "crm_status_change", meta: { fromCrmStatus: "waiting_for_contact", toCrmStatus: "relationship" } });
  });
});

describe("név szétbontása a rekordmodellhez", () => {
  it("az összefűzés visszaadja az eredeti, tisztított nevet", () => {
    for (const n of ["Kovács Béla", "Nagy-Kiss Mária Zsuzsanna", "Béla", "  Tót   Ádám "]) {
      const { lastName, firstName } = splitName(n);
      expect(buildDisplayName(firstName, lastName)).toBe(n.trim().replace(/\s+/g, " "));
    }
  });
});

describe("ügyféladatlap szerkesztése", () => {
  it("magánszemély adatai szerkeszthetők, a megjelenített név frissül; telefon opcionális", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(person));
    const up = val(r.updateCustomer(customer.id, { type: "individual", name: "Új Név", phone: "+36 20 555 0123", email: "uj@minta.example", source: "ajánlás" }));
    expect(up.type === "individual" && up.displayName).toBe("Új Név");
    expect(up).toMatchObject({ source: "ajánlás", email: "uj@minta.example" });
    expect(val(r.updateCustomer(customer.id, { type: "individual", name: "Új Név" })).phone).toBeUndefined();
  });
  it("a cégnév nem üríthető ki, az ügyfél típusa nem módosítható", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(company));
    expect(errs(r.updateCustomer(customer.id, { type: "company", companyName: "" })).companyName).toBeTruthy();
    expect(errs(r.updateCustomer(customer.id, { type: "individual", name: "A" }))._form).toMatch(/típusa/);
  });
  it("a kapcsolati státusz nem szerkeszthető az űrlapon (a séma elutasítja)", () => {
    const r = newRepo(emptySnapshot());
    const { customer } = val(r.createCustomerFromForm(company));
    expect(r.updateCustomer(customer.id, { type: "company", companyName: "X", crmStatus: "lost" }).ok).toBe(false);
  });
});

describe("kapcsolattartói adatok megőrzése", () => {
  it("szerkesztéskor a meglévő elsődleges rekord frissül (azonosítója és a hivatkozások maradnak), a többi kapcsolattartó érintetlen", () => {
    const r = newRepo(seed());
    const epito = byName(r.getSnapshot(), "Minta Építő");
    const before = r.getSnapshot();
    const primary = primaryContactOf(before, epito.id)!;
    const others = otherContactsOf(before, epito.id);
    expect(others).toHaveLength(2);
    const refs = {
      processes: before.processes.filter((p) => p.companyContactId === primary.id).map((p) => p.id),
      activities: before.activities.filter((a) => a.companyContactId === primary.id).map((a) => a.id),
    };
    val(r.updateCustomer(epito.id, { type: "company", companyName: "Minta Építő Kft.", contactName: "Gyakorlati Gábor", contactPosition: "Társtulajdonos", phone: "+36 20 555 0777" }));
    const after = r.getSnapshot();
    const savedPrimary = primaryContactOf(after, epito.id)!;
    expect(savedPrimary.id).toBe(primary.id);
    expect(savedPrimary.position).toBe("Társtulajdonos");
    expect(after.contacts.filter((k) => k.companyId === epito.id)).toHaveLength(3);
    expect(otherContactsOf(after, epito.id).map((k) => k.id)).toEqual(others.map((k) => k.id));
    expect(after.processes.filter((p) => p.companyContactId === primary.id).map((p) => p.id)).toEqual(refs.processes);
    expect(after.activities.filter((a) => a.companyContactId === primary.id).map((a) => a.id)).toEqual(refs.activities);
    for (const p of after.processes) if (p.companyContactId) expect(after.contacts.some((k) => k.id === p.companyContactId)).toBe(true);
  });
  it("a meglévő kapcsolattartói rekord üres névvel nem üríthető ki", () => {
    const r = newRepo(seed());
    const epito = byName(r.getSnapshot(), "Minta Építő");
    expect(errs(r.updateCustomer(epito.id, { type: "company", companyName: "Minta Építő Kft." })).contactName).toMatch(/nem üríthető/);
    expect(r.getSnapshot().contacts.filter((k) => k.companyId === epito.id)).toHaveLength(3);
  });
  it("kapcsolattartó nélküli cégnél a megadott kapcsolati személy új elsődleges rekord lesz", () => {
    const r = newRepo(seed());
    const pekseg = byName(r.getSnapshot(), "Teszt Pékség");
    expect(primaryContactOf(r.getSnapshot(), pekseg.id)).toBeUndefined();
    val(r.updateCustomer(pekseg.id, { type: "company", companyName: "Teszt Pékség Bt.", contactName: "Pék Péter" }));
    expect(contactName(primaryContactOf(r.getSnapshot(), pekseg.id)!)).toBe("Pék Péter");
  });
  it("a régi (v0.2/v0.3) cég a szerkesztés nélkül is érintetlenül olvasható: a státusz hiánya nem módosítja az adatot", () => {
    const s = seed();
    const before = JSON.stringify(s);
    const r = newRepo(s);
    r.getSnapshot();
    expect(JSON.stringify(r.getSnapshot())).toBe(before);
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
