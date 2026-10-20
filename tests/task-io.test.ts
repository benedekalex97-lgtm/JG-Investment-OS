import { describe, expect, it } from "vitest";
import { TASK_INPUT_OPTIONS, TASK_NOTE_MAX, TASK_OUTCOME_LABELS, TASK_OUTCOMES, TASK_OUTPUT_OPTIONS, TASK_OUTPUT_REQUIRED, TASK_TEXT_MAX, TASK_TYPES, TASK_TYPE_LABELS } from "@/domain/constants";
import { inputText, latestOutput, nextTask, outcomeLabel, outputText, tasksByStatus } from "@/domain/logic";
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

describe("feladat lezárása (v0.9) — Sikeres / Sikertelen + kötelező, szabad szöveges Output", () => {
  const open = () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    const t = val(newTask(r, c.id, "phone_call", { inputKey: "first_contact" }));
    return { r, c, t };
  };
  const cur = (r: Repo, id: string) => r.getSnapshot().tasks.find((x) => x.id === id)!;
  const SAMPLE = "Telefonon egyeztettünk, az ügyfél érdeklődik a\nszolgáltatás iránt. Csütörtökön ismét keresni kell.";

  it("két lezárási minősítés van: Sikeres és Sikertelen", () => {
    expect(TASK_OUTCOMES).toEqual(["success", "failure"]);
    expect(TASK_OUTCOME_LABELS).toEqual({ success: "Sikeres", failure: "Sikertelen" });
  });
  it("A4/A5: üres, hiányzó vagy csak whitespace Output mellett egyik minősítéssel sem zárható le; egyértelmű magyar hiba", () => {
    const { r, t } = open();
    for (const outcome of TASK_OUTCOMES) {
      for (const output of ["", undefined, "   ", "\n\n", " \t \r\n ", " "]) {
        expect(errs(r.closeTask(t.id, { outcome, output, recordedBy: U })).output).toBe(TASK_OUTPUT_REQUIRED);
      }
    }
    expect(TASK_OUTPUT_REQUIRED).toBe("A feladat lezárásához az Output kitöltése kötelező.");
    expect(cur(r, t.id).status).toBe("open");
    expect(cur(r, t.id).outputs).toBeUndefined();
    expect(r.getSnapshot().activities.filter((a) => a.type === "task_completed")).toHaveLength(0);
  });
  it("minősítés nélkül vagy ismeretlen minősítéssel nem zárható le; a régi legördülős alak sem fogadható el", () => {
    const { r, t } = open();
    expect(errs(r.closeTask(t.id, { output: "Szöveg", recordedBy: U })).outcome).toMatch(/Sikeres vagy Sikertelen/);
    expect(errs(r.closeTask(t.id, { outcome: "done", output: "Szöveg", recordedBy: U })).outcome).toBeTruthy();
    expect(r.closeTask(t.id, { outputKey: "completed", recordedBy: U }).ok).toBe(false);
    expect(r.closeTask(t.id, { outcome: "success", output: "Szöveg", outputKey: "completed", recordedBy: U }).ok).toBe(false);
    expect(cur(r, t.id).status).toBe("open");
  });
  it("az Output hossza a meglévő szabad szöveges korláthoz (TASK_TEXT_MAX) kötött", () => {
    const { r, t } = open();
    expect(errs(r.closeTask(t.id, { outcome: "success", output: "x".repeat(TASK_TEXT_MAX + 1), recordedBy: U })).output).toMatch(String(TASK_TEXT_MAX));
    expect(val(r.closeTask(t.id, { outcome: "success", output: "x".repeat(TASK_TEXT_MAX), recordedBy: U })).outputs![0].text).toHaveLength(TASK_TEXT_MAX);
  });
  it("A6: kitöltött Output + Sikeres: lezárt, a minősítés és a szöveg külön tárolódik, rögzítő és időpont mellett", () => {
    const { r, t } = open();
    const done = closeIt(r, t.id, "success", SAMPLE);
    expect(done.status).toBe("done");
    expect(done.completedAt).toBeTruthy();
    expect(latestOutput(done)).toEqual({ outcome: "success", text: SAMPLE, closedAt: done.completedAt, closedBy: U });
    expect(latestOutput(done)!.key).toBeUndefined();
    expect(outputText(latestOutput(done)!)).toBe(SAMPLE);
    expect(outcomeLabel(latestOutput(done))).toBe("Sikeres");
    expect(done.inputKey).toBe("first_contact");
  });
  it("A7: kitöltött Output + Sikertelen: lezárt, sikertelen minősítéssel; a szöveg sortörései megmaradnak, csak a széleken vágódik", () => {
    const { r, t } = open();
    const done = closeIt(r, t.id, "failure", "\n  Az ügyfelet három próbálkozás után\nsem sikerült elérni.  \n");
    expect(latestOutput(done)).toMatchObject({ outcome: "failure", text: "Az ügyfelet három próbálkozás után\nsem sikerült elérni." });
    expect(outcomeLabel(latestOutput(done))).toBe("Sikertelen");
  });
  it("a lezárás naplózott: az esemény az adott lezárás Outputját és minősítését őrzi", () => {
    const { r, t } = open();
    closeIt(r, t.id, "failure", "Nem vette fel.");
    expect(r.getSnapshot().activities[0]).toMatchObject({
      type: "task_completed", recordedBy: U, summary: "Feladat lezárva — Sikertelen: Telefonhívás", meta: { taskId: t.id, taskOutcome: "failure", output: "Nem vette fel." },
    });
  });
  it("A8: a lezárás (bármely minősítéssel) nem módosítja az ügyfél státuszát", () => {
    const { r, c } = open();
    val(r.changeCrmStatus(c.id, { toStatus: "meeting", recordedBy: U }));
    const t2 = val(newTask(r, c.id, "online_meeting"));
    for (const o of TASK_OUTCOMES) {
      closeIt(r, t2.id, o, `Lezárás: ${o}`);
      expect(r.getSnapshot().customers.find((x) => x.id === c.id)!.crmStatus).toBe("meeting");
      val(r.setTaskStatus(t2.id, "open", U));
    }
  });
  it("A9 (tartományi szint): a már lezárt feladat második lezárása elutasított, nem keletkezik második eredmény vagy napló", () => {
    const { r, t } = open();
    closeIt(r, t.id, "success", "Első");
    expect(errs(r.closeTask(t.id, { outcome: "success", output: "Első", recordedBy: U }))._form).toMatch(/már le van zárva/);
    expect(cur(r, t.id).outputs).toHaveLength(1);
    expect(r.getSnapshot().activities.filter((a) => a.type === "task_completed")).toHaveLength(1);
    expect(errs(r.closeTask("nincs", { outcome: "success", output: "x", recordedBy: U }))._form).toMatch(/nem található/);
  });
  it("a lezárás nem kerülhető meg a státuszváltó művelettel sem", () => {
    const { r, t } = open();
    expect(errs(r.setTaskStatus(t.id, "done", U))._form).toMatch(/Sikeres vagy Sikertelen/);
    expect(cur(r, t.id).status).toBe("open");
  });
  it("B4/B5: újranyitás után az előzmény megmarad; az újabb lezárás új eredményt fűz hozzá, a régit nem írja felül", () => {
    const { r, t } = open();
    closeIt(r, t.id, "failure", "Nem sikerült elérni.");
    const count = r.getSnapshot().tasks.length;
    const reopened = val(r.setTaskStatus(t.id, "open", U));
    expect(reopened).toMatchObject({ status: "open" });
    expect(reopened.completedAt).toBeUndefined();
    expect(reopened.outputs).toHaveLength(1);
    expect(r.getSnapshot().tasks).toHaveLength(count);
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "task_updated", summary: "Feladat újranyitva: Telefonhívás", meta: { taskId: t.id, taskChange: "reopened" } });
    const again = closeIt(r, t.id, "success", "Visszahívott, időpontot egyeztettünk.");
    expect(again.outputs!.map((o) => [o.outcome, o.text])).toEqual([["failure", "Nem sikerült elérni."], ["success", "Visszahívott, időpontot egyeztettünk."]]);
    const closes = r.getSnapshot().activities.filter((a) => a.meta?.taskId === t.id && a.type === "task_completed");
    expect(closes.map((a) => [a.meta?.taskOutcome, a.meta?.output])).toEqual([["success", "Visszahívott, időpontot egyeztettünk."], ["failure", "Nem sikerült elérni."]]);
  });
  it("az Output és az Input nem vész el státuszváltáskor; a korábbi státusz lezárt feladata megmarad", () => {
    const { r, c, t } = open();
    closeIt(r, t.id, "success", "Információ elküldve.");
    for (const s of ["relationship", "meeting", "lost", "waiting_for_contact"]) val(r.changeCrmStatus(c.id, { toStatus: s, recordedBy: U }));
    expect(cur(r, t.id)).toMatchObject({ status: "done", crmStatus: "waiting_for_contact", inputKey: "first_contact" });
    expect(latestOutput(cur(r, t.id))!.text).toBe("Információ elküldve.");
    val(r.changeCrmStatus(c.id, { toStatus: "relationship", recordedBy: U }));
    const view = tasksByStatus(r.getSnapshot(), r.getSnapshot().customers.find((x) => x.id === c.id)!);
    expect(view.earlier.flatMap((g) => g.tasks).some((x) => x.id === t.id && latestOutput(x)?.outcome === "success")).toBe(true);
  });
  it("a lezárt feladat nem számít következő nyitott feladatnak; az újranyitott igen", () => {
    const { r, c, t } = open();
    closeIt(r, t.id);
    expect(nextTask(r.getSnapshot(), { customerId: c.id })).toBeUndefined();
    val(r.setTaskStatus(t.id, "open", U));
    expect(nextTask(r.getSnapshot(), { customerId: c.id })!.id).toBe(t.id);
  });
});

