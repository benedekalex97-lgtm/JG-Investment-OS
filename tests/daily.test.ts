import { describe, expect, it } from "vitest";
import { dailyTasks, isOverdue, overdueTasks, tasksDueToday } from "@/domain/logic";
import { addDays, dayKey, noonIsoOfDay } from "@/domain/time";
import { emptySnapshot } from "@/domain/types";
import { fromDateInputValue, toDateInputValue, formatDate } from "@/lib/format";
import { U, closeIt, tickRepo, val } from "./helpers";

describe("alkalmazás-időzóna (Europe/Budapest)", () => {
  it("N11: a „ma” a budapesti nap, nem az UTC-nap (éjfél körüli átfordulás)", () => {
    // 2026-10-19 22:30 UTC = 2026-10-20 00:30 Budapest (CEST, UTC+2)
    expect(dayKey("2026-10-19T22:30:00.000Z")).toBe("2026-10-20");
    expect(dayKey("2026-10-19T21:59:00.000Z")).toBe("2026-10-19");
    // téli időszámítás (CET, UTC+1)
    expect(dayKey("2026-12-31T23:30:00.000Z")).toBe("2027-01-01");
  });
  it("a dátummező értéke a budapesti nap déli 12:00-ja, oda-vissza azonos; érvénytelen nap üres", () => {
    expect(noonIsoOfDay("2026-10-20")).toBe("2026-10-20T10:00:00.000Z");
    expect(noonIsoOfDay("2026-12-01")).toBe("2026-12-01T11:00:00.000Z");
    expect(noonIsoOfDay("2026-03-29")).toBe("2026-03-29T10:00:00.000Z"); // DST-váltás napja
    expect(noonIsoOfDay("2026-02-30")).toBe("");
    expect(fromDateInputValue("nem-datum")).toBe("");
    for (const d of ["2026-01-01", "2026-03-29", "2026-10-25", "2026-12-31"]) expect(toDateInputValue(fromDateInputValue(d))).toBe(d);
    expect(formatDate("2026-10-19T22:30:00.000Z")).toBe("2026. 10. 20.");
    expect(addDays("2026-12-28", 7)).toBe("2027-01-04");
  });
});

describe("CRM-010 — napi feladatlista", () => {
  // „Most”: 2026-10-20 00:30 Budapest (UTC szerint még 19-e).
  const NOW = new Date("2026-10-19T22:30:00.000Z");
  const due = (d: string) => noonIsoOfDay(d);
  const setup = () => {
    const r = tickRepo(emptySnapshot());
    const c = val(r.createCustomerFromForm({ type: "individual", name: "Napi Nóra", recordedBy: U })).customer;
    const mk = (taskType: string, dueAt?: string, assigneeId = U) => val(r.createTask({ customerId: c.id, taskType, assigneeId, recordedBy: assigneeId, ...(dueAt ? { dueAt } : {}) }));
    const t = {
      old: mk("email", due("2026-10-10")),
      older: mk("email", due("2026-10-01")),
      yesterday: mk("phone_call", due("2026-10-19")),
      today: mk("phone_call", due("2026-10-20")),
      in7: mk("follow_up", due("2026-10-27")),
      in8: mk("follow_up", due("2026-10-28")),
      tomorrow: mk("online_meeting", due("2026-10-21")),
      none1: mk("other"),
      none2: mk("other"),
      foreign: mk("email", due("2026-10-20"), "user-2"),
      done: mk("email", due("2026-10-20")),
    };
    closeIt(r, t.done.id, "success", "Kész.");
    return { r, t };
  };

  it("N1/N12: csak a bejelentkezett munkatárs (assigneeId) feladatai; más felhasználóé nem személyes", () => {
    const { r, t } = setup();
    const mine = dailyTasks(r.getSnapshot(), NOW, U);
    const all = Object.values(mine).flat().map((x) => x.id);
    expect(all).not.toContain(t.foreign.id);
    expect(dailyTasks(r.getSnapshot(), NOW, "user-2").today.map((x) => x.id)).toEqual([t.foreign.id]);
    expect(Object.values(dailyTasks(r.getSnapshot(), NOW)).flat().map((x) => x.id)).toContain(t.foreign.id);
  });
  it("N2-N5 + N7: szűrők és rendezés (lejárt: legrégebbi elöl; ma; következő 7 nap: legkorábbi elöl; határidő nélkül: felvételi sorrend)", () => {
    const { r, t } = setup();
    const d = dailyTasks(r.getSnapshot(), NOW, U);
    expect(d.overdue.map((x) => x.id)).toEqual([t.older.id, t.old.id, t.yesterday.id]);
    expect(d.today.map((x) => x.id)).toEqual([t.today.id]);
    expect(d.next7.map((x) => x.id)).toEqual([t.tomorrow.id, t.in7.id]);
    expect(d.nodue.map((x) => x.id)).toEqual([t.none1.id, t.none2.id]);
    expect(Object.values(d).flat().map((x) => x.id)).not.toContain(t.in8.id);
  });
  it("N6: a lezárt feladat egyik nyitott csoportban sem szerepel; újranyitás után visszakerül", () => {
    const { r, t } = setup();
    expect(Object.values(dailyTasks(r.getSnapshot(), NOW, U)).flat().map((x) => x.id)).not.toContain(t.done.id);
    val(r.setTaskStatus(t.done.id, "open", U));
    expect(dailyTasks(r.getSnapshot(), NOW, U).today.map((x) => x.id)).toContain(t.done.id);
  });
  it("N11: a tegnapi (budapesti) határidő UTC-éjfél előtt is lejártnak, a mai mainak számít; a régi segédfüggvények egyeznek", () => {
    const { r, t } = setup();
    expect(isOverdue(t.yesterday, NOW)).toBe(true);
    expect(isOverdue(t.today, NOW)).toBe(false);
    expect(tasksDueToday(r.getSnapshot(), NOW).map((x) => x.id).sort()).toEqual([t.today.id, t.foreign.id].sort());
    expect(overdueTasks(r.getSnapshot(), NOW).map((x) => x.id).sort()).toEqual([t.old.id, t.older.id, t.yesterday.id].sort());
  });
});

describe("CRM-009 — a következő feladat nem jön létre automatikusan", () => {
  it("F8: a lezárás (bármely minősítéssel) nem hoz létre új feladatot és nem másolja az Outputot Inputba", () => {
    const r = tickRepo(emptySnapshot());
    const c = val(r.createCustomerFromForm({ type: "individual", name: "Követő Kata", recordedBy: U })).customer;
    const t = val(r.createTask({ customerId: c.id, taskType: "phone_call", assigneeId: U, recordedBy: U }));
    closeIt(r, t.id, "failure", "Nem vette fel, csütörtökön újra.");
    expect(r.getSnapshot().tasks).toHaveLength(1);
    const next = val(r.createTask({ customerId: c.id, taskType: "phone_call", inputKey: "callback", assigneeId: U, recordedBy: U }));
    expect(next).toMatchObject({ customerId: c.id, status: "open", inputKey: "callback" });
    expect(next.description).toBeUndefined();
    expect(r.getSnapshot().customers[0].crmStatus).toBe("waiting_for_contact");
    expect(r.getSnapshot().activities.filter((a) => a.type === "task_created")).toHaveLength(2);
  });
});
