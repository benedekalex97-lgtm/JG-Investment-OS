import { describe, expect, it } from "vitest";
import { nextSteps, processPath, requiresReason } from "@/domain/workflow";
import { U, VERIFY, byName, errs, newRepo, val } from "./helpers";
import type { CustomerProcess } from "@/domain/types";

const mkProcess = (r: ReturnType<typeof newRepo>, customerId: string, type: CustomerProcess["type"]) =>
  val(r.createProcess({ customerId, type, title: "Teszt folyamat", channel: type === "inbound_inquiry" ? "web_form" : "phone", source: type === "inbound_inquiry" ? "web_inquiry" : "contact_database", ownerId: U, recordedBy: U }));
const step = (r: ReturnType<typeof newRepo>, id: string, to: string, extra: object = {}) => r.changeProcessStatus(id, { toStatus: to, recordedBy: U, ...extra });
const individualId = (r: ReturnType<typeof newRepo>) => val(r.createCustomer({ ownerId: U, type: "individual", firstName: "Folyamat", lastName: "Teszt" })).id;

describe("kimenő és bejövő folyamat indulása", () => {
  it("kimenő: Megkeresésre vár; bejövő: Új érdeklődés", () => {
    const r = newRepo();
    const id = individualId(r);
    expect(mkProcess(r, id, "outbound_outreach").status).toBe("pending_outreach");
    expect(mkProcess(r, id, "inbound_inquiry").status).toBe("new_inquiry");
  });
  it("a két típus útvonala eltérő kiindulású, azonos folytatású", () => {
    expect(processPath("outbound_outreach")[0]).toBe("pending_outreach");
    expect(processPath("inbound_inquiry")[0]).toBe("new_inquiry");
    expect(processPath("outbound_outreach")).not.toContain("new_inquiry");
    expect(processPath("inbound_inquiry")).not.toContain("pending_outreach");
    expect(processPath("inbound_inquiry").slice(-1)[0]).toBe("first_deposit_verified");
  });
});

describe("meglévő ügyfél új folyamata", () => {
  it("nem változtatja a kapcsolati státuszt, a korábbi folyamatok megmaradnak; két párhuzamos folyamat", () => {
    const r = newRepo();
    const anna = byName(r.getSnapshot(), "Mintaváry");
    const before = r.getSnapshot();
    const procCount = before.processes.filter((p) => p.customerId === anna.id).length;
    const actCount = before.activities.filter((a) => a.customerId === anna.id).length;
    mkProcess(r, anna.id, "inbound_inquiry");
    const after = r.getSnapshot();
    expect(after.customers.find((c) => c.id === anna.id)!.contactStatus).toBe("existing_verified");
    expect(after.processes.filter((p) => p.customerId === anna.id)).toHaveLength(procCount + 1);
    expect(after.activities.filter((a) => a.customerId === anna.id).length).toBe(actCount + 1);
    expect(after.processes.filter((p) => p.customerId === anna.id && p.closure.state === "active").length).toBeGreaterThanOrEqual(2);
  });
});

describe("státuszváltás és naplózás", () => {
  it("a következő lépés indoklás nélkül váltható, és naplózott", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    const n = r.getSnapshot().activities.length;
    expect(step(r, p.id, "contact_in_progress").ok).toBe(true);
    const log = r.getSnapshot().activities[0];
    expect(r.getSnapshot().activities).toHaveLength(n + 1);
    expect(log).toMatchObject({ type: "status_change", processId: p.id, recordedBy: U, meta: { fromStatus: "new_inquiry", toStatus: "contact_in_progress" } });
  });
  it("visszalépéshez indoklás kell, indoklással megengedett és naplózott", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    step(r, p.id, "contact_in_progress");
    step(r, p.id, "contact_established");
    expect(errs(step(r, p.id, "contact_in_progress")).reason).toMatch(/Visszalépés/);
    expect(step(r, p.id, "contact_in_progress", { reason: "Az ügyfél mégsem volt elérhető." }).ok).toBe(true);
    expect(r.getSnapshot().activities[0].meta?.reason).toBe("Az ügyfél mégsem volt elérhető.");
  });
  it("előreugráshoz is indoklás kell (nem kötelezően lineáris)", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    expect(errs(step(r, p.id, "needs_assessment")).reason).toMatch(/Előreugr/);
    expect(step(r, p.id, "needs_assessment", { reason: "Az ügyfél már az első hívásban konzultációt kért." }).ok).toBe(true);
  });
  it("a felület a következő lehetséges lépéseket adja", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    const ns = nextSteps(p);
    expect(ns.next).toBe("contact_in_progress");
    expect(ns.back).toEqual([]);
    expect(ns.skipAhead.length).toBeGreaterThan(3);
    expect(requiresReason(p, "contact_in_progress")).toBe(false);
  });
  it("ugyanabba a státuszba, illetve más típus kiinduló állapotába nem váltható", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    expect(errs(step(r, p.id, "new_inquiry")).toStatus).toBeTruthy();
    expect(errs(step(r, p.id, "pending_outreach")).toStatus).toBeTruthy();
  });
});

