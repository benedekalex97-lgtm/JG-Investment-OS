import { describe, expect, it } from "vitest";
import { customerInput } from "@/domain/schemas";
import { matchingContacts, searchCustomers, validateRelations } from "@/domain/logic";
import { U, byName, errs, newRepo, processOf, seed, val } from "./helpers";

const base = { ownerId: U };

describe("ügyféltípus-validáció", () => {
  it("magánszemély cégnév nélkül létrehozható, kapcsolati státusza Potenciális ügyfél", () => {
    const c = val(newRepo().createCustomer({ ...base, type: "individual", firstName: "Próba", lastName: "Elek" }));
    expect(c.type === "individual" && c.displayName).toBe("Elek Próba");
    expect("companyName" in c).toBe(false);
    expect(c.contactStatus).toBe("prospect");
  });
  it("magánszemélynél a cégnév mező nem engedélyezett", () => {
    expect(customerInput.safeParse({ ...base, type: "individual", firstName: "A", lastName: "B", companyName: "X Kft." }).success).toBe(false);
  });
  it("a cégnév kötelező", () => {
    expect(errs(newRepo().createCustomer({ ...base, type: "company", companyName: "  " })).companyName).toBeTruthy();
  });
  it("érvénytelen e-mail elutasítva", () => {
    expect(errs(newRepo().createCustomer({ ...base, type: "individual", firstName: "A", lastName: "B", email: "nem-email" })).email).toBeTruthy();
  });
});

describe("céges kapcsolattartók", () => {
  it("több kapcsolattartó, cégenként egy elsődleges", () => {
    const r = newRepo();
    const c = val(r.createCustomer({ ...base, type: "company", companyName: "Új Teszt Kft." }));
    r.addContact(c.id, { firstName: "A", lastName: "Egy" });
    r.addContact(c.id, { firstName: "B", lastName: "Kettő", isPrimaryContact: true });
    r.addContact(c.id, { firstName: "C", lastName: "Három" });
    const ks = r.getSnapshot().contacts.filter((k) => k.companyId === c.id);
    expect(ks).toHaveLength(3);
    expect(ks.filter((k) => k.isPrimaryContact).map((k) => k.lastName)).toEqual(["Kettő"]);
  });
  it("magánszemélyhez nem vehető fel kapcsolattartó", () => {
    const r = newRepo();
    expect(r.addContact(byName(r.getSnapshot(), "Mintaváry").id, { firstName: "A", lastName: "B" }).ok).toBe(false);
  });
  it("a kapcsolattartó nem külön ügyfél, de a keresés a céget találja meg", () => {
    const s = seed();
    expect(s.customers.some((c) => c.id.startsWith("kont"))).toBe(false);
    const hits = searchCustomers(s, { query: "gyakorlati" });
    expect(hits.map((c) => c.id)).toEqual([byName(s, "Minta Építő").id]);
    expect(matchingContacts(s, hits[0].id, "gyakorlati")).toHaveLength(1);
  });
});

describe("kapcsolati integritás", () => {
  it("céges folyamathoz csak ugyanazon cég kapcsolattartója rendelhető", () => {
    const r = newRepo();
    const s = r.getSnapshot();
    const epito = byName(s, "Minta Építő");
    const own = s.contacts.find((k) => k.companyId === epito.id)!;
    const foreign = s.contacts.find((k) => k.companyId !== epito.id)!;
    const mk = (companyContactId: string) => r.createProcess({ customerId: epito.id, companyContactId, type: "outbound_outreach", title: "Teszt", channel: "phone", source: "other", ownerId: U, recordedBy: U });
    expect(mk(own.id).ok).toBe(true);
    expect(errs(mk(foreign.id)).companyContactId).toMatch(/nem ehhez a céghez/);
  });
  it("magánszemély folyamatához nem rendelhető céges kapcsolattartó", () => {
    const r = newRepo();
    const s = r.getSnapshot();
    const k = s.contacts[0];
    const res = r.createProcess({ customerId: byName(s, "Mintaváry").id, companyContactId: k.id, type: "inbound_inquiry", title: "T", channel: "phone", source: "other", ownerId: U, recordedBy: U });
    expect(errs(res).companyContactId).toMatch(/Magánszemély/);
  });
  it("aktivitás idegen folyamatra nem rögzíthető", () => {
    const s = seed();
    const anna = byName(s, "Mintaváry");
    const foreign = s.processes.find((p) => p.customerId !== anna.id)!;
    expect(validateRelations(s, { customerId: anna.id, processId: foreign.id })).toMatch(/nem ehhez az ügyfélhez/);
  });
  it("folyamat-kapcsolattartó frissítése is validál", () => {
    const r = newRepo();
    const s = r.getSnapshot();
    const anna = byName(s, "Mintaváry");
    const p = s.processes.find((x) => x.customerId === anna.id)!;
    expect(r.updateProcess(p.id, { companyContactId: s.contacts[0].id }).ok).toBe(false);
  });
});

describe("keresés és szűrés", () => {
  const s = seed();
  it("ékezet- és kisbetű-független név- és cégnévkeresés", () => {
    expect(searchCustomers(s, { query: "mintavary" }).map((c) => c.id)).toContain(byName(s, "Mintaváry").id);
    expect(searchCustomers(s, { query: "pekseg" })).toHaveLength(1);
  });
  it("szűrés típusra, kapcsolati státuszra és felelősre", () => {
    expect(searchCustomers(s, { type: "company" }).every((c) => c.type === "company")).toBe(true);
    expect(searchCustomers(s, { contactStatus: "archived" }).length).toBeGreaterThan(0);
    expect(searchCustomers(s, { ownerId: "user-2" }).every((c) => c.ownerId === "user-2")).toBe(true);
  });
  it("szűrés folyamattípusra és folyamatstátuszra (csak aktív folyamatok)", () => {
    const inbound = searchCustomers(s, { processType: "inbound_inquiry" });
    expect(inbound.map((c) => c.id)).toContain(byName(s, "Tesztelek").id);
    // Dénes folyamata lezárt, ezért aktív szűrőre nem találat
    expect(searchCustomers(s, { processStatus: "needs_assessment" }).map((c) => c.id)).not.toContain(byName(s, "Kitalált").id);
  });
  
});

describe("adatperzisztencia (sessionStorage-szerű körút)", () => {
  it("a JSON-ból visszatöltött adatnál sem ütköznek az új azonosítók", () => {
    const first = newRepo();
    first.createCustomer({ ...base, type: "individual", firstName: "A", lastName: "B" });
    const restored = newRepo(JSON.parse(JSON.stringify(first.getSnapshot())));
    restored.createCustomer({ ...base, type: "individual", firstName: "C", lastName: "D" });
    const ids = restored.getSnapshot().customers.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(processOf(restored.getSnapshot(), byName(restored.getSnapshot(), "Mintaváry").id, "Gyermek").id).toBeTruthy();
  });
});
