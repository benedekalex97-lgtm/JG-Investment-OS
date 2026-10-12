import { describe, expect, it } from "vitest";
import { lastActivity, nextTask, overdueTasks, tasksDueToday } from "@/domain/logic";
import { NOW, byName, processOf, seed } from "./helpers";

describe("fiktív demóadat lefedettsége", () => {
  const s = seed();
  it("kizárólag fiktív e-mail-domainek és demó-ellenőrzöttség", () => {
    const emails = [...s.customers.map((c) => c.email), ...s.contacts.map((c) => c.email)].filter(Boolean) as string[];
    expect(emails.length).toBeGreaterThan(5);
    expect(emails.every((e) => e.endsWith(".example"))).toBe(true);
    expect(s.customers.every((c) => c.verificationStatus === "demo")).toBe(true);
  });
  it("új, kontaktadatbázisból származó céges kapcsolat: megkeresésre vár", () => {
    const delta = byName(s, "Delta Minta");
    const p = processOf(s, delta.id, "Kimenő");
    expect(p).toMatchObject({ type: "outbound_outreach", status: "pending_outreach", source: "contact_database" });
  });
  it("sikertelen híváskísérlet és visszahívást kérő kapcsolattartó", () => {
    const calls = s.activities.filter((a) => a.type === "call");
    expect(calls.some((a) => a.callOutcome === "not_answered")).toBe(true);
    expect(calls.some((a) => a.callOutcome === "callback_requested" && a.companyContactId)).toBe(true);
  });
  it("bejövő érdeklődő", () => {
    expect(s.processes.filter((p) => p.closure.state === "active" && p.status === "new_inquiry").map((p) => p.customerId)).toContain(byName(s, "Tesztelek").id);
  });
  it("meglévő magánszemély két külön folyamattal, a kapcsolati státusz érintetlen", () => {
    const anna = byName(s, "Mintaváry");
    expect(anna.contactStatus).toBe("existing_verified");
    const ps = s.processes.filter((p) => p.customerId === anna.id);
    expect(ps.length).toBe(2);
    expect(ps.map((p) => p.closure.state).sort()).toEqual(["active", "closed_success"]);
  });
  it("több kapcsolattartós cég; 0 kapcsolattartós cég", () => {
    expect(s.contacts.filter((k) => k.companyId === byName(s, "Minta Építő").id).length).toBeGreaterThanOrEqual(3);
    expect(s.contacts.filter((k) => k.companyId === byName(s, "Teszt Pékség").id)).toHaveLength(0);
  });
  it("konzultációs, számlanyitás folyamatban, nem finanszírozott számla és sikeres lezárás állapotok", () => {
    expect(processOf(s, byName(s, "Minta Építő").id, "Céges").status).toBe("needs_assessment");
    expect(s.processes.some((p) => p.closure.state === "active" && p.status === "account_opening")).toBe(true);
    expect(s.processes.filter((p) => p.closure.state === "active" && (p.status === "account_opened" || p.status === "awaiting_first_deposit")).length).toBeGreaterThanOrEqual(1);
    const success = s.processes.filter((p) => p.closure.state === "closed_success");
    expect(success.length).toBeGreaterThanOrEqual(1);
    for (const p of success) expect(s.activities.some((a) => a.processId === p.id && a.meta?.toStatus === "first_deposit_verified" && a.meta.verification?.simulated)).toBe(true);
  });
  it("eredmény nélkül lezárt folyamat indokkal; tiltakozás külön kezelve", () => {
    const noResult = s.processes.filter((p) => p.closure.state === "closed_no_result");
    expect(noResult.length).toBeGreaterThanOrEqual(2);
    expect(noResult.every((p) => p.closure.reason)).toBe(true);
    expect(byName(s, "Demóházi").restriction?.kind).toBe("objection");
  });
  it("a munkapult elemei élő adatból állnak", () => {
    expect(tasksDueToday(s, NOW).length).toBeGreaterThan(0);
    expect(overdueTasks(s, NOW).length).toBeGreaterThan(0);
    expect(s.processes.some((p) => p.type === "outbound_outreach" && p.closure.state === "active" && (p.status === "pending_outreach" || p.status === "contact_in_progress"))).toBe(true);
  });
  it("a napló konzisztens: minden folyamat státusza megegyezik az utolsó státuszváltás céljával", () => {
    for (const p of s.processes) {
      const changes = s.activities.filter((a) => a.processId === p.id && (a.type === "status_change" || a.type === "provider_milestone" || a.type === "process_created"));
      const latest = [...changes].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt) || 0)[0];
      expect(latest.meta?.toStatus, p.title).toBe(p.status);
    }
  });
  it("utolsó aktivitás és következő teendő számítható", () => {
    const c = byName(s, "Északi");
    expect(lastActivity(s, { customerId: c.id })).toBeTruthy();
    expect(nextTask(s, { customerId: c.id })).toBeTruthy();
  });
});