describe("szolgáltatói mérföldkő igazolási kontrollja", () => {
  const toAccountPrep = () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    for (const s of ["contact_in_progress", "contact_established", "interest_identified", "needs_assessment", "account_prep"]) step(r, p.id, s);
    return { r, p };
  };
  it("igazolás nélkül nem rögzíthető", () => {
    const { r, p } = toAccountPrep();
    expect(errs(step(r, p.id, "account_opening")).verification).toBeTruthy();
    expect(r.getSnapshot().processes.find((x) => x.id === p.id)!.status).toBe("account_prep");
  });
  it("forráskategória nélkül nem rögzíthető", () => {
    const { r, p } = toAccountPrep();
    expect(errs(step(r, p.id, "account_opening", { verification: { complianceAcknowledged: true } })).verification).toBeTruthy();
  });
  it("a compliance figyelmeztetés tudomásulvétele nélkül nem rögzíthető", () => {
    const { r, p } = toAccountPrep();
    expect(errs(step(r, p.id, "account_opening", { verification: { sourceCategory: "provider_notification", complianceAcknowledged: false } })).verification).toBeTruthy();
  });
  it("érvényes igazolással szimulált mérföldkőként naplózott: forrás, időpont, rögzítő; számlaadat nélkül", () => {
    const { r, p } = toAccountPrep();
    expect(step(r, p.id, "account_opening", { verification: VERIFY }).ok).toBe(true);
    const log = r.getSnapshot().activities[0];
    expect(log.type).toBe("provider_milestone");
    expect(log.meta?.verification).toMatchObject({ sourceCategory: "provider_notification", recordedBy: U, simulated: true, complianceAcknowledged: true });
    expect(log.meta?.verification?.recordedAt).toBeTruthy();
    const keys = Object.keys(log.meta!.verification!).join(",");
    expect(keys).not.toMatch(/account|number|balance|transaction/i);
  });
  it("a nem mérföldkő státuszok igazolás nélkül váltanak (pl. előkészítés, első pénzelhelyezésre vár)", () => {
    const { r, p } = toAccountPrep();
    step(r, p.id, "account_opening", { verification: VERIFY });
    step(r, p.id, "account_opened", { verification: VERIFY });
    expect(step(r, p.id, "awaiting_first_deposit").ok).toBe(true);
  });
});

