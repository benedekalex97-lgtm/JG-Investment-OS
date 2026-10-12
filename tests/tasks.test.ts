import { describe, expect, it } from "vitest";
import { emptySnapshot } from "@/domain/types";
import { nextTask, overdueTasks, tasksByStatus, tasksDueToday } from "@/domain/logic";
import { NOW, U, byName, closeIt, errs, newRepo, seed, tickRepo, val } from "./helpers";

type Repo = ReturnType<typeof newRepo>;
const mk = (r: Repo, name = "Feladat Teszt") => val(r.createCustomerFromForm({ type: "individual", name, recordedBy: U })).customer;
const add = (r: Repo, customerId: string, title: string, extra: object = {}) => val(r.createTask({ customerId, title, assigneeId: U, recordedBy: U, ...extra }));
const to = (r: Repo, id: string, toStatus: string) => val(r.changeCrmStatus(id, { toStatus, recordedBy: U }));
const view = (r: Repo, id: string) => tasksByStatus(r.getSnapshot(), r.getSnapshot().customers.find((c) => c.id === id)!);

describe("feladat az ügyfél aktuális státusza alatt", () => {
  it("a minimális feladat: megnevezés; a határidő opcionális; automatikusan az aktuális státuszhoz kapcsolódik", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    to(r, c.id, "relationship");
    const t = add(r, c.id, "Visszahívás");
    expect(t).toMatchObject({ title: "Visszahívás", customerId: c.id, status: "open", crmStatus: "relationship" });
    expect(t.dueAt).toBeUndefined();
    expect(add(r, c.id, "Határidős", { dueAt: "2026-12-01T12:00:00.000Z" }).dueAt).toBe("2026-12-01T12:00:00.000Z");
  });
  it("név/típus nélkül elutasítva; folyamathoz nem kötött (nincs kötelező CustomerProcess)", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(errs(r.createTask({ customerId: c.id, title: " ", assigneeId: U }))).toHaveProperty("taskType");
    expect(add(r, c.id, "Folyamat nélkül").processId).toBeUndefined();
    expect(r.getSnapshot().processes).toHaveLength(0);
  });
  it("érvénytelen határidő elutasítva", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(errs(r.createTask({ customerId: c.id, title: "X", assigneeId: U, dueAt: "nem-datum" })).dueAt).toBeTruthy();
  });
  it("a feladat elvégezhető (Output-tal) és visszanyitható; elvégezve: igen/nem; naplózva; nincs külön állapotválasztás", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    const t = add(r, c.id, "Pipálható");
    const done = closeIt(r, t.id);
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeTruthy();
    const reopened = val(r.setTaskStatus(t.id, "open", U));
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeUndefined();
    const types = r.getSnapshot().activities.filter((a) => a.meta?.taskId === t.id).map((a) => a.type);
    expect(types).toEqual(expect.arrayContaining(["task_created", "task_completed", "task_updated"]));
  });
  it("a határidő módosítható és törölhető", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    const t = add(r, c.id, "Határidő", { dueAt: "2026-12-01T12:00:00.000Z" });
    expect(val(r.updateTask(t.id, { dueAt: "2026-12-24T12:00:00.000Z" }, U)).dueAt).toBe("2026-12-24T12:00:00.000Z");
    expect(val(r.updateTask(t.id, { dueAt: null }, U)).dueAt).toBeUndefined();
  });
});

