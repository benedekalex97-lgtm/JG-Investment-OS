import { describe, expect, it } from "vitest";
import { customerHistory } from "@/domain/history";
import { emptySnapshot, type Activity } from "@/domain/types";
import { U, closeIt, newRepo, tickRepo, val } from "./helpers";

const fmt = (iso?: string) => (iso ? iso.slice(0, 10) : "—");

describe("Előzmények (v0.9) — időrendi lista az aktivitásnaplóból", () => {
  const scenario = () => {
    const r = tickRepo(emptySnapshot());
    const c = val(r.createCustomerFromForm({ type: "individual", name: "Előzmény Elek", recordedBy: U })).customer;
    const t = val(r.createTask({ customerId: c.id, taskType: "phone_call", dueAt: "2026-10-20T10:00:00.000Z", assigneeId: U, recordedBy: U }));
    val(r.updateTask(t.id, { dueAt: "2026-10-23T10:00:00.000Z" }, "user-2"));
    closeIt(r, t.id, "failure", "Nem sikerült elérni az ügyfelet.");
    val(r.setTaskStatus(t.id, "open", U));
    closeIt(r, t.id, "success", "Telefonon egyeztettünk.\nCsütörtökön ismét keresni kell.");
    val(r.changeCrmStatus(c.id, { toStatus: "contact", recordedBy: U }));
    val(r.createActivity({ customerId: c.id, type: "note", summary: "Ügyféljegyzet - nem előzmény", occurredAt: "2026-10-08T12:00:00.000Z", recordedBy: U }));
    return { r, c, t, h: customerHistory(r.getSnapshot(), c.id, fmt) };
  };

  it("a legfrissebb esemény elöl; minden esemény pontosan egyszer (nincs duplikáció); a jegyzet nem része", () => {
    const { h } = scenario();
    expect(h.map((e) => e.title)).toEqual([
      "Kapcsolati státusz módosítva", "Feladat lezárva — Sikeres", "Feladat újranyitva", "Feladat lezárva — Sikertelen", "Feladat átidőzítve", "Feladat létrehozva",
    ]);
    expect(new Set(h.map((e) => e.id)).size).toBe(h.length);
    expect(h.every((e, i) => i === 0 || Date.parse(h[i - 1].occurredAt) >= Date.parse(e.occurredAt))).toBe(true);
    expect(h.some((e) => e.details.some((d) => d.value.includes("Ügyféljegyzet")))).toBe(false);
  });
  it("D4/D5: a sikeres és a sikertelen lezárás a saját (eseményhez kötött) Outputjával jelenik meg", () => {
    const { h } = scenario();
    const ok = h.find((e) => e.title === "Feladat lezárva — Sikeres")!;
    const ko = h.find((e) => e.title === "Feladat lezárva — Sikertelen")!;
    expect(ok).toMatchObject({ outcome: "success", recordedBy: U, details: [{ label: "Feladat", value: "Telefonhívás" }, { label: "Output", value: "Telefonon egyeztettünk.\nCsütörtökön ismét keresni kell.", multiline: true }] });
    expect(ko).toMatchObject({ outcome: "failure", details: [{ label: "Feladat", value: "Telefonhívás" }, { label: "Output", value: "Nem sikerült elérni az ügyfelet.", multiline: true }] });
  });
  it("D6: az átidőzítés a korábbi és az új határidővel, a módosító munkatárssal jelenik meg", () => {
    const { h } = scenario();
    expect(h.find((e) => e.title === "Feladat átidőzítve")).toMatchObject({
      recordedBy: "user-2",
      details: [{ label: "Feladat", value: "Telefonhívás" }, { label: "Korábbi határidő", value: "2026-10-20" }, { label: "Új határidő", value: "2026-10-23" }],
    });
  });
  it("a kapcsolati státusz változása a korábbi és az új státusszal", () => {
    const { h } = scenario();
    expect(h[0].details).toEqual([{ label: "Korábbi státusz", value: "Feldolgozásra vár" }, { label: "Új státusz", value: "Kapcsolatfelvétel" }]);
  });
  it("D7: a régi (v0.8-ig) naplóbejegyzések változatlanul, kitalált minősítés nélkül jelennek meg", () => {
    const base = emptySnapshot();
    const r = newRepo(base);
    const c = val(r.createCustomerFromForm({ type: "individual", name: "Régi Napló", recordedBy: U })).customer;
    const legacy: Activity[] = [
      { id: "act-a", customerId: c.id, type: "task_completed", occurredAt: "2026-05-02T10:00:00.000Z", summary: "Feladat lezárva: Telefonhívás — Nem sikerült elérni", recordedBy: U, meta: { taskId: "task-x", output: "Nem sikerült elérni" } },
      { id: "act-b", customerId: c.id, type: "task_updated", occurredAt: "2026-05-01T10:00:00.000Z", summary: "Feladat újranyitva: Telefonhívás", recordedBy: U, meta: { taskId: "task-x" } },
      { id: "act-c", customerId: c.id, type: "task_updated", occurredAt: "2026-04-30T10:00:00.000Z", summary: "Feladat módosítva (határidő): Telefonhívás", recordedBy: U, meta: { taskId: "task-x" } },
      { id: "act-d", customerId: c.id, type: "task_completed", occurredAt: "2026-04-29T10:00:00.000Z", summary: "Feladat elvégezve: Régi", recordedBy: U },
      { id: "act-e", customerId: c.id, type: "call", occurredAt: "2026-04-28T10:00:00.000Z", summary: "Régi hívás", recordedBy: U, callOutcome: "busy" },
    ];
    const snap = { ...r.getSnapshot(), activities: [...r.getSnapshot().activities, ...legacy] };
    const before = JSON.stringify(snap.activities);
    const h = customerHistory(snap, c.id, fmt);
    expect(JSON.stringify(snap.activities)).toBe(before);
    const byId = Object.fromEntries(h.map((e) => [e.id, e]));
    expect(byId["act-a"]).toMatchObject({ title: "Feladat lezárva", outcome: undefined, details: [{ label: "Output", value: "Nem sikerült elérni" }] });
    expect(byId["act-b"].title).toBe("Feladat újranyitva");
    expect(byId["act-c"]).toMatchObject({ title: "Feladat módosítva", details: [{ label: "Összefoglaló", value: "Feladat módosítva (határidő): Telefonhívás" }] });
    expect(byId["act-d"]).toMatchObject({ title: "Feladat lezárva", details: [{ label: "Összefoglaló", value: "Feladat elvégezve: Régi" }] });
    expect(byId["act-e"]).toMatchObject({ title: "Hívás", details: [{ label: "Összefoglaló", value: "Régi hívás" }, { label: "Híváseredmény", value: "Foglalt" }] });
  });
});
