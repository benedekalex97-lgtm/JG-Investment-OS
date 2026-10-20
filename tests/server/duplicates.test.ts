import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Customer, DataSnapshot } from "@/domain/types";
import { DRIVERS, PASSWORD_A, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";

describe.each(DRIVERS)("CRM-013 szerveroldali duplikáció-ellenőrzés (%s)", (kind) => {
  let t: TestDb;
  let c: Client;
  beforeAll(async () => {
    t = await makeTestDb(kind);
    await addPilotUsers(t.db);
    c = client(makeApi(t.db));
    await c.login("pilot.egy@example.test", PASSWORD_A);
  });
  afterAll(async () => { await t.cleanup(); });

  const snap = async () => ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: DataSnapshot }).snapshot;
  const create = (input: Record<string, unknown>, confirmDuplicates?: boolean, requestId = randomUUID()) =>
    c.op<{ customer: Customer }>("customer.create", { input, ...(confirmDuplicates !== undefined ? { confirmDuplicates } : {}) }, requestId);

  it("U9/U6: erős egyezésnél a szerver megerősítést kér (nem hoz létre rekordot); megerősítve létrehozza, auditálva", async () => {
    const first = (await create({ type: "individual", name: "Duplikált Dóra", email: "dora@example.test", phone: "+36 20 111 2222" })).body.result.value!.customer;
    const n = (await snap()).customers.length;
    const blocked = await create({ type: "individual", name: "Más Dóra", email: " DORA@example.test" });
    expect(blocked.body.result).toMatchObject({ ok: false, errors: { _duplicate: expect.stringMatching(/már szerepel/) }, duplicates: [{ customerId: first.id, name: "Duplikált Dóra", level: "strong", reasons: ["Azonos e-mail-cím"] }] });
    const byPhone = await create({ type: "company", companyName: "Dóra Bt.", phone: "06 20 111 2222" });
    expect(byPhone.body.result).toMatchObject({ ok: false, duplicates: [{ customerId: first.id, reasons: ["Azonos telefonszám"] }] });
    expect((await snap()).customers).toHaveLength(n);
    const ok = await create({ type: "individual", name: "Más Dóra", email: "dora@example.test" }, true);
    expect(ok.body.result.ok).toBe(true);
    expect((await snap()).customers).toHaveLength(n + 1);
    const audit = await t.db.system((tx) => tx.query<{ detail: Record<string, unknown> }>("select detail from audit_events where entity_id = $1", [ok.body.result.value!.customer.id]));
    expect(audit[0].detail).toMatchObject({ duplicateConfirmed: true });
    // U7/U8: a meglévő ügyfél változatlan, nincs összevonás vagy törlés.
    expect((await snap()).customers.find((x) => x.id === first.id)).toMatchObject({ displayName: "Duplikált Dóra", email: "dora@example.test", phone: "+36 20 111 2222" });
  });

  it("U12/U10: csak névegyezés (lehetséges egyezés) és egyezés nélküli felvitel nem igényel szerveroldali megerősítést", async () => {
    await create({ type: "individual", name: "Gyakori Gábor" });
    expect((await create({ type: "individual", name: "Gyakori Gábor" })).body.result.ok).toBe(true);
    expect((await create({ type: "individual", name: "Egyedi Edit", email: "edit@example.test" })).body.result.ok).toBe(true);
  });

  it("versenyhelyzet: két egyidejű, azonos e-mailes felvitelből pontosan egy jön létre, a másik megerősítést kér", async () => {
    const input = { type: "individual", name: "Párhuzamos Petra", email: "petra@example.test" };
    const rs = await Promise.all([create(input), create(input)]);
    expect(rs.map((r) => r.body.result.ok).sort()).toEqual([false, true]);
    expect((await snap()).customers.filter((x) => x.email === "petra@example.test")).toHaveLength(1);
  });

  it("U11: eltávolított rekorddal való erős egyezés: a tény jelzett, de a rekord neve és azonosítója nem kerül ki", async () => {
    process.env.JG_TEST_CUSTOMER_DELETE_ENABLED = "true";
    try {
      const gone = (await create({ type: "individual", name: "Eltávolított Elemér", email: "elemer@example.test" })).body.result.value!.customer;
      expect((await c.op("customer.delete", { customerId: gone.id, confirmation: "TÖRLÉS" })).body.result.ok).toBe(true);
      const r = await create({ type: "individual", name: "Új Elemér", email: "elemer@example.test" });
      expect(r.body.result).toMatchObject({ ok: false, duplicates: [{ customerId: null, name: "Eltávolított ügyfélrekord", level: "strong", reasons: ["Azonos e-mail-cím"] }] });
      expect(JSON.stringify(r.body.result)).not.toMatch(/Eltávolított Elemér|elemer@|cust-/);
      expect(JSON.stringify(r.body.snapshot)).not.toContain("Eltávolított Elemér");
    } finally {
      delete process.env.JG_TEST_CUSTOMER_DELETE_ENABLED;
    }
  });

  it("eltávolított cég kapcsolattartójának beágyazott zárójeles neve sem szivárog ki a szerver válaszában", async () => {
    process.env.JG_TEST_CUSTOMER_DELETE_ENABLED = "true";
    try {
      const co = (await create({ type: "company", companyName: "Zárójel (Belső) Kft.", contactName: "Minta Éva" })).body.result.value!.customer;
      const k = (await snap()).contacts.find((x) => x.companyId === co.id)!;
      await t.db.system((tx) => tx.query("update company_contacts set first_name = $2, last_name = $3, email = $4, phone = $5 where id = $1", [k.id, "(belső) Éva", "Minta", "eva.belso@example.test", "+36 1 888 7766"]));
      expect((await c.op("customer.delete", { customerId: co.id, confirmation: "TÖRLÉS" })).body.result.ok).toBe(true);
      for (const input of [{ type: "individual", name: "Új Éva", email: "EVA.BELSO@example.test" }, { type: "company", companyName: "Más Bt.", phone: "06 1 888 7766" }]) {
        const r = await create(input);
        expect(r.body.result).toMatchObject({ ok: false, duplicates: [{ customerId: null, name: "Eltávolított ügyfélrekord", typeLabel: "Cég", level: "strong" }] });
        const json = JSON.stringify(r.body.result);
        for (const secret of ["Minta", "belső", "Belső", "Éva", "Zárójel", "eva.belso", "888", co.id, "kapcsolattartó"]) expect(json.includes(secret), `${secret}: ${json}`).toBe(false);
      }
    } finally {
      delete process.env.JG_TEST_CUSTOMER_DELETE_ENABLED;
    }
  });
});