describe("státuszváltás és feladatmegőrzés", () => {
  const scenario = () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    to(r, c.id, "contact");
    const call = add(r, c.id, "Telefonhívás");
    closeIt(r, call.id);
    to(r, c.id, "relationship");
    const meet = add(r, c.id, "Újabb egyeztetés");
    closeIt(r, meet.id);
    const docs = add(r, c.id, "Dokumentumküldés");
    closeIt(r, docs.id);
    const open = add(r, c.id, "Még nyitott a kapcsolatépítésből");
    to(r, c.id, "meeting");
    const consult = add(r, c.id, "Konzultáció");
    return { r, c, call, meet, docs, open, consult };
  };
  it("az aktuális státusz feladatai elsődlegesek, a korábbiak státusz szerint csoportosítva megmaradnak", () => {
    const { r, c, consult } = scenario();
    const v = view(r, c.id);
    expect(v.current.map((t) => t.id)).toEqual([consult.id]);
    expect(v.earlier.map((g) => g.status)).toEqual(["contact", "relationship"]);
    expect(v.earlier[0].tasks.map((t) => t.title)).toEqual(["Telefonhívás"]);
    expect(v.earlier[1].tasks.map((t) => t.title)).toEqual(["Még nyitott a kapcsolatépítésből", "Újabb egyeztetés", "Dokumentumküldés"]);
    expect(r.getSnapshot().tasks).toHaveLength(5);
  });
  it("a korábbi státuszból maradt nyitott feladat jól látható: megszámolva, nyitottak elöl", () => {
    const { r, c } = scenario();
    expect(view(r, c.id).openEarlier).toBe(1);
    const rel = view(r, c.id).earlier.find((g) => g.status === "relationship")!;
    expect(rel.tasks[0].status).toBe("open");
  });
  it("a státuszváltás nem töröl, nem pipál ki, nem hoz létre feladatot", () => {
    const { r, c } = scenario();
    const before = r.getSnapshot().tasks;
    to(r, c.id, "account_opening");
    to(r, c.id, "lost");
    to(r, c.id, "contact");
    expect(r.getSnapshot().tasks).toEqual(before);
  });
  it("visszalépés után az egykori státusz feladatai ismét az aktuálisak", () => {
    const { r, c, call } = scenario();
    to(r, c.id, "contact");
    expect(view(r, c.id).current.map((t) => t.id)).toEqual([call.id]);
    expect(view(r, c.id).earlier.map((g) => g.status)).toEqual(["relationship", "meeting"]);
  });
  it("az új feladat mindig az éppen aktuális státuszhoz kapcsolódik", () => {
    const { r, c } = scenario();
    to(r, c.id, "account_opening");
    expect(add(r, c.id, "Számlanyitási teendő").crmStatus).toBe("account_opening");
  });
  it("a régi (státusz nélküli) feladatok megmaradnak és megjelennek, kitalált státusz nélkül", () => {
    const r = newRepo(seed());
    const before = r.getSnapshot();
    const c = byName(before, "Mintaváry");
    const legacy = before.tasks.filter((t) => t.customerId === c.id);
    expect(legacy.length).toBeGreaterThan(0);
    expect(legacy.every((t) => t.crmStatus === undefined)).toBe(true);
    const v = tasksByStatus(before, c);
    expect(v.current).toHaveLength(0);
    expect(v.unassigned.map((t) => t.id).sort()).toEqual(legacy.map((t) => t.id).sort());
    expect(v.openEarlier).toBe(legacy.filter((t) => t.status !== "done").length);
    // új feladat felvétele a régi ügyfélnél: az aktuális (alapértelmezett) státuszhoz kapcsolódik, a régiek érintetlenek
    const t = add(r, c.id, "Új feladat a régi ügyfélnél");
    expect(t.crmStatus).toBe("waiting_for_contact");
    expect(r.getSnapshot().tasks.filter((x) => legacy.some((l) => l.id === x.id))).toEqual(legacy);
  });
  it("a régi, folyamathoz kötött feladat ügyfélkapcsolata megmarad", () => {
    const s = seed();
    for (const t of s.tasks) expect(s.customers.some((c) => c.id === t.customerId)).toBe(true);
    expect(s.tasks.some((t) => t.processId)).toBe(true);
  });
});

describe("következő nyitott feladat, mai és lejárt feladatok", () => {
  it("a következő feladat a legkorábbi határidejű nyitott; a határidő nélküliek utolsók; az elvégzett nem számít", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    add(r, c.id, "Határidő nélkül");
    const late = add(r, c.id, "Későbbi", { dueAt: "2026-12-10T12:00:00.000Z" });
    const early = add(r, c.id, "Korábbi", { dueAt: "2026-12-01T12:00:00.000Z" });
    expect(nextTask(r.getSnapshot(), { customerId: c.id })!.id).toBe(early.id);
    closeIt(r, early.id);
    expect(nextTask(r.getSnapshot(), { customerId: c.id })!.id).toBe(late.id);
    closeIt(r, late.id);
    expect(nextTask(r.getSnapshot(), { customerId: c.id })!.title).toBe("Határidő nélkül");
  });
  it("határidő nélküli feladat sem a mai, sem a lejárt listában nem szerepel", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    add(r, c.id, "Határidő nélkül");
    const today = add(r, c.id, "Mai", { dueAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 15).toISOString() });
    const old = add(r, c.id, "Lejárt", { dueAt: new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - 2, 15).toISOString() });
    expect(tasksDueToday(r.getSnapshot(), NOW).map((t) => t.id)).toEqual([today.id]);
    expect(overdueTasks(r.getSnapshot(), NOW).map((t) => t.id)).toEqual([old.id]);
    closeIt(r, old.id);
    expect(overdueTasks(r.getSnapshot(), NOW)).toHaveLength(0);
  });
});
