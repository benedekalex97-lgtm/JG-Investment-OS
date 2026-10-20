import { describe, expect, it } from "vitest";
import { isSeedId, loadSnapshot, planDemoRemoval, removeDemoRecords } from "@/data/persistence";
import { emptySnapshot } from "@/domain/types";
import { U, newRepo, seed, val } from "./helpers";

describe("üres CRM kezdőállapot", () => {
  it("új munkamenet (nincs tárolt adat) üres snapshotot ad, fiktív seed nélkül", () => {
    const s = loadSnapshot(null);
    expect(s).toEqual(emptySnapshot());
    expect(s.customers).toHaveLength(0);
    expect(s.processes).toHaveLength(0);
  });
  it("hibás vagy más verziójú tartalom üres snapshotot ad (a nyers érték nem módosul)", () => {
    expect(loadSnapshot("{nem json").customers).toHaveLength(0);
    expect(loadSnapshot(JSON.stringify({ version: 1, customers: [{ id: "x" }] })).customers).toHaveLength(0);
    expect(loadSnapshot("null").customers).toHaveLength(0);
  });
  it("érvényes, mentett adat változtatás nélkül visszatöltődik", () => {
    const repo = newRepo(emptySnapshot());
    val(repo.createCustomer({ ownerId: U, type: "individual", firstName: "Kézzel", lastName: "Létrehozott" }));
    const back = loadSnapshot(JSON.stringify(repo.getSnapshot()));
    expect(back.customers).toHaveLength(1);
    expect(back.customers[0].id).toBe(repo.getSnapshot().customers[0].id);
  });
  it("üres CRM-ben az első ügyfél létrehozható és megmarad a visszatöltés után", () => {
    const repo = newRepo(emptySnapshot());
    val(repo.createCustomer({ ownerId: U, type: "company", companyName: "Első Kft." }));
    const again = newRepo(loadSnapshot(JSON.stringify(repo.getSnapshot())));
    expect(again.getSnapshot().customers.map((c) => (c.type === "company" ? c.companyName : ""))).toEqual(["Első Kft."]);
  });
});

describe("korábbi demóadat biztonságos kezelése", () => {
  it("a seed azonosítói felismerhetők, a kézzel létrehozottaké nem", () => {
    const repo = newRepo(emptySnapshot());
    const c = val(repo.createCustomer({ ownerId: U, type: "individual", firstName: "A", lastName: "B" }));
    expect(isSeedId("cust-12")).toBe(true);
    expect(isSeedId(c.id)).toBe(false);
    for (const x of seed().customers) expect(isSeedId(x.id)).toBe(true);
  });
  it("érintetlen demóadatnál minden demó ügyfél törölhető, és nem marad árva rekord", () => {
    const s = seed();
    const plan = planDemoRemoval(s);
    expect(plan.removable).toHaveLength(s.customers.length);
    expect(plan.kept).toHaveLength(0);
    const r = removeDemoRecords(s);
    expect(r.snapshot.customers).toHaveLength(0);
    for (const k of ["contacts", "processes", "tasks", "activities", "contactability"] as const) expect(r.snapshot[k]).toHaveLength(0);
    expect(r.removedRecords).toBeGreaterThan(50);
  });
  it("a kézzel létrehozott ügyfél és rekordjai megmaradnak, a demó eltávolítása mellett", () => {
    const repo = newRepo(seed());
    const mine = val(repo.createCustomer({ ownerId: U, type: "company", companyName: "Saját Kft." }));
    val(repo.addContact(mine.id, { firstName: "Saját", lastName: "Kapcsolat" }));
    val(repo.createProcess({ customerId: mine.id, type: "inbound_inquiry", title: "Saját folyamat", channel: "phone", source: "other", ownerId: U, recordedBy: U }));
    const before = repo.getSnapshot();
    const r = removeDemoRecords(before);
    expect(r.snapshot.customers.map((c) => c.id)).toEqual([mine.id]);
    expect(r.snapshot.contacts.some((k) => k.companyId === mine.id)).toBe(true);
    expect(r.snapshot.processes.filter((p) => p.customerId === mine.id)).toHaveLength(1);
    expect(r.snapshot.activities.filter((a) => a.customerId === mine.id).length).toBeGreaterThan(0);
  });
  it("a demó ügyfél, amelyhez kézzel létrehozott rekord kapcsolódik, megmarad (nincs csendes adatvesztés)", () => {
    const repo = newRepo(seed());
    const demoCustomer = repo.getSnapshot().customers[0];
    const myProcess = val(repo.createProcess({ customerId: demoCustomer.id, type: "inbound_inquiry", title: "Kézzel felvett", channel: "phone", source: "other", ownerId: U, recordedBy: U }));
    const plan = planDemoRemoval(repo.getSnapshot());
    expect(plan.kept.map((c) => c.id)).toEqual([demoCustomer.id]);
    const r = removeDemoRecords(repo.getSnapshot());
    expect(r.keptCustomers).toBe(1);
    expect(r.snapshot.customers.map((c) => c.id)).toEqual([demoCustomer.id]);
    expect(r.snapshot.processes.some((p) => p.id === myProcess.id)).toBe(true);
    // a megmaradó ügyfél eredeti, demó rekordjai is megmaradnak (egész ügyfél egységben marad)
    expect(r.snapshot.processes.filter((p) => p.customerId === demoCustomer.id).length).toBeGreaterThanOrEqual(1);
  });
  it("az eltávolítás idempotens", () => {
    const once = removeDemoRecords(seed());
    const twice = removeDemoRecords(once.snapshot);
    expect(twice.removedCustomers).toBe(0);
    expect(twice.removedRecords).toBe(0);
  });
});
