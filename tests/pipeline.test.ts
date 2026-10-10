import { describe, expect, it } from "vitest";
import { PROCESS_STATUS_DEFS } from "@/domain/constants";
import { closedProcesses, matchesPipelineFilter, pipelineColumns } from "@/domain/logic";
import { emptySnapshot } from "@/domain/types";
import { U, VERIFY, byName, errs, newRepo, seed, val } from "./helpers";

const total = (cols: ReturnType<typeof pipelineColumns>) => cols.reduce((n, c) => n + c.processes.length, 0);

describe("pipeline — oszlopok a tényleges folyamatstátuszokból", () => {
  it("az oszlopok pontosan a v0.2 folyamatstátuszok, sorrendben, két fázisba sorolva; új státusz nem jön létre", () => {
    const cols = pipelineColumns(seed());
    expect(cols.map((c) => c.status)).toEqual(PROCESS_STATUS_DEFS.map((d) => d.key));
    expect(cols.filter((c) => c.phase === "outreach").map((c) => c.status)).toEqual(["pending_outreach", "new_inquiry", "contact_in_progress", "contact_established"]);
    expect(cols.filter((c) => c.phase === "sales")).toHaveLength(7);
    expect(cols.filter((c) => c.milestone).map((c) => c.status)).toEqual(["account_opening", "account_opened", "first_deposit_verified"]);
  });
  it("üres CRM-ben minden oszlop üres: nincs fiktív kártya", () => {
    expect(total(pipelineColumns(emptySnapshot()))).toBe(0);
    expect(closedProcesses(emptySnapshot())).toHaveLength(0);
  });
  it("csak az aktív folyamatok kerülnek a kártyák közé, a lezártak külön listában vannak", () => {
    const s = seed();
    const active = s.processes.filter((p) => p.closure.state === "active");
    expect(total(pipelineColumns(s))).toBe(active.length);
    const closed = closedProcesses(s);
    expect(closed).toHaveLength(s.processes.length - active.length);
    expect(closed.every((p) => p.closure.state !== "active")).toBe(true);
  });
  it("minden kártya a folyamat tényleges státuszának oszlopában van", () => {
    for (const c of pipelineColumns(seed())) for (const p of c.processes) expect(p.status).toBe(c.status);
  });
  it("egy ügyfél több aktív folyamatánál több kártyán is megjelenik", () => {
    const r = newRepo(seed());
    const anna = byName(r.getSnapshot(), "Mintaváry");
    val(r.createProcess({ customerId: anna.id, type: "outbound_outreach", title: "Második aktív", channel: "phone", source: "existing_customer", ownerId: U, recordedBy: U }));
    const cards = pipelineColumns(r.getSnapshot()).flatMap((c) => c.processes).filter((p) => p.customerId === anna.id);
    expect(cards.length).toBeGreaterThanOrEqual(2);
    expect(new Set(cards.map((p) => p.id)).size).toBe(cards.length);
  });
});

describe("pipeline — keresés és szűrés", () => {
  const s = seed();
  it("keresés ügyfélnévre, folyamatra és a cég kapcsolattartójának nevére", () => {
    const names = (q: string) => pipelineColumns(s, { query: q }).flatMap((c) => c.processes).map((p) => p.customerId);
    expect(names("mintavary")).toContain(byName(s, "Mintaváry").id);
    expect(names("gyakorlati")).toContain(byName(s, "Minta Építő").id);
    expect(names("pékség").length).toBeGreaterThan(0);
    expect(names("nincs-ilyen-szó")).toHaveLength(0);
  });
  it("szűrés felelősre", () => {
    const cards = pipelineColumns(s, { ownerId: "user-2" }).flatMap((c) => c.processes);
    expect(cards.length).toBeGreaterThan(0);
    expect(cards.every((p) => p.ownerId === "user-2")).toBe(true);
  });
  it("a szűrő a lezárt listára is vonatkozik", () => {
    expect(closedProcesses(s, { ownerId: "user-1" }).every((p) => p.ownerId === "user-1")).toBe(true);
    expect(matchesPipelineFilter(s, s.processes[0], {})).toBe(true);
  });
});

describe("pipeline és ügyféladatlap — egyetlen adatforrás és státuszrendszer", () => {
  it("a státuszváltás azonnal átmozgatja a kártyát az új oszlopba, és naplózott", () => {
    const r = newRepo(seed());
    const bela = byName(r.getSnapshot(), "Tesztelek");
    const p = r.getSnapshot().processes.find((x) => x.customerId === bela.id)!;
    const where = (id: string) => pipelineColumns(r.getSnapshot()).find((c) => c.processes.some((x) => x.id === id))!.status;
    expect(where(p.id)).toBe("new_inquiry");
    val(r.changeProcessStatus(p.id, { toStatus: "contact_in_progress", recordedBy: U }));
    expect(where(p.id)).toBe("contact_in_progress");
    expect(r.getSnapshot().activities[0]).toMatchObject({ type: "status_change", processId: p.id, meta: { fromStatus: "new_inquiry", toStatus: "contact_in_progress" } });
  });
  it("a pipeline-ból indított váltásra is érvényes az indoklás- és igazolási kötelezettség (ugyanaz a szabály)", () => {
    const r = newRepo(seed());
    const bela = byName(r.getSnapshot(), "Tesztelek");
    const p = r.getSnapshot().processes.find((x) => x.customerId === bela.id)!;
    expect(errs(r.changeProcessStatus(p.id, { toStatus: "needs_assessment", recordedBy: U })).reason).toBeTruthy();
    expect(errs(r.changeProcessStatus(p.id, { toStatus: "account_opening", recordedBy: U, reason: "Ugrás indoklással." })).verification).toBeTruthy();
    expect(r.getSnapshot().processes.find((x) => x.id === p.id)!.status).toBe("new_inquiry");
    expect(r.changeProcessStatus(p.id, { toStatus: "account_opening", recordedBy: U, reason: "Ugrás indoklással.", verification: VERIFY }).ok).toBe(true);
  });
  it("lezárás után a kártya eltűnik a pipeline-ból, és a lezártak közé kerül", () => {
    const r = newRepo(seed());
    const bela = byName(r.getSnapshot(), "Tesztelek");
    const p = r.getSnapshot().processes.find((x) => x.customerId === bela.id)!;
    val(r.closeProcess(p.id, { outcome: "no_result", reason: "unreachable", recordedBy: U }));
    expect(pipelineColumns(r.getSnapshot()).flatMap((c) => c.processes).some((x) => x.id === p.id)).toBe(false);
    expect(closedProcesses(r.getSnapshot()).some((x) => x.id === p.id)).toBe(true);
  });
});
