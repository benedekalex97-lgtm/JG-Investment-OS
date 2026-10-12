import { describe, expect, it } from "vitest";
import { TASK_INPUT_OPTIONS, TASK_NOTE_MAX, TASK_OUTPUT_OPTIONS, TASK_TEXT_MAX, TASK_TYPES, TASK_TYPE_LABELS } from "@/domain/constants";
import { inputText, latestOutput, nextTask, outputText, tasksByStatus } from "@/domain/logic";
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
  it("az Input-lista központi konfigurációból jön: a hat ideiglenes opció, stabil kulcsokkal", () => {
    expect(TASK_INPUT_OPTIONS.map((o) => o.label)).toEqual(["Első megkeresés", "Visszahívás", "Időpont-egyeztetés", "Tájékoztatás", "Utánkövetés", "Egyéb"]);
    expect(new Set(TASK_INPUT_OPTIONS.map((o) => o.key)).size).toBe(TASK_INPUT_OPTIONS.length);
  });
  it("az Input legördülőből választott, opcionális érték; ismeretlen kulcs nem fogadható el", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(val(newTask(r, c.id, "email")).inputKey).toBeUndefined();
    for (const o of TASK_INPUT_OPTIONS) expect(val(newTask(r, c.id, "phone_call", { inputKey: o.key })).inputKey).toBe(o.key);
    expect(errs(newTask(r, c.id, "phone_call", { inputKey: "nincs_ilyen" })).inputKey).toBeTruthy();
  });
  it("az Input megjegyzés csak az „Egyéb” értékhez adható, hosszkorlátos", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    expect(errs(newTask(r, c.id, "email", { inputKey: "callback", inputNote: "x" })).inputNote).toMatch(/Egyéb/);
    expect(errs(newTask(r, c.id, "email", { inputNote: "x" })).inputNote).toMatch(/Egyéb/);
    const t = val(newTask(r, c.id, "email", { inputKey: "other", inputNote: "  Ajánlás alapján  " }));
    expect(t).toMatchObject({ inputKey: "other", inputNote: "Ajánlás alapján" });
    expect(inputText(t)).toBe("Egyéb — Ajánlás alapján");
    expect(errs(newTask(r, c.id, "email", { inputKey: "other", inputNote: "x".repeat(TASK_NOTE_MAX + 1) })).inputNote).toMatch(/Legfeljebb/);
  });
  it("a régi, szabad szöveges Input (leírás) változatlanul megmarad és megjelenik", () => {
    const r = newRepo(emptySnapshot());
    const c = mk(r);
    const multi = "Első sor\nMásodik sor";
    const t = val(newTask(r, c.id, "phone_call", { description: multi }));
    expect(t.description).toBe(multi);
    expect(t.inputKey).toBeUndefined();
    expect(inputText(t)).toBe(multi);
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

describe("feladat lezárása — kötelezően választott Output", () => {
  const open = () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    const t = val(newTask(r, c.id, "phone_call", { inputKey: "callback" }));
    return { r, c, t };
  };
  it("az Output-lista központi konfigurációból jön: a kilenc ideiglenes opció", () => {
    expect(TASK_OUTPUT_OPTIONS.map((o) => o.label)).toEqual([
      "Feladat elvégezve", "Nem sikerült elérni", "Kapcsolat létrejött", "Visszahívást kért", "Időpont egyeztetve",
      "Információ elküldve", "További egyeztetés szükséges", "Nem érdeklődik", "Egyéb",
    ]);
  });
  it("Output kiválasztása nélkül (üres, hiányzó, ismeretlen kulcs) a lezárás blokkolt, a feladat nyitott marad", () => {
    const { r, t } = open();
    for (const outputKey of ["", undefined, "nincs_ilyen"]) {
      expect(errs(r.closeTask(t.id, { outputKey, recordedBy: U })).outputKey).toMatch(/Output/);
    }
    const cur = r.getSnapshot().tasks.find((x) => x.id === t.id)!;
    expect(cur.status).toBe("open");
    expect(cur.outputs).toBeUndefined();
  });
  it("a lezárás nem kerülhető meg a státuszváltó művelettel sem", () => {
    const { r, t } = open();
    expect(errs(r.setTaskStatus(t.id, "done", U))._form).toMatch(/Output/);
    expect(r.getSnapshot().tasks.find((x) => x.id === t.id)!.status).toBe("open");
  });
  it("egyetlen kiválasztott Output elég; a feladathoz kapcsolódik, visszaolvasható és naplózott", () => {
    const { r, t } = open();
    const other = val(newTask(r, t.customerId, "email"));
    const done = closeIt(r, t.id, "meeting_scheduled");
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeTruthy();
    expect(latestOutput(done)).toMatchObject({ key: "meeting_scheduled", text: "", closedBy: U });
    expect(latestOutput(done)!.closedAt).toBe(done.completedAt);
    expect(outputText(latestOutput(done)!)).toBe("Időpont egyeztetve");
    expect(done.inputKey).toBe("callback");
    expect(latestOutput(r.getSnapshot().tasks.find((x) => x.id === other.id)!)).toBeUndefined();
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "task_completed", meta: { taskId: t.id, output: "Időpont egyeztetve" } });
  });
  it("a lezárás nem módosítja az ügyfél státuszát", () => {
    const { r, c, t } = open();
    val(r.changeCrmStatus(c.id, { toStatus: "meeting", recordedBy: U }));
    const t2 = val(newTask(r, c.id, "online_meeting"));
    for (const o of TASK_OUTPUT_OPTIONS) {
      closeIt(r, t2.id, o.key);
      expect(r.getSnapshot().customers.find((x) => x.id === c.id)!.crmStatus).toBe("meeting");
      val(r.setTaskStatus(t2.id, "open", U));
    }
    expect(t.id).toBeTruthy();
  });
  it("megjegyzés csak az „Egyéb” Outputhoz adható, hosszkorlátos és opcionális", () => {
    const { r, t } = open();
    expect(errs(r.closeTask(t.id, { outputKey: "completed", outputNote: "x", recordedBy: U })).outputNote).toMatch(/Egyéb/);
    expect(errs(r.closeTask(t.id, { outputKey: "other", outputNote: "x".repeat(TASK_NOTE_MAX + 1), recordedBy: U })).outputNote).toMatch(/Legfeljebb/);
    expect(r.getSnapshot().tasks.find((x) => x.id === t.id)!.status).toBe("open");
    const done = closeIt(r, t.id, "other");
    expect(outputText(latestOutput(done)!)).toBe("Egyéb");
    val(r.setTaskStatus(t.id, "open", U));
    const again = closeIt(r, t.id, "other", "  Levélben válaszolt  ");
    expect(outputText(latestOutput(again)!)).toBe("Egyéb — Levélben válaszolt");
  });
  it("már lezárt feladat nem zárható le újra, nem létező feladat hibát ad", () => {
    const { r, t } = open();
    closeIt(r, t.id);
    expect(errs(r.closeTask(t.id, { outputKey: "completed", recordedBy: U }))._form).toMatch(/már le van zárva/);
    expect(errs(r.closeTask("nincs", { outputKey: "completed", recordedBy: U }))._form).toMatch(/nem található/);
  });
  it("újranyitáskor az eredmény-előzmény megmarad, új feladat nem keletkezik; az újabb lezárás nem írja felül a korábbit", () => {
    const { r, t } = open();
    closeIt(r, t.id, "not_reached");
    const count = r.getSnapshot().tasks.length;
    const reopened = val(r.setTaskStatus(t.id, "open", U));
    expect(reopened.status).toBe("open");
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.outputs).toHaveLength(1);
    expect(r.getSnapshot().tasks).toHaveLength(count);
    const again = closeIt(r, t.id, "contact_made");
    expect(again.outputs!.map((o) => o.key)).toEqual(["not_reached", "contact_made"]);
    expect(latestOutput(again)!.key).toBe("contact_made");
    expect(r.getSnapshot().activities.filter((a) => a.meta?.taskId === t.id && a.type === "task_completed")).toHaveLength(2);
  });
  it("az Output és az Input nem vész el státuszváltáskor; a korábbi státusz lezárt feladata megmarad", () => {
    const { r, c, t } = open();
    closeIt(r, t.id, "information_sent");
    for (const s of ["relationship", "meeting", "lost", "waiting_for_contact"]) val(r.changeCrmStatus(c.id, { toStatus: s, recordedBy: U }));
    const cur = r.getSnapshot().tasks.find((x) => x.id === t.id)!;
    expect(cur).toMatchObject({ status: "done", crmStatus: "waiting_for_contact", inputKey: "callback" });
    expect(latestOutput(cur)!.key).toBe("information_sent");
    val(r.changeCrmStatus(c.id, { toStatus: "relationship", recordedBy: U }));
    const view = tasksByStatus(r.getSnapshot(), r.getSnapshot().customers.find((x) => x.id === c.id)!);
    expect(view.earlier.flatMap((g) => g.tasks).some((x) => x.id === t.id && latestOutput(x)?.key === "information_sent")).toBe(true);
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
    expect(closeIt(r, cur.id, "completed").outputs).toHaveLength(1);
  });
  it("a régi, szabad szöveges Input/Output megmarad: nem törlődik, nem íródik felül, nincs kitalált leképezés; az újabb lezárás hozzáfűz", () => {
    const base = seed();
    const c = byName(base, "Mintaváry");
    const legacy = {
      id: "task-legacy2", customerId: c.id, title: "Telefonhívás", taskType: "phone_call" as const, description: "Régi, szabad szöveges Input", assigneeId: U,
      status: "done" as const, crmStatus: "contact" as const, createdAt: "2026-01-01T10:00:00.000Z", completedAt: "2026-01-02T10:00:00.000Z",
      outputs: [{ text: "Régi, szabad szöveges Output", closedAt: "2026-01-02T10:00:00.000Z", closedBy: U }],
    };
    const r = newRepo({ ...base, tasks: [...base.tasks, legacy] });
    const cur = r.getSnapshot().tasks.find((t) => t.id === "task-legacy2")!;
    expect(inputText(cur)).toBe("Régi, szabad szöveges Input");
    expect(cur.inputKey).toBeUndefined();
    expect(outputText(latestOutput(cur)!)).toBe("Régi, szabad szöveges Output");
    val(r.setTaskStatus(cur.id, "open", U));
    const again = closeIt(r, cur.id, "completed");
    expect(again.outputs).toHaveLength(2);
    expect(again.outputs![0]).toEqual(legacy.outputs[0]);
    expect(again.description).toBe("Régi, szabad szöveges Input");
  });
  it("a régi feladatok a betöltéssel nem módosulnak", () => {
    const s = seed();
    const before = JSON.stringify(s.tasks);
    expect(JSON.stringify(newRepo(s).getSnapshot().tasks)).toBe(before);
  });
});