describe("lezárás", () => {
  const toDeposit = (verified: boolean) => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "inbound_inquiry");
    for (const s of ["contact_in_progress", "contact_established", "interest_identified", "needs_assessment", "account_prep"]) step(r, p.id, s);
    for (const s of ["account_opening", "account_opened"]) step(r, p.id, s, { verification: VERIFY });
    step(r, p.id, "awaiting_first_deposit");
    if (verified) step(r, p.id, "first_deposit_verified", { verification: VERIFY });
    return { r, p };
  };
  it("sikeres lezárás csak igazolt első pénzelhelyezésnél, naplózva", () => {
    const early = toDeposit(false);
    expect(errs(early.r.closeProcess(early.p.id, { outcome: "success", recordedBy: U }))._form).toMatch(/csak/);
    const { r, p } = toDeposit(true);
    expect(r.closeProcess(p.id, { outcome: "success", recordedBy: U }).ok).toBe(true);
    expect(r.getSnapshot().processes.find((x) => x.id === p.id)!.closure).toMatchObject({ state: "closed_success", closedBy: U });
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "process_closed", meta: { closureState: "closed_success" } });
  });
  it("sikeres lezárás nem módosítja automatikusan a kapcsolati státuszt", () => {
    const { r, p } = toDeposit(true);
    r.closeProcess(p.id, { outcome: "success", recordedBy: U });
    expect(r.getSnapshot().customers.find((c) => c.id === p.customerId)!.contactStatus).toBe("prospect");
  });
  it("az igazolás nélküli (manipulált) állapot sem zárható sikeresen", () => {
    const { r, p } = toDeposit(true);
    const snap = r.getSnapshot();
    const tampered = newRepo({ ...snap, activities: snap.activities.filter((a) => !(a.processId === p.id && a.type === "provider_milestone" && a.meta?.toStatus === "first_deposit_verified")) });
    expect(errs(tampered.closeProcess(p.id, { outcome: "success", recordedBy: U }))._form).toMatch(/igazolás/);
  });
  it("eredmény nélküli lezárás: indok kötelező; az „egyéb” szöveges indoklást kér", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "outbound_outreach");
    expect(errs(r.closeProcess(p.id, { outcome: "no_result", recordedBy: U })).reason).toBeTruthy();
    expect(errs(r.closeProcess(p.id, { outcome: "no_result", reason: "other", recordedBy: U })).reasonNote).toBeTruthy();
    expect(r.closeProcess(p.id, { outcome: "no_result", reason: "not_interested", recordedBy: U }).ok).toBe(true);
  });
  it("a lezárt folyamat nem törlődik, visszakereshető, indoklással újranyitható", () => {
    const r = newRepo();
    const p = mkProcess(r, individualId(r), "outbound_outreach");
    r.closeProcess(p.id, { outcome: "no_result", reason: "unreachable", recordedBy: U });
    expect(r.getSnapshot().processes.some((x) => x.id === p.id)).toBe(true);
    expect(errs(step(r, p.id, "contact_in_progress"))._form).toMatch(/Lezárt/);
    expect(errs(r.reopenProcess(p.id, { reason: "", recordedBy: U })).reason).toBeTruthy();
    expect(r.reopenProcess(p.id, { reason: "Új telefonszám érkezett.", recordedBy: U }).ok).toBe(true);
    expect(r.getSnapshot().processes.find((x) => x.id === p.id)!.closure.state).toBe("active");
  });
  it("későbbre halasztás: újraértékelési feladat készül, automatikus megkeresés nem", () => {
    const r = newRepo();
    const id = individualId(r);
    const p = mkProcess(r, id, "outbound_outreach");
    expect(errs(r.closeProcess(p.id, { outcome: "no_result", reason: "postponed", recordedBy: U })).followUpDueAt).toBeTruthy();
    const procs = r.getSnapshot().processes.length;
    expect(r.closeProcess(p.id, { outcome: "no_result", reason: "postponed", followUpDueAt: "2026-12-01T10:00:00.000Z", recordedBy: U }).ok).toBe(true);
    const s = r.getSnapshot();
    expect(s.tasks.some((t) => t.processId === p.id && t.title.startsWith("Újraértékelés") && t.dueAt === "2026-12-01T10:00:00.000Z")).toBe(true);
    expect(s.processes).toHaveLength(procs);
  });
});

