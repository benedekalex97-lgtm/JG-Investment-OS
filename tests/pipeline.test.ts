import { describe, expect, it } from "vitest";
import { CRM_STATUSES } from "@/domain/constants";
import { crmPipeline, customerName } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, byName, newRepo, seed, val } from "./helpers";

type Repo = ReturnType<typeof newRepo>;
const mk = (r: Repo, name: string) => val(r.createCustomerFromForm({ type: "individual", name, recordedBy: U })).customer;
const cardsOf = (r: Repo, id: string) => crmPipeline(r.getSnapshot()).flatMap((c) => c.customers).filter((c) => c.id === id);
const columnOf = (r: Repo, id: string) => crmPipeline(r.getSnapshot()).find((c) => c.customers.some((x) => x.id === id))!.status;

describe("Pipeline — egyszerű ügyfélstátusz-tábla", () => {
  it("az oszlopok pontosan a hét jóváhagyott státusz, sorrendben", () => {
    expect(crmPipeline(emptySnapshot()).map((c) => c.status)).toEqual([...CRM_STATUSES]);
    expect(crmPipeline(emptySnapshot()).map((c) => c.label)).toEqual([
      "Feldolgozásra vár", "Kapcsolatfelvétel", "Kapcsolatépítés", "Online/Személyes tárgyalás", "Számlanyitás", "Tőke elhelyezve", "Elvesztett",
    ]);
  });
  it("üres CRM-ben minden oszlop üres: nincs fiktív kártya", () => {
    expect(crmPipeline(emptySnapshot()).flatMap((c) => c.customers)).toHaveLength(0);
  });
  it("egy ügyfél = egy kártya, a státuszának oszlopában (több feladat vagy régi folyamat mellett is)", () => {
    const r = newRepo(seed());
    const all = r.getSnapshot().customers;
    const cards = crmPipeline(r.getSnapshot()).flatMap((c) => c.customers);
    expect(cards).toHaveLength(all.length);
    expect(new Set(cards.map((c) => c.id)).size).toBe(all.length);
    // a több (régi) folyamattal rendelkező ügyfél is csak egyszer szerepel
    const anna = byName(r.getSnapshot(), "Mintaváry");
    expect(r.getSnapshot().processes.filter((p) => p.customerId === anna.id).length).toBeGreaterThan(1);
    expect(cardsOf(r, anna.id)).toHaveLength(1);
  });
  it("a régi (státusz nélküli) ügyfelek az alapértelmezett oszlopban jelennek meg, kitalált megfeleltetés nélkül", () => {
    const r = newRepo(seed());
    expect(crmPipeline(r.getSnapshot())[0].customers).toHaveLength(r.getSnapshot().customers.length);
    expect(crmPipeline(r.getSnapshot()).slice(1).every((c) => c.customers.length === 0)).toBe(true);
  });
  it("az oszlopon belül név szerint rendezett", () => {
    const r = newRepo(emptySnapshot());
    for (const n of ["Zoltán Zsolt", "Ágnes Ági", "Béla Béla"]) mk(r, n);
    expect(crmPipeline(r.getSnapshot())[0].customers.map(customerName)).toEqual(["Ágnes Ági", "Béla Béla", "Zoltán Zsolt"]);
  });
  it("keresés névre és a cég kapcsolati személyének nevére", () => {
    const s = seed();
    const ids = (q: string) => crmPipeline(s, { query: q }).flatMap((c) => c.customers).map((c) => c.id);
    expect(ids("mintavary")).toEqual([byName(s, "Mintaváry").id]);
    expect(ids("gyakorlati")).toEqual([byName(s, "Minta Építő").id]);
    expect(ids("nincs-ilyen")).toHaveLength(0);
  });
});

describe("ügyféladatlap és Pipeline — egyetlen adatmező", () => {
  it("a státuszváltás azonnal átmozgatja a kártyát; mindig pontosan egy kártya van", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r, "Szinkron Teszt");
    expect(columnOf(r, c.id)).toBe("waiting_for_contact");
    for (const s of ["contact", "relationship", "meeting", "account_opening", "lost", "waiting_for_contact"]) {
      val(r.changeCrmStatus(c.id, { toStatus: s, recordedBy: U }));
      expect(columnOf(r, c.id)).toBe(s);
      expect(cardsOf(r, c.id)).toHaveLength(1);
    }
  });
  it("az Elvesztett ügyfél a saját oszlopában marad (nem törlődik)", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r, "Elvesztett Teszt");
    val(r.changeCrmStatus(c.id, { toStatus: "lost", recordedBy: U }));
    expect(columnOf(r, c.id)).toBe("lost");
  });
  it("a pipeline-ból is ugyanaz a kontroll érvényes: Tőke elhelyezve igazolás nélkül nem, tiltakozás mellett a kimenő státusz nem", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r, "Kontroll Teszt");
    expect(r.changeCrmStatus(c.id, { toStatus: "capital_placed", recordedBy: U }).ok).toBe(false);
    expect(columnOf(r, c.id)).toBe("waiting_for_contact");
    val(r.setRestriction(c.id, { kind: "objection", note: "Fiktív.", recordedBy: U }));
    expect(r.changeCrmStatus(c.id, { toStatus: "contact", recordedBy: U }).ok).toBe(false);
  });
});
