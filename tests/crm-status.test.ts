import { describe, expect, it } from "vitest";
import { CRM_STATUSES, CRM_STATUS_LABELS, DEFAULT_CRM_STATUS } from "@/domain/constants";
import { statusOf } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, VERIFY, errs, newRepo, seed, val } from "./helpers";

const newCustomer = (r: ReturnType<typeof newRepo>, name = "Státusz Teszt") =>
  val(r.createCustomerFromForm({ type: "individual", name, recordedBy: U })).customer;
const change = (r: ReturnType<typeof newRepo>, id: string, toStatus: string, extra: object = {}) => r.changeCrmStatus(id, { toStatus, recordedBy: U, ...extra });

describe("a hét jóváhagyott kapcsolati státusz", () => {
  it("pontosan hét státusz, a jóváhagyott megnevezéssel és sorrendben", () => {
    expect(CRM_STATUSES).toHaveLength(7);
    expect(CRM_STATUSES.map((s) => CRM_STATUS_LABELS[s])).toEqual([
      "Kapcsolatfelvételre vár", "Kapcsolatfelvétel", "Kapcsolatépítés", "Online/Személyes tárgyalás", "Számlanyitás", "Tőke elhelyezve", "Elvesztett",
    ]);
  });
  it("az alapértelmezett státusz a Kapcsolatfelvételre vár", () => {
    expect(DEFAULT_CRM_STATUS).toBe("waiting_for_contact");
    expect(statusOf(newCustomer(newRepo(emptySnapshot())))).toBe("waiting_for_contact");
  });
});

describe("kézi státuszváltás", () => {
  it("bármely másik státuszra váltható, kötelező sorrend és indoklás nélkül (előre, hátra, ugrással)", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    for (const to of ["relationship", "waiting_for_contact", "meeting", "contact", "account_opening", "lost"]) {
      expect(change(r, c.id, to).ok).toBe(true);
      expect(statusOf(r.getSnapshot().customers.find((x) => x.id === c.id)!)).toBe(to);
    }
  });
  it("ugyanarra a státuszra és ismeretlen státuszra nem váltható", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    expect(errs(change(r, c.id, "waiting_for_contact")).toStatus).toMatch(/már ebben/);
    expect(errs(change(r, c.id, "nincs_ilyen")).toStatus).toBeTruthy();
  });
  it("minden váltás naplózott (honnan, hová, ki)", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    change(r, c.id, "contact");
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "crm_status_change", customerId: c.id, recordedBy: U, meta: { fromCrmStatus: "waiting_for_contact", toCrmStatus: "contact" } });
  });
  it("a státuszváltás nem hoz létre folyamatot vagy feladatot, nem töröl és nem pipál ki feladatot", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    const t1 = val(r.createTask({ customerId: c.id, title: "Nyitott", recordedBy: U, assigneeId: U }));
    const t2 = val(r.createTask({ customerId: c.id, title: "Kész", recordedBy: U, assigneeId: U, status: "done" }));
    const before = r.getSnapshot();
    change(r, c.id, "relationship");
    change(r, c.id, "meeting");
    const after = r.getSnapshot();
    expect(after.processes).toHaveLength(before.processes.length);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.tasks.find((t) => t.id === t1.id)!.status).toBe("open");
    expect(after.tasks.find((t) => t.id === t2.id)!.status).toBe("done");
  });
  it("az Elvesztett státusz nem törli az ügyfelet és a feladatait", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    val(r.createTask({ customerId: c.id, title: "Marad", recordedBy: U, assigneeId: U }));
    change(r, c.id, "lost");
    expect(r.getSnapshot().customers.some((x) => x.id === c.id)).toBe(true);
    expect(r.getSnapshot().tasks).toHaveLength(1);
    expect(change(r, c.id, "relationship").ok).toBe(true);
  });
  it("a Számlanyitás nem igényel igazolást és nem jelent tényleges számlanyitást (egyszerű státusz)", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    expect(change(r, c.id, "account_opening").ok).toBe(true);
    expect(r.getSnapshot().activities[0].type).toBe("crm_status_change");
  });
});

