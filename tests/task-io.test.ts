import { describe, expect, it } from "vitest";
import { TASK_TEXT_MAX, TASK_TYPES, TASK_TYPE_LABELS } from "@/domain/constants";
import { latestOutput, nextTask, tasksByStatus } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, byName, closeIt, errs, newRepo, seed, tickRepo, val } from "./helpers";

type Repo = ReturnType<typeof newRepo>;
const mk = (r: Repo, name = "Input Output Teszt") => val(r.createCustomerFromForm({ type: "individual", name, recordedBy: U })).customer;
const newTask = (r: Repo, customerId: string, taskType: string, extra: object = {}) => r.createTask({ customerId, taskType, assigneeId: U, recordedBy: U, ...extra });

describe("új feladat — feladattípus, Input, határidő", () => {
  it("a feladattípus-lista központi konfigurációból jön: a hat ideiglenes típus", () => {
    expect(TASK_TYPES.map((t) => t.label)).toEqual(["Telefonhívás", "E-mail", "Online tárgyalás", "Személyes tárgyalás", "Utánkövetés", "Egyéb"]);
    expect(Object.keys(TASK_TYPE_LABELS)).toHaveLength(6);
  });
  it("a kiválasztott feladattípus neve maga a feladat neve; a típus kulcsa is tárolódik", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    for (const t of TASK_TYPES) {
      const task = val(newTask(r, c.id, t.key));
      expect(task.title).toBe(t.label);
      expect(task.taskType).toBe(t.key);
    }
  });
  it("a feladattípus kötelező, ismeretlen típus nem fogadható el; nincs külön szabad szöveges kötelező név", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(errs(r.createTask({ customerId: c.id, assigneeId: U, recordedBy: U })).taskType).toMatch(/típusának kiválasztása kötelező/);
    expect(errs(newTask(r, c.id, "nincs_ilyen")).taskType).toBeTruthy();
    expect(r.getSnapshot().tasks).toHaveLength(0);
  });
  it("az Input (leírás) opcionális, többsoros szöveg rögzíthető, hosszkorlátos", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(val(newTask(r, c.id, "email")).description).toBeUndefined();
    expect(val(newTask(r, c.id, "email", { description: "   " })).description).toBeUndefined();
    const multi = "Első sor\nMásodik sor\n- harmadik";
    expect(val(newTask(r, c.id, "phone_call", { description: multi })).description).toBe(multi);
    expect(val(newTask(r, c.id, "phone_call", { description: "x".repeat(TASK_TEXT_MAX) })).description).toHaveLength(TASK_TEXT_MAX);
    expect(errs(newTask(r, c.id, "phone_call", { description: "x".repeat(TASK_TEXT_MAX + 1) })).description).toMatch(/Legfeljebb/);
  });
  it("a határidő opcionális és érvényes dátum kell legyen", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(val(newTask(r, c.id, "follow_up")).dueAt).toBeUndefined();
    expect(val(newTask(r, c.id, "follow_up", { dueAt: "2026-12-01T12:00:00.000Z" })).dueAt).toBe("2026-12-01T12:00:00.000Z");
    expect(errs(newTask(r, c.id, "follow_up", { dueAt: "nem-datum" })).dueAt).toBeTruthy();
  });
  it("az új feladat az aktuális státuszhoz kapcsolódik, folyamat nem keletkezik", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    val(r.changeCrmStatus(c.id, { toStatus: "meeting", recordedBy: U }));
    expect(val(newTask(r, c.id, "online_meeting")).crmStatus).toBe("meeting");
    expect(r.getSnapshot().processes).toHaveLength(0);
  });
  it("új feladat nem hozható létre elvégzettként (a lezárás Output nélkül nem kerülhető meg)", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(newTask(r, c.id, "email", { status: "done" }).ok).toBe(false);
  });
  it("a régi, szabad szöveges feladatnév (belső/régi út) változatlanul megmarad", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    const t = val(r.createTask({ customerId: c.id, title: "Régi szabad szöveges név", assigneeId: U, recordedBy: U }));
    expect(t.title).toBe("Régi szabad szöveges név");
    expect(t.taskType).toBeUndefined();
  });
});