describe("kapcsolati státusz és megkeresési korlátozás", () => {
  it("a kapcsolati státusz váltása külön, naplózott művelet; igazolt besorolás forrást kér", () => {
    const r = newRepo();
    const id = individualId(r);
    expect(errs(r.changeContactStatus(id, { to: "existing_verified", recordedBy: U })).verification).toBeTruthy();
    expect(r.changeContactStatus(id, { to: "existing_verified", recordedBy: U, verification: { sourceCategory: "other_documented", complianceAcknowledged: true }, reason: "Teszt" }).ok).toBe(true);
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "contact_status_change", meta: { fromContactStatus: "prospect", toContactStatus: "existing_verified" } });
    expect(errs(r.changeContactStatus(id, { to: "existing_verified", recordedBy: U, verification: { sourceCategory: "other_documented", complianceAcknowledged: true } })).to).toBeTruthy();
  });
  it("tiltakozás rögzítése blokkolja a kimenő kapcsolatépítést, a bejövő érdeklődést nem", () => {
    const r = newRepo();
    const id = individualId(r);
    expect(errs(r.setRestriction(id, { kind: "objection", recordedBy: U })).note).toBeTruthy();
    expect(r.setRestriction(id, { kind: "objection", note: "Fiktív tiltakozás.", recordedBy: U }).ok).toBe(true);
    const out = r.createProcess({ customerId: id, type: "outbound_outreach", title: "T", channel: "phone", source: "contact_database", ownerId: U, recordedBy: U });
    expect(errs(out).type).toMatch(/Tiltakozás/);
    expect(r.createProcess({ customerId: id, type: "inbound_inquiry", title: "T", channel: "web_form", source: "web_inquiry", ownerId: U, recordedBy: U }).ok).toBe(true);
    expect(r.setRestriction(id, { kind: null, note: "Feloldva", recordedBy: U }).ok).toBe(true);
    expect(r.getSnapshot().activities.filter((a) => a.type === "restriction_change" && a.customerId === id)).toHaveLength(2);
  });
});

describe("híváseredmény és aktivitás", () => {
  it("a híváseredmény Activity-ként rögzül, és nem módosítja a státuszt; a „nem érdeklődik” nem töröl", () => {
    const r = newRepo();
    const id = individualId(r);
    const p = mkProcess(r, id, "outbound_outreach");
    const customers = r.getSnapshot().customers.length;
    val(r.createActivity({ customerId: id, processId: p.id, type: "call", summary: "Nem érdeklődik.", occurredAt: "2026-10-08T09:00:00.000Z", recordedBy: U, callOutcome: "not_interested" }));
    const s = r.getSnapshot();
    expect(s.activities[0]).toMatchObject({ type: "call", callOutcome: "not_interested" });
    expect(s.processes.find((x) => x.id === p.id)!.status).toBe("pending_outreach");
    expect(s.customers).toHaveLength(customers);
  });
  it("híváseredmény csak hívásnál adható meg", () => {
    const r = newRepo();
    const id = individualId(r);
    expect(errs(r.createActivity({ customerId: id, type: "note", summary: "x", occurredAt: "2026-10-08T09:00:00.000Z", recordedBy: U, callOutcome: "busy" })).callOutcome).toBeTruthy();
  });
  it("rendszeresemények manuálisan nem hamisíthatók aktivitásként", () => {
    const r = newRepo();
    const id = individualId(r);
    expect(r.createActivity({ customerId: id, type: "provider_milestone", summary: "x", occurredAt: "2026-10-08T09:00:00.000Z", recordedBy: U }).ok).toBe(false);
  });
});

describe("feladatok", () => {
  it("létrehozható, módosítható, lezárható; minden változás naplózott", () => {
    const r = newRepo();
    const id = individualId(r);
    const t = val(r.createTask({ customerId: id, title: "Teszt", assigneeId: U, dueAt: "2026-10-09T10:00:00.000Z", recordedBy: U }));
    expect(t.status).toBe("open");
    expect(r.updateTask(t.id, { dueAt: "2026-12-01T10:00:00.000Z", assigneeId: "user-2" }, U).ok).toBe(true);
    const done = val(r.setTaskStatus(t.id, "done", U));
    expect(done.completedAt).toBeTruthy();
    expect(val(r.setTaskStatus(t.id, "open", U)).completedAt).toBeUndefined();
    const types = r.getSnapshot().activities.filter((a) => a.meta?.taskId === t.id).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["task_created", "task_updated", "task_completed"]));
  });
  it("érvénytelen határidő elutasítva", () => {
    const r = newRepo();
    const t = r.getSnapshot().tasks[0];
    expect(errs(r.updateTask(t.id, { dueAt: "nem-datum" }, U)).dueAt).toBeTruthy();
  });
});
