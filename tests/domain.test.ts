import { describe, expect, it } from "vitest";
import { DemoRepository } from "@/data/repository";
import { createSeedData } from "@/data/seed";
import { getContactability, searchCustomers, validateRelations } from "@/domain/logic";
import { customerInput } from "@/domain/schemas";

const NOW = new Date(2026, 9, 8, 12, 0, 0);
const repo = () => new DemoRepository(createSeedData(NOW), () => NOW);
const base = { lifecycleStatus: "prospect", ownerId: "user-1" };

describe("ügyféltípus-validáció", () => {
  it("magánszemély cégnév nélkül létrehozható", () => {
    const r = repo().createCustomer({ ...base, type: "person", firstName: "Próba", lastName: "Elek" });
    expect(r.ok && r.value.type === "person" && r.value.displayName).toBe("Elek Próba");
    expect(r.ok && "companyName" in r.value).toBe(false);
  });
  it("magánszemélynél a cégnév mező nem engedélyezett", () => {
    const r = customerInput.safeParse({ ...base, type: "person", firstName: "A", lastName: "B", companyName: "X Kft." });
    expect(r.success).toBe(false);
  });
  it("a cégnév kötelező", () => {
    const r = repo().createCustomer({ ...base, type: "company", companyName: "  " });
    expect(!r.ok && r.errors.companyName).toBeTruthy();
  });
  it("érvénytelen e-mail elutasítva", () => {
    const r = repo().createCustomer({ ...base, type: "person", firstName: "A", lastName: "B", email: "nem-email" });
    expect(!r.ok && r.errors.email).toBeTruthy();
  });
});

describe("céges kapcsolattartók", () => {
  it("egy céghez több kapcsolattartó adható, és csak egy elsődleges lehet", () => {
    const rp = repo();
    const c = rp.createCustomer({ ...base, type: "company", companyName: "Új Teszt Kft." });
    if (!c.ok) throw new Error("setup");
    rp.addContact(c.value.id, { firstName: "A", lastName: "Egy" });
    rp.addContact(c.value.id, { firstName: "B", lastName: "Kettő", isPrimaryContact: true });
    rp.addContact(c.value.id, { firstName: "C", lastName: "Három" });
    const ks = rp.getSnapshot().contacts.filter((k) => k.companyId === c.value.id);
    expect(ks).toHaveLength(3);
    expect(ks.filter((k) => k.isPrimaryContact).map((k) => k.lastName)).toEqual(["Kettő"]);
  });
  it("az első kapcsolattartó automatikusan elsődleges", () => {
    const rp = repo();
    const c = rp.createCustomer({ ...base, type: "company", companyName: "Új Teszt Kft." });
    if (!c.ok) throw new Error("setup");
    const k = rp.addContact(c.value.id, { firstName: "A", lastName: "Egy" });
    expect(k.ok && k.value.isPrimaryContact).toBe(true);
  });
  it("magánszemélyhez nem vehető fel kapcsolattartó", () => {
    expect(repo().addContact("cust-p1", { firstName: "A", lastName: "B" }).ok).toBe(false);
  });
  it("a kapcsolattartók nem jelennek meg külön ügyfélként", () => {
    const snap = createSeedData(NOW);
    expect(snap.customers.some((c) => c.id.startsWith("kont"))).toBe(false);
    expect(searchCustomers(snap, { query: "Gyakorlati" }).map((c) => c.id)).toEqual(["cust-c1"]);
  });
});

describe("ügy és ügyfél kapcsolata", () => {
  it("egy ügyfélhez több ügy tartozik", () => {
    const snap = createSeedData(NOW);
    expect(snap.cases.filter((c) => c.customerId === "cust-p1").length).toBeGreaterThan(1);
  });
  it("céges ügyhöz ugyanazon cég kapcsolattartója rendelhető", () => {
    const r = repo().createCase({ customerId: "cust-c1", companyContactId: "kont-01", title: "Új ügy", ownerId: "user-1" });
    expect(r.ok).toBe(true);
  });
  it("másik cég kapcsolattartója elutasítva", () => {
    const r = repo().createCase({ customerId: "cust-c1", companyContactId: "kont-04", title: "Új ügy", ownerId: "user-1" });
    expect(!r.ok && r.errors.companyContactId).toMatch(/nem ehhez a céghez/);
  });
  it("magánszemély ügyéhez nem rendelhető kapcsolattartó", () => {
    const r = repo().createCase({ customerId: "cust-p1", companyContactId: "kont-01", title: "Új ügy", ownerId: "user-1" });
    expect(!r.ok && r.errors.companyContactId).toMatch(/Magánszemély/);
  });
  it("meglévő ügy frissítése is validál", () => {
    expect(repo().updateCase("case-01", { companyContactId: "kont-01" }).ok).toBe(false);
  });
  it("tevékenység idegen ügyre nem rögzíthető", () => {
    const snap = createSeedData(NOW);
    expect(validateRelations(snap, { customerId: "cust-p1", caseId: "case-06" })).toMatch(/nem ehhez az ügyfélhez/);
  });
});

describe("keresés és szűrés", () => {
  const snap = createSeedData(NOW);
  it("név és cégnév alapján, ékezet- és kisbetű-függetlenül", () => {
    expect(searchCustomers(snap, { query: "mintavary" }).map((c) => c.id)).toContain("cust-p1");
    expect(searchCustomers(snap, { query: "pekseg" }).map((c) => c.id)).toEqual(["cust-c3"]);
  });
  it("szűrés típusra, státuszra, felelősre", () => {
    expect(searchCustomers(snap, { type: "company" }).every((c) => c.type === "company")).toBe(true);
    expect(searchCustomers(snap, { status: "archived" })).toHaveLength(1);
    expect(searchCustomers(snap, { ownerId: "user-2" }).every((c) => c.ownerId === "user-2")).toBe(true);
  });
});

describe("feladatok", () => {
  it("létrehozható, módosítható és lezárható", () => {
    const rp = repo();
    const t = rp.createTask({ customerId: "cust-p1", title: "Teszt", assigneeId: "user-1", dueAt: NOW.toISOString() });
    if (!t.ok) throw new Error("setup");
    expect(t.value.status).toBe("open");
    expect(rp.updateTask(t.value.id, { dueAt: "2026-12-01T10:00:00.000Z", assigneeId: "user-2" }).ok).toBe(true);
    const done = rp.setTaskStatus(t.value.id, "done");
    expect(done.ok && done.value.completedAt).toBe(NOW.toISOString());
    const reopened = rp.setTaskStatus(t.value.id, "open");
    expect(reopened.ok && reopened.value.completedAt).toBeUndefined();
  });
});

describe("tevékenység és megkereshetőség", () => {
  it("tevékenység rögzíthető", () => {
    const rp = repo();
    const before = rp.getSnapshot().activities.length;
    const r = rp.createActivity({ customerId: "cust-c1", companyContactId: "kont-01", type: "call", summary: "Teszthívás", occurredAt: NOW.toISOString(), ownerId: "user-1" });
    expect(r.ok).toBe(true);
    expect(rp.getSnapshot().activities).toHaveLength(before + 1);
  });
  it("a megkereshetőség alapértelmezetten unknown, az ügyfélstátusztól függetlenül", () => {
    const snap = createSeedData(NOW);
    expect(snap.customers.find((c) => c.id === "cust-p1")?.lifecycleStatus).toBe("existing");
    expect(getContactability(snap, { customerId: "cust-p1" }, "marketing", "email").status).toBe("unknown");
  });
});
