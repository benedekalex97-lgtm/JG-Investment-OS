import { describe, expect, it, vi } from "vitest";
import { MESSAGES, RemoteRepository } from "@/data/remote";
import { emptySnapshot } from "@/domain/types";

const mk = (responses: (Response | Error)[]) => {
  const calls: { requestId: string; op: string; args: unknown }[] = [];
  const hooks = { onSnapshot: vi.fn(), onSession: vi.fn() };
  let n = 0;
  const fetcher = (async (_url: string, init: RequestInit) => {
    calls.push(JSON.parse(String(init.body)));
    const r = responses[Math.min(n++, responses.length - 1)];
    if (r instanceof Error) throw r;
    return r;
  }) as unknown as typeof fetch;
  let u = 0;
  return { repo: new RemoteRepository(hooks, fetcher, () => `00000000-0000-4000-8000-${String(++u).padStart(12, "0")}`), calls, hooks };
};
const okBody = (value: unknown) => new Response(JSON.stringify({ result: { ok: true, value }, snapshot: emptySnapshot(), replayed: false }), { status: 200 });

describe("kliensoldali repository", () => {
  it("sikeres írás: frissített snapshotot ad át, az eredményt visszaadja; nem küld rögzítőt", async () => {
    const { repo, calls, hooks } = mk([okBody({ id: "t1" })]);
    const r = await repo.closeTask("t1", { outputKey: "completed" });
    expect(r).toEqual({ ok: true, value: { id: "t1" } });
    expect(hooks.onSnapshot).toHaveBeenCalledTimes(1);
    expect(calls[0]).toMatchObject({ op: "task.close", args: { taskId: "t1", input: { outputKey: "completed" } } });
    expect(JSON.stringify(calls[0])).not.toMatch(/recordedBy|assigneeId/);
  });
  it("érvényesítési hiba (ok:false) a szervertől változatlanul megérkezik, a kérés-azonosító új lesz", async () => {
    const bad = new Response(JSON.stringify({ result: { ok: false, errors: { outputKey: "Az Output kiválasztása kötelező" } }, snapshot: emptySnapshot(), replayed: false }), { status: 200 });
    const { repo, calls } = mk([bad, okBody({})]);
    expect(await repo.closeTask("t1", {})).toEqual({ ok: false, errors: { outputKey: "Az Output kiválasztása kötelező" } });
    await repo.closeTask("t1", {});
    expect(calls[0].requestId).not.toBe(calls[1].requestId);
  });
  it("hálózati hiba érthető üzenet; az azonos művelet újrapróbálása ugyanazt a kérés-azonosítót használja (nincs duplikátum)", async () => {
    const { repo, calls, hooks } = mk([new TypeError("fetch failed"), okBody({})]);
    const input = { type: "individual", name: "Teszt" };
    expect(await repo.createCustomerFromForm(input)).toEqual({ ok: false, errors: { _form: MESSAGES.network } });
    expect(hooks.onSnapshot).not.toHaveBeenCalled();
    await repo.createCustomerFromForm(input);
    expect(calls[1].requestId).toBe(calls[0].requestId);
    await repo.createCustomerFromForm(input);
    expect(calls[2].requestId).not.toBe(calls[0].requestId);
  });
  it("500: szerverhiba üzenet, azonosító megmarad; 503: adatbázis nem elérhető + jelzés; 401: munkamenet lejárt + jelzés", async () => {
    const { repo, calls, hooks } = mk([new Response("{}", { status: 500 }), new Response("{}", { status: 503 }), new Response("{}", { status: 401 })]);
    expect(await repo.reopenTask("t1")).toEqual({ ok: false, errors: { _form: MESSAGES.server } });
    expect(await repo.reopenTask("t1")).toEqual({ ok: false, errors: { _form: MESSAGES.unavailable } });
    expect(hooks.onSession).toHaveBeenCalledWith("unavailable");
    expect(await repo.reopenTask("t1")).toEqual({ ok: false, errors: { _form: MESSAGES.session } });
    expect(hooks.onSession).toHaveBeenCalledWith("unauthenticated");
    expect(new Set(calls.map((c) => c.requestId)).size).toBe(1);
  });
  it("csak a megnevezett API-műveleteket hívja", async () => {
    const { repo, calls } = mk([okBody({})]);
    await repo.createCustomerFromForm({}); await repo.updateCustomer("c", {}); await repo.changeCrmStatus("c", {});
    await repo.createTask({}); await repo.closeTask("t", {}); await repo.reopenTask("t"); await repo.setTaskDue("t", null);
    expect(calls.map((c) => c.op)).toEqual(["customer.create", "customer.update", "customer.changeStatus", "task.create", "task.close", "task.reopen", "task.setDue"]);
  });
});