describe("feladat átidőzítése (v0.9) — a meglévő updateTask/setTaskDue útvonalon", () => {
  it("C1/C2/C4: az új határidő mentődik, a feladat nyitott marad, a napló a korábbi és az új határidőt őrzi", () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    const t = val(newTask(r, c.id, "phone_call", { dueAt: "2026-10-20T10:00:00.000Z" }));
    const next = val(r.updateTask(t.id, { dueAt: "2026-10-23T10:00:00.000Z" }, "user-2"));
    expect(next).toMatchObject({ status: "open", dueAt: "2026-10-23T10:00:00.000Z" });
    expect(next.outputs).toBeUndefined();
    expect(r.getSnapshot().activities[0]).toMatchObject({
      type: "task_updated", recordedBy: "user-2", summary: "Feladat átidőzítve: Telefonhívás",
      meta: { taskId: t.id, taskChange: "rescheduled", fromDueAt: "2026-10-20T10:00:00.000Z", toDueAt: "2026-10-23T10:00:00.000Z" },
    });
  });
  it("D8: változás nélküli mentés (ugyanaz az időpont, más írásmód) nem hoz létre naplóbejegyzést", () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    const t = val(newTask(r, c.id, "email", { dueAt: "2026-10-20T10:00:00.000Z" }));
    const n = r.getSnapshot().activities.length;
    val(r.updateTask(t.id, { dueAt: "2026-10-20T12:00:00+02:00" }, U));
    expect(r.getSnapshot().activities).toHaveLength(n);
  });
  it("határidő megadása és törlése is naplózott; érvénytelen dátum hibát ad és nem módosít", () => {
    const r = tickRepo(emptySnapshot());
    const c = mk(r);
    const t = val(newTask(r, c.id, "email"));
    val(r.updateTask(t.id, { dueAt: "2026-11-01T11:00:00.000Z" }, U));
    expect(r.getSnapshot().activities[0].meta).toMatchObject({ fromDueAt: null, toDueAt: "2026-11-01T11:00:00.000Z" });
    val(r.updateTask(t.id, { dueAt: null }, U));
    expect(r.getSnapshot().activities[0]).toMatchObject({ summary: "Feladat határideje törölve: E-mail", meta: { fromDueAt: "2026-11-01T11:00:00.000Z", toDueAt: null } });
    expect(errs(r.updateTask(t.id, { dueAt: "nem-datum" }, U)).dueAt).toBeTruthy();
    expect(r.getSnapshot().tasks.find((x) => x.id === t.id)!.dueAt).toBeUndefined();
  });
});