describe("feladat lezárása — kötelező Output", () => {
  const open = () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    const t = val(newTask(r, c.id, "phone_call", { description: "Visszahívás az ajánlat ügyében." }));
    return { r, c, t };
  };
  it("Output nélkül (üres, szóköz, hiányzó) a lezárás blokkolt, a feladat nyitott marad", () => {
    const { r, t } = open();
    for (const output of ["", "   \n  ", undefined]) {
      expect(errs(r.closeTask(t.id, { output, recordedBy: U })).output).toMatch(/Output/);
    }
    const cur = r.getSnapshot().tasks.find((x) => x.id === t.id)!;
    expect(cur.status).toBe("open");
    expect(cur.outputs).toBeUndefined();
  });
  it("az Output hosszkorlátos", () => {
    const { r, t } = open();
    expect(errs(r.closeTask(t.id, { output: "x".repeat(TASK_TEXT_MAX + 1), recordedBy: U })).output).toMatch(/Legfeljebb/);
  });
  it("a lezárás nem kerülhető meg a státuszváltó művelettel sem", () => {
    const { r, t } = open();
    expect(errs(r.setTaskStatus(t.id, "done", U))._form).toMatch(/Output/);
    expect(r.getSnapshot().tasks.find((x) => x.id === t.id)!.status).toBe("open");
  });
  it("Output-tal a feladat elvégzett lesz; az Output a konkrét feladathoz kapcsolódik és visszaolvasható; naplózott", () => {
    const { r, t } = open();
    const other = val(newTask(r, t.customerId, "email"));
    const done = val(r.closeTask(t.id, { output: "  Megbeszéltük a következő lépést.  ", recordedBy: U }));
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeTruthy();
    expect(latestOutput(done)).toMatchObject({ text: "Megbeszéltük a következő lépést.", closedBy: U });
    expect(latestOutput(done)!.closedAt).toBe(done.completedAt);
    expect(done.description).toBe("Visszahívás az ajánlat ügyében.");
    expect(latestOutput(r.getSnapshot().tasks.find((x) => x.id === other.id)!)).toBeUndefined();
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "task_completed", meta: { taskId: t.id, output: "Megbeszéltük a következő lépést." } });
  });
  it("már lezárt feladat nem zárható le újra, nem létező feladat hibát ad", () => {
    const { r, t } = open();
    closeIt(r, t.id);
    expect(errs(r.closeTask(t.id, { output: "Újra", recordedBy: U }))._form).toMatch(/már le van zárva/);
    expect(errs(r.closeTask("nincs", { output: "x", recordedBy: U }))._form).toMatch(/nem található/);
  });
  it("újranyitáskor az Output-előzmény megmarad, új feladat nem keletkezik; az újabb lezárás nem írja felül a korábbit", () => {
    const { r, t } = open();
    closeIt(r, t.id, "Első eredmény");
    const count = r.getSnapshot().tasks.length;
    const reopened = val(r.setTaskStatus(t.id, "open", U));
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.outputs).toHaveLength(1);
    expect(r.getSnapshot().tasks).toHaveLength(count);
    const again = closeIt(r, t.id, "Második eredmény");
    expect(again.outputs!.map((o) => o.text)).toEqual(["Első eredmény", "Második eredmény"]);
    expect(latestOutput(again)!.text).toBe("Második eredmény");
    expect(r.getSnapshot().activities.filter((a) => a.meta?.taskId === t.id && a.type === "task_completed")).toHaveLength(2);
  });
  it("az Output és az Input nem vész el státuszváltáskor; a korábbi státusz lezárt feladata megmarad", () => {
    const { r, c, t } = open();
    closeIt(r, t.id, "Eredmény");
    for (const s of ["relationship", "meeting", "lost", "waiting_for_contact"]) val(r.changeCrmStatus(c.id, { toStatus: s, recordedBy: U }));
    const cur = r.getSnapshot().tasks.find((x) => x.id === t.id)!;
    expect(cur).toMatchObject({ status: "done", crmStatus: "waiting_for_contact", description: "Visszahívás az ajánlat ügyében." });
    expect(latestOutput(cur)!.text).toBe("Eredmény");
    val(r.changeCrmStatus(c.id, { toStatus: "relationship", recordedBy: U }));
    const view = tasksByStatus(r.getSnapshot(), r.getSnapshot().customers.find((x) => x.id === c.id)!);
    expect(view.earlier.flatMap((g) => g.tasks).some((x) => x.id === t.id && latestOutput(x)?.text === "Eredmény")).toBe(true);
  });
  it("a lezárt feladat nem számít következő nyitott feladatnak; az újranyitott igen", () => {
    const { r, c, t } = open();
    closeIt(r, t.id);
    expect(nextTask(r.getSnapshot(), { customerId: c.id })).toBeUndefined();
    val(r.setTaskStatus(t.id, "open", U));
    expect(nextTask(r.getSnapshot(), { customerId: c.id })!.id).toBe(t.id);
  });
});

describe("régi (v0.5 előtti) feladatok kompatibilitása", () => {
  it("a régi, Output nélküli feladat érvényes marad: olvasható, újranyitható, lezárható Output-tal", () => {
    const base = seed();
    const c = byName(base, "Mintaváry");
    const legacyDone = { id: "task-legacy1", customerId: c.id, title: "Régi elvégzett feladat", assigneeId: U, status: "done" as const, createdAt: "2026-01-01T10:00:00.000Z", completedAt: "2026-01-02T10:00:00.000Z" };
    const r = newRepo({ ...base, tasks: [...base.tasks, legacyDone] });
    const cur = r.getSnapshot().tasks.find((t) => t.id === "task-legacy1")!;
    expect(latestOutput(cur)).toBeUndefined();
    expect(cur.title).toBe("Régi elvégzett feladat");
    expect(cur.taskType).toBeUndefined();
    expect(val(r.setTaskStatus(cur.id, "open", U)).status).toBe("open");
    expect(closeIt(r, cur.id, "Utólag rögzített eredmény").outputs).toHaveLength(1);
  });
  it("a régi feladatok a betöltéssel nem módosulnak", () => {
    const s = seed();
    const before = JSON.stringify(s.tasks);
    expect(JSON.stringify(newRepo(s).getSnapshot().tasks)).toBe(before);
  });
});