describe("Tőke elhelyezve — igazolási kontroll (szimulált szolgáltatói mérföldkő)", () => {
  it("igazolás nélkül nem rögzíthető, és a státusz nem változik", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    expect(errs(change(r, c.id, "capital_placed")).verification).toMatch(/igazolási forrás/);
    expect(statusOf(r.getSnapshot().customers[0])).toBe("waiting_for_contact");
  });
  it("forráskategória vagy a compliance tudomásulvétel nélkül sem", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    expect(errs(change(r, c.id, "capital_placed", { verification: { complianceAcknowledged: true } })).verification).toBeTruthy();
    expect(errs(change(r, c.id, "capital_placed", { verification: { sourceCategory: "provider_notification", complianceAcknowledged: false } })).verification).toBeTruthy();
    expect(statusOf(r.getSnapshot().customers[0])).toBe("waiting_for_contact");
  });
  it("érvényes igazolással szimulált mérföldkőként naplózott: forrás, időpont, rögzítő; számlaadat nélkül", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    expect(change(r, c.id, "capital_placed", { verification: VERIFY }).ok).toBe(true);
    const log = r.getSnapshot().activities[0];
    expect(log.type).toBe("provider_milestone");
    expect(log.meta?.verification).toMatchObject({ sourceCategory: "provider_notification", recordedBy: U, simulated: true, complianceAcknowledged: true });
    expect(log.meta?.verification?.recordedAt).toBeTruthy();
    expect(Object.keys(log.meta!.verification!).join(",")).not.toMatch(/account|number|balance|transaction/i);
  });
  it("a többi státusz igazolás nélkül váltható", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    for (const s of ["contact", "relationship", "meeting", "account_opening", "lost"]) expect(change(r, c.id, s).ok).toBe(true);
  });
});

describe("megkeresési korlátozás a státuszokon", () => {
  it("tiltakozás mellett a kimenő kapcsolatfelvételi státuszok nem választhatók, a többi igen", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    val(r.setRestriction(c.id, { kind: "objection", note: "Fiktív tiltakozás.", recordedBy: U }));
    expect(errs(change(r, c.id, "contact")).toStatus).toMatch(/Tiltakozás/);
    expect(errs(change(r, c.id, "relationship")).toStatus).toMatch(/Tiltakozás/);
    expect(statusOf(r.getSnapshot().customers[0])).toBe("waiting_for_contact");
    expect(change(r, c.id, "lost").ok).toBe(true);
    expect(change(r, c.id, "meeting").ok).toBe(true);
  });
  it("a korlátozás feloldása után a státusz ismét választható", () => {
    const r = newRepo(emptySnapshot());
    const c = newCustomer(r);
    val(r.setRestriction(c.id, { kind: "restriction", note: "Fiktív korlátozás.", recordedBy: U }));
    val(r.setRestriction(c.id, { kind: null, note: "Feloldva", recordedBy: U }));
    expect(change(r, c.id, "contact").ok).toBe(true);
  });
});

describe("régi adatok megőrzése", () => {
  it("a régi (státusz nélküli) ügyfél olvasáskor az alapértelmezett státuszban jelenik meg, az adat nem módosul, nincs kitalált megfeleltetés", () => {
    const s = seed();
    expect(s.customers.every((c) => c.crmStatus === undefined)).toBe(true);
    expect(s.customers.every((c) => statusOf(c) === "waiting_for_contact")).toBe(true);
    // a régi folyamatstátuszok és a négyértékű kapcsolati besorolás érintetlenek
    expect(s.customers.some((c) => c.contactStatus === "existing_verified")).toBe(true);
    expect(s.processes.some((p) => p.status === "account_opening")).toBe(true);
  });
  it("a státusz csak a felhasználó által kezdeményezett váltáskor íródik a régi rekordra; a folyamatok és feladatok érintetlenek", () => {
    const r = newRepo(seed());
    const before = r.getSnapshot();
    const c = before.customers.find((x) => before.processes.some((p) => p.customerId === x.id))!;
    val(change(r, c.id, "meeting"));
    const after = r.getSnapshot();
    expect(after.customers.find((x) => x.id === c.id)!.crmStatus).toBe("meeting");
    expect(after.processes).toEqual(before.processes);
    expect(after.tasks).toEqual(before.tasks);
    expect(after.customers.filter((x) => x.id !== c.id)).toEqual(before.customers.filter((x) => x.id !== c.id));
  });
});