describe("régi (v0.5 előtti és v0.6-v0.8) feladatok kompatibilitása", () => {
  it("a régi, Output nélküli feladat érvényes marad: olvasható, újranyitható, lezárható az új módon", () => {
    const base = seed();
    const c = byName(base, "Mintaváry");
    const legacyDone = { id: "task-legacy1", customerId: c.id, title: "Régi elvégzett feladat", assigneeId: U, status: "done" as const, createdAt: "2026-01-01T10:00:00.000Z", completedAt: "2026-01-02T10:00:00.000Z" };
    const r = newRepo({ ...base, tasks: [...base.tasks, legacyDone] });
    const cur = r.getSnapshot().tasks.find((t) => t.id === "task-legacy1")!;
    expect(latestOutput(cur)).toBeUndefined();
    expect(cur.title).toBe("Régi elvégzett feladat");
    expect(cur.taskType).toBeUndefined();
    expect(val(r.setTaskStatus(cur.id, "open", U)).status).toBe("open");
    expect(closeIt(r, cur.id).outputs).toHaveLength(1);
  });
  it("B6: a v0.6-v0.8 legördülős Output (kulcs + „Egyéb” megjegyzés) olvasható marad, nem kap kitalált minősítést; az új lezárás hozzáfűz", () => {
    const base = seed();
    const c = byName(base, "Mintaváry");
    const v08 = {
      id: "task-v08", customerId: c.id, title: "Telefonhívás", taskType: "phone_call" as const, inputKey: "first_contact" as const, assigneeId: U,
      status: "done" as const, crmStatus: "contact" as const, createdAt: "2026-06-01T10:00:00.000Z", completedAt: "2026-06-02T10:00:00.000Z",
      outputs: [{ key: "not_reached" as const, text: "", closedAt: "2026-06-02T09:00:00.000Z", closedBy: U }, { key: "other" as const, text: "Levélben válaszolt", closedAt: "2026-06-02T10:00:00.000Z", closedBy: U }],
    };
    const r = newRepo({ ...base, tasks: [...base.tasks, v08] });
    const cur = r.getSnapshot().tasks.find((t) => t.id === "task-v08")!;
    expect(cur.outputs!.map(outputText)).toEqual(["Nem sikerült elérni", "Egyéb — Levélben válaszolt"]);
    expect(cur.outputs!.map((o) => outcomeLabel(o))).toEqual([undefined, undefined]);
    expect(TASK_OUTPUT_OPTIONS.length).toBe(9);
    val(r.setTaskStatus(cur.id, "open", U));
    const again = closeIt(r, cur.id, "success", "Új szöveges Output");
    expect(again.outputs!.slice(0, 2)).toEqual(v08.outputs);
    expect(again.outputs![2]).toMatchObject({ outcome: "success", text: "Új szöveges Output" });
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
    const again = closeIt(r, cur.id);
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
