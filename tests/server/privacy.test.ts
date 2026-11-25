import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { checkSchema, migrate, MIGRATIONS } from "@/server/db/migrate";
import { restoreCustomer } from "@/server/admin";
import { createUser } from "@/server/auth/service";
import { exportBackup, restoreBackup } from "@/server/backup";
import { revokePermission } from "@/server/data/permissions";
import { suppressionHash } from "@/server/privacy/privacy";
import { erasureLedger, reapplyErasures, technicalRetention } from "@/server/privacy/retention-ops";
import { addMonths, dueState, ERASE_CONFIRMATION_WORD, requestDueAt } from "@/domain/privacy";
import type { Customer, DataSnapshot, Task } from "@/domain/types";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type Client, type TestDb } from "./helpers";
import { OPERATOR, baseOptions, csv, grant, uploader } from "./data-helpers";

/**
 * v1.3 adatvédelem (GDPR 12-21. cikk) valódi PostgreSQL-en: jogosultság, érintetti kérelmek, hozzáférési kivonat, tiltakozás,
 * végleges anonimizálás, tiltólista (import és kézi felvitel), megőrzés, mentés/visszaállítás. Kizárólag fiktív adat.
 */
const T0 = new Date("2026-11-20T09:00:00.000Z");

describe("határidő-számítás (12. cikk (3))", () => {
  it("egy hónap, hónap végén a hónap utolsó napjára; meghosszabbítva három hónap", () => {
    expect(requestDueAt(new Date("2026-01-31T12:00:00Z")).toISOString()).toBe("2026-02-28T12:00:00.000Z");
    expect(addMonths(new Date("2026-01-31T12:00:00Z"), 3).toISOString()).toBe("2026-04-30T12:00:00.000Z");
    expect(dueState("open", "2026-11-01T00:00:00Z", T0)).toBe("overdue");
    expect(dueState("open", "2026-11-25T00:00:00Z", T0)).toBe("due_soon");
    expect(dueState("in_progress", "2026-12-31T00:00:00Z", T0)).toBe("ok");
    expect(dueState("completed", "2026-11-01T00:00:00Z", T0)).toBe("closed");
  });
  it("a tiltólista-lenyomat az erős duplikációs kulccsal normalizál (06 / +36, kis-nagybetű)", () => {
    expect(suppressionHash("phone", "06 30 000 1111")).toBe(suppressionHash("phone", "+36-30-000-1111"));
    expect(suppressionHash("email", " Valaki@Example.TEST ")).toBe(suppressionHash("email", "valaki@example.test"));
    expect(suppressionHash("email", "nem-email")).toBeNull();
    expect(suppressionHash("phone", "123")).toBeNull();
  });
});

describe.each(DRIVERS)("adatvédelem (%s)", (kind) => {
  let t: TestDb;
  let handle: (r: Request) => Promise<Response>;
  let dpo: Client, worker: Client, helper: Client;
  let dpoId = "", workerId = "";
  const prevFlag = process.env.JG_CUSTOMER_IMPORT_ENABLED;

  beforeAll(async () => {
    process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
    t = await makeTestDb(kind);
    const u = await addPilotUsers(t.db);
    dpoId = u.a.id;
    workerId = u.b.id;
    await grant(t.db, "pilot.egy@example.test", "crm.privacy.manage", "crm.privacy.erase", "crm.customer.import");
    handle = makeApi(t.db, "local", () => T0);
    dpo = client(handle);
    worker = client(handle);
    await dpo.login("pilot.egy@example.test", PASSWORD_A);
    await worker.login("pilot.ketto@example.test", PASSWORD_B);
    // Négy-szem elv: az adatvédelmi helyettes rögzíti a törlési kérelmet, a törlési jogú vezető hajtja végre.
    await createUser(t.db, { email: "pilot.harom@example.test", name: "Teszt Helyettes", password: PASSWORD_A });
    await grant(t.db, "pilot.harom@example.test", "crm.privacy.manage");
    helper = client(handle);
    await helper.login("pilot.harom@example.test", PASSWORD_A);
  });
  afterAll(async () => {
    if (prevFlag === undefined) delete process.env.JG_CUSTOMER_IMPORT_ENABLED; else process.env.JG_CUSTOMER_IMPORT_ENABLED = prevFlag;
    await t.cleanup();
  });

  const raw = <T = Record<string, unknown>>(sql: string, p: unknown[] = []) => t.db.system((tx) => tx.query<T & Record<string, unknown>>(sql, p));
  const body = async (r: Response) => (await r.json()) as Record<string, unknown> & { message?: string; error?: string };
  let seq = 0;
  const phone = () => `+36 1 444 ${String(1000 + ++seq)}`;

  /** Teljes adattartalmú fiktív cég: kapcsolattartó, jegyzet, feladat Outputtal, státuszváltás, csatorna-részlet. */
  const seedCompany = async (name: string, contactEmail = `kapcs${++seq}@example.test`) => {
    const p = phone();
    const created = (await dpo.op<{ customer: Customer }>("customer.create", { input: { type: "company", acquisitionChannel: "ajanlas", acquisitionDetail: "Ajánlotta: Fiktív Ferenc", companyName: name, contactName: "Kapcsolat Kata", phone: p, email: contactEmail, source: "Fiktív névjegy Kata" } })).body;
    if (!created.result.ok) throw new Error(JSON.stringify(created.result));
    const cust = created.result.value!.customer;
    const task = (await dpo.op<Task>("task.create", { input: { customerId: cust.id, taskType: "phone_call", inputKey: "other", inputNote: "Kata kérte, hogy délután hívjuk" } })).body.result.value!;
    await dpo.op("task.close", { taskId: task.id, input: { outcome: "success", output: "Kata elmondta a magánéleti részleteit" } });
    await dpo.op("note.create", { customerId: cust.id, text: "Kata személyes jegyzete: allergiás a mogyoróra" });
    await dpo.op("customer.changeStatus", { customerId: cust.id, input: { toStatus: "contact" } });
    return { cust, task, phone: p, email: contactEmail };
  };
  const newRequest = async (c: Client, input: Record<string, unknown>) => {
    const r = await c.post("/api/privacy/requests", { channel: "email", receivedOn: "2026-11-18", ...input });
    return { status: r.status, body: (await r.json()) as { request?: { id: string; version: number; dueAt: string; status: string; customerName: string | null }; message?: string; error?: string } };
  };

  it("PV01: jog nélkül minden adatvédelmi végpont 403, az elutasítás naplózódik; bejelentkezés nélkül 401", async () => {
    for (const [m, path] of [["GET", "/api/privacy/requests"], ["GET", "/api/privacy/overview"], ["GET", "/api/privacy/retention"], ["POST", "/api/privacy/requests"], ["POST", "/api/privacy/report"], ["POST", "/api/privacy/restriction"], ["POST", "/api/privacy/erase"]] as const) {
      const r = m === "GET" ? await worker.get(path) : await worker.post(path, {});
      expect(r.status, path).toBe(403);
    }
    expect((await raw("select count(*)::int as n from audit_events where user_id = $1 and action = 'privacy.denied'", [workerId]))[0].n).toBe(7);
    expect((await client(handle).get("/api/privacy/requests")).status).toBe(401);
    // Az adatbázis is tilt: a munkatárs a táblát sem látja, a függvényeket sem futtathatja.
    expect(await t.db.asUser(workerId, (tx) => tx.query("select * from privacy_requests"))).toEqual([]);
    await expect(t.db.asUser(workerId, (tx) => tx.query("select app_privacy_erase_customer('x', 'pr-0000000000000000', '[]'::jsonb)"))).rejects.toThrow(/jg:forbidden/);
    // CSRF: idegen eredetű kérés elutasítva.
    expect((await dpo.post("/api/privacy/requests", {}, { origin: "https://evil.example" })).status).toBe(403);
  });

  it("PV02: kérelem rögzítése, határidő, meghosszabbítás egyszer, lezárás indoklással; a lezárt kérelem végleges", async () => {
    const { cust } = await seedCompany("Kérelmező Kft.");
    const created = await newRequest(dpo, { kind: "rectification", customerId: cust.id });
    expect(created.status).toBe(201);
    const req = created.body.request!;
    expect(req).toMatchObject({ status: "open", customerName: "Kérelmező Kft.", dueAt: "2026-12-18T12:00:00.000Z" });
    // Ügyfél vagy érintett-megnevezés nélkül nem rögzíthető; jövőbeli beérkezés sem.
    expect((await newRequest(dpo, { kind: "access" })).status).toBe(400);
    expect((await newRequest(dpo, { kind: "access", subjectLabel: "X. Y.", receivedOn: "2027-01-01" })).status).toBe(400);
    const ext = await dpo.patch("/api/privacy/requests", { id: req.id, version: req.version, extend: true, outcomeNote: "Összetett kérelem, meghosszabbítva" });
    const extended = (await body(ext)).request as { version: number; dueAt: string; extended: boolean };
    expect(extended).toMatchObject({ extended: true, dueAt: "2027-02-18T12:00:00.000Z" });
    expect((await dpo.patch("/api/privacy/requests", { id: req.id, version: extended.version, extend: true })).status).toBe(409);
    // Elavult verzió: 409.
    expect((await dpo.patch("/api/privacy/requests", { id: req.id, version: 1, status: "in_progress" })).status).toBe(409);
    const done = await dpo.patch("/api/privacy/requests", { id: req.id, version: extended.version, status: "completed" });
    expect(done.status).toBe(200);
    expect(((await body(done)).request as { status: string; closedBy: string }).status).toBe("completed");
    const [row] = await raw<{ version: number }>("select version from privacy_requests where id = $1", [req.id]);
    expect((await dpo.patch("/api/privacy/requests", { id: req.id, version: row.version, status: "open" })).status).toBe(409);
    // A DB is véd: a lezárt kérelem az alkalmazás szerepköréből nem módosítható, az azonosító mezők sem.
    await expect(t.db.asUser(dpoId, (tx) => tx.query("update privacy_requests set outcome_note = 'x' where id = $1", [req.id]))).rejects.toThrow(/jg:request_closed/);
    const other = (await newRequest(dpo, { kind: "access", subjectLabel: "Nem ügyfél N." })).body.request!;
    await expect(t.db.asUser(dpoId, (tx) => tx.query("update privacy_requests set kind = 'erasure' where id = $1", [other.id]))).rejects.toThrow(/jg:protected_field/);
    await expect(t.db.asUser(dpoId, (tx) => tx.query("delete from privacy_requests where id = $1", [other.id]))).rejects.toThrow();
    // Törlési kérelem nem zárható „teljesítve” anonimizálás nélkül.
    const er = (await newRequest(dpo, { kind: "erasure", customerId: cust.id })).body.request!;
    expect((await dpo.patch("/api/privacy/requests", { id: er.id, version: er.version, status: "completed", outcomeNote: "x" })).status).toBe(409);
    const list = (await body(await dpo.get("/api/privacy/requests?status=open_all"))).requests as { id: string }[];
    expect(list.map((x) => x.id)).toEqual(expect.arrayContaining([other.id, er.id]));
    expect(list.map((x) => x.id)).not.toContain(req.id);
    const audit = await raw<{ action: string; detail: unknown }>("select action, detail from audit_events where entity_id = $1 order by id", [req.id]);
    expect(audit.map((a) => a.action)).toEqual(["privacy.request.create", "privacy.request.update", "privacy.request.update"]);
    expect(JSON.stringify(audit)).not.toContain("meghosszabbítva");
  });

  it("PV03: hozzáférési kivonat (15./20. cikk) - teljes adattartalom, csak hozzáférési kérelemmel, naplózva; eltávolított ügyfélnél is", async () => {
    const { cust, email } = await seedCompany("Kivonat Kft.");
    const acc = (await newRequest(dpo, { kind: "portability", customerId: cust.id, identityVerified: true })).body.request!;
    const res = await dpo.post("/api/privacy/report", { requestId: acc.id });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/^attachment; filename="JG_Adatkivonat_pr-[0-9a-f]{16}_2026-11-20\.json"$/);
    expect(res.headers.get("cache-control")).toContain("no-store");
    const rep = (await res.json()) as Record<string, unknown> & { subject: Record<string, unknown>; contacts: { email: string }[]; tasks: { outputs: { text: string }[]; inputNote: string }[]; history: { summary: string }[]; accessLog: unknown[]; processing: { purposes: string[] } };
    expect(rep).toMatchObject({ format: "jg-os-gdpr-access-report", requestKind: "portability", controller: "JG Investment Plus Kft." });
    expect(rep.subject).toMatchObject({ name: "Kivonat Kft.", acquisitionChannel: "Ajánlás (ügyfél vagy ismerős)", acquisitionDetail: "Ajánlotta: Fiktív Ferenc", owner: "Teszt Pilot Egy" });
    expect(rep.subject.email).toBe(email);
    expect(rep.contacts[0]).toMatchObject({ lastName: "Kapcsolat", firstName: "Kata", primary: true });
    expect(rep.tasks[0].outputs[0].text).toContain("magánéleti");
    expect(rep.tasks[0].inputNote).toContain("délután");
    expect(rep.history.map((h) => h.summary).join(" ")).toContain("mogyoró");
    expect(rep.accessLog.length).toBeGreaterThan(0);
    expect(rep.processing.purposes.length).toBeGreaterThan(0);
    expect(JSON.stringify(rep)).not.toMatch(/password|token_hash|scrypt/i);
    expect((await raw("select detail from audit_events where action = 'privacy.access_report' and entity_id = $1", [acc.id]))[0].detail).toMatchObject({ kind: "portability", tasks: 1 });
    // Nem hozzáférési kérelemmel nem készül kivonat.
    const rect = (await newRequest(dpo, { kind: "rectification", customerId: cust.id })).body.request!;
    expect((await dpo.post("/api/privacy/report", { requestId: rect.id })).status).toBe(409);
    // Eltávolított (soft delete) ügyfélnél is elkészül.
    await raw("update customers set deleted_at = now(), deleted_by = $2 where id = $1", [cust.id, dpoId]);
    const rep2 = await dpo.post("/api/privacy/report", { requestId: acc.id });
    expect(((await rep2.json()) as { subject: { removedFromActiveCrmAt: string | null } }).subject.removedFromActiveCrmAt).not.toBeNull();
  });

  it("PV04: tiltakozás rögzítése - kimenő megkeresés tilos, nem írható felül, elérhetőség tiltólistán, kérelem lezárva", async () => {
    const { cust, phone: p, email } = await seedCompany("Tiltakozó Kft.");
    const obj = (await newRequest(dpo, { kind: "objection", customerId: cust.id, channel: "phone" })).body.request!;
    // Munkatárs nem rögzíthet.
    expect((await worker.post("/api/privacy/restriction", { customerId: cust.id, kind: "objection", note: "x" })).status).toBe(403);
    expect((await dpo.post("/api/privacy/restriction", { customerId: cust.id, kind: "objection", note: "" })).status).toBe(400);
    const r = await dpo.post("/api/privacy/restriction", { customerId: cust.id, kind: "objection", note: "Telefonon kérte, hogy többé ne keressük", requestId: obj.id });
    expect(r.status).toBe(200);
    const snap = ((await (await dpo.get("/api/crm/snapshot")).json()) as { snapshot: DataSnapshot }).snapshot;
    expect(snap.customers.find((c) => c.id === cust.id)?.restriction).toMatchObject({ kind: "objection", recordedBy: dpoId });
    expect(snap.activities.some((a) => a.customerId === cust.id && a.type === "restriction_change")).toBe(true);
    expect((await raw("select status from privacy_requests where id = $1", [obj.id]))[0].status).toBe("completed");
    expect(Number((await raw("select count(*) as n from privacy_suppressions where reason = 'objection' and request_id = $1", [obj.id]))[0].n)).toBe(2);
    // Másodszor nem rögzíthető (nem írható felül).
    expect((await dpo.post("/api/privacy/restriction", { customerId: cust.id, kind: "restriction", note: "felülírás" })).status).toBe(409);
    // A tiltólistás elérhetőség új ügyfélként: munkatársnak tiltva, az adatvédelmi felelős tudatos megerősítéssel rögzítheti.
    const w = await worker.op("customer.create", { input: { type: "individual", acquisitionChannel: "egyeb", name: "Új Név", phone: p.replace("+36 ", "06 ") } });
    expect(w.body.result).toMatchObject({ ok: false, errors: { _suppressed: expect.stringMatching(/tiltólistán.*adatvédelmi felelős/) } });
    const w2 = await worker.op("customer.create", { input: { type: "individual", acquisitionChannel: "egyeb", name: "Új Név", email: email.toUpperCase() }, confirmSuppression: true });
    expect(w2.body.result.ok).toBe(false);
    const d = await dpo.op<{ customer: Customer }>("customer.create", { input: { type: "individual", acquisitionChannel: "egyeb", name: "Visszatérő Vilma", email }, confirmSuppression: true, confirmDuplicates: true });
    expect(d.body.result.ok).toBe(true);
    expect((await raw("select detail from audit_events where action = 'customer.create' and entity_id = $1", [d.body.result.value!.customer.id]))[0].detail).toMatchObject({ suppressionConfirmed: true });
  });

  it("PV05: végleges anonimizálás - minden szabad szöveg és elérhetőség eltűnik, a szerkezet és a napló marad, tiltólista, visszaállíthatatlan", async () => {
    const { cust, task, phone: p, email } = await seedCompany("Törlendő Kft.");
    // Négy-szem elv: aki a törlési kérelmet rögzítette, az (törlési jog birtokában sem) hajthatja végre; a DB is kikényszeríti.
    const own = (await newRequest(dpo, { kind: "erasure", customerId: cust.id, identityVerified: true })).body.request!;
    const ownRes = await dpo.post("/api/privacy/erase", { requestId: own.id, confirmation: ERASE_CONFIRMATION_WORD });
    expect(ownRes.status).toBe(409);
    expect((await body(ownRes)).message).toMatch(/Négy-szem elv/);
    await expect(t.db.asUser(dpoId, (tx) => tx.query("select app_privacy_erase_customer($1, $2, '[]'::jsonb)", [cust.id, own.id]))).rejects.toThrow(/jg:four_eyes/);
    expect((await raw("select erased_at from customers where id = $1", [cust.id]))[0].erased_at).toBeNull();
    const req = (await newRequest(helper, { kind: "erasure", customerId: cust.id, subjectLabel: "Törlendő Kft. ügyvezetője" })).body.request!;
    // Feltételek: azonosítás, megerősítő szó, jog.
    expect((await dpo.post("/api/privacy/erase", { requestId: req.id, confirmation: ERASE_CONFIRMATION_WORD })).status).toBe(409);
    await dpo.patch("/api/privacy/requests", { id: req.id, version: req.version, identityVerified: true });
    expect((await dpo.post("/api/privacy/erase", { requestId: req.id, confirmation: "törlés" })).status).toBe(400);
    expect((await worker.post("/api/privacy/erase", { requestId: req.id, confirmation: ERASE_CONFIRMATION_WORD })).status).toBe(403);
    // A közvetlen adatbázis-írás sem kerüli meg: az alkalmazás szerepköre nem jelölheti anonimizáltnak.
    await expect(t.db.asUser(dpoId, (tx) => tx.query("update customers set erased_at = now(), erased_by = $2, deleted_at = now(), deleted_by = $2 where id = $1", [cust.id, dpoId]))).rejects.toThrow(/forbidden/);

    const res = await dpo.post("/api/privacy/erase", { requestId: req.id, confirmation: ` ${ERASE_CONFIRMATION_WORD} ` });
    expect(res.status).toBe(200);
    expect((await body(res)).counts).toMatchObject({ contacts: 1, tasks: 1, taskResults: 1, suppressions: 2 });

    const dump = JSON.stringify(await t.db.system(async (tx) => ({
      c: await tx.query("select * from customers where id = $1", [cust.id]),
      k: await tx.query("select * from company_contacts where company_id = $1", [cust.id]),
      a: await tx.query("select * from activities where customer_id = $1", [cust.id]),
      t: await tx.query("select * from tasks where customer_id = $1", [cust.id]),
      r: await tx.query("select * from task_results where task_id = $1", [task.id]),
      // Az idempotencia-napló e kérés-ügyfélhez tartozó (korábban teljes ügyféladatot tároló) válaszai.
      l: await tx.query("select * from request_log where request_id in (select request_id from request_log where response::text like '%erased%')"),
      e: await tx.query("select * from audit_events where customer_id = $1", [cust.id]),
      p: await tx.query("select * from privacy_requests where customer_id = $1", [cust.id]),
    })));
    const at = (s: string) => dump.slice(Math.max(0, dump.indexOf(s) - 200), dump.indexOf(s) + 50);
    for (const pii of ["Törlendő Kft.", "Kata", "mogyoró", "magánéleti", "délután", "Fiktív Ferenc", p, email, p.replace(/\D/g, "")]) expect(dump, at(pii)).not.toContain(pii);
    expect(Number((await raw("select count(*) as n from request_log where response::text like $1", [`%${cust.id}%`]))[0].n)).toBe(0);
    expect(Number((await raw("select count(*) as n from request_log where response = '{\"ok\":false,\"erased\":true}'::jsonb"))[0].n)).toBeGreaterThanOrEqual(5);
    const [c] = await raw("select company_name, email, phone, source, acquisition_detail, deleted_at, erased_at, erased_by from customers where id = $1", [cust.id]);
    expect(c).toMatchObject({ company_name: "Törölt ügyfél", email: null, phone: null, source: "", acquisition_detail: null, erased_by: dpoId });
    expect(c.deleted_at).not.toBeNull();
    // A kérelem teljesítve; a napló (személyes adat nélkül) megmarad.
    expect((await raw("select status, subject_label, closed_by from privacy_requests where id = $1", [req.id]))[0]).toEqual({ status: "completed", subject_label: null, closed_by: dpoId });
    expect((await raw("select count(*)::int as n from audit_events where customer_id = $1 and action = 'privacy.erase'", [cust.id]))[0].n).toBe(1);
    // Az aktív CRM-ben nem látszik, nem módosítható, nem állítható vissza, nem anonimizálható újra.
    const snap = ((await (await dpo.get("/api/crm/snapshot")).json()) as { snapshot: DataSnapshot }).snapshot;
    expect(snap.customers.some((x) => x.id === cust.id)).toBe(false);
    await expect(t.db.asUser(dpoId, (tx) => tx.query("update customers set notes = 'vissza' where id = $1", [cust.id]))).rejects.toThrow(/jg:erased/);
    await grant(t.db, "pilot.egy@example.test", "crm.customer.delete");
    await expect(t.db.asUser(dpoId, (tx) => tx.query("update customers set deleted_at = null, deleted_by = null where id = $1", [cust.id]))).rejects.toThrow(/jg:erased/);
    expect(await restoreCustomer(t.db, cust.id, "pilot.egy@example.test")).toEqual({ restored: false });
    const again = (await newRequest(dpo, { kind: "erasure", customerId: cust.id, identityVerified: true })).body.request!;
    expect((await dpo.post("/api/privacy/erase", { requestId: again.id, confirmation: ERASE_CONFIRMATION_WORD })).status).toBe(409);
    // Hozzáférési kivonat az anonimizált ügyfélről nem készül (nincs adat).
    const acc = (await newRequest(dpo, { kind: "access", customerId: cust.id })).body.request!;
    expect((await dpo.post("/api/privacy/report", { requestId: acc.id })).status).toBe(409);
    // A tiltólista miatt az import a korábbi elérhetőséget elutasítja, egyezés (és nyers adat) nélkül is.
    const A = uploader(handle, dpo);
    const map = ["type", "fullName", "companyName", "phone", "email", "contactName", "status"];
    const file = csv([["Ügyféltípus", "Név", "Cégnév", "Telefon", "E-mail", "Kapcsolattartó", "Státusz"], ["Magánszemély", "Más Név", "", p, "", "", ""], ["Magánszemély", "Tiszta Tamás", "", "", "tamas@example.test", "", ""]]);
    const pv = await A.upload("/api/data/import/preview", file, baseOptions(map));
    const rows = (pv.body as unknown as { rows: { state: string; issues: { code: string }[] }[] }).rows;
    expect(rows[0].state).toBe("R");
    expect(rows[0].issues.map((i) => i.code)).toEqual(["suppressed"]);
    expect(rows[1].state).toBe("V");
  });

  it("PV06: megőrzési felülvizsgálat - inaktív és régen eltávolított ügyfelek; anonimizált nem; automatikus törlés nincs", async () => {
    const old = await seedCompany("Régi Inaktív Kft.");
    await raw("update customers set created_at = '2023-01-01', updated_at = '2023-01-01' where id = $1", [old.cust.id]);
    await raw("update activities set occurred_at = '2023-01-02' where customer_id = $1", [old.cust.id]);
    await raw("update tasks set created_at = '2023-01-02', completed_at = '2023-01-03' where customer_id = $1", [old.cust.id]);
    const removed = await seedCompany("Régen Eltávolított Kft.");
    await raw("update customers set deleted_at = '2026-01-01', deleted_by = $2 where id = $1", [removed.cust.id, dpoId]);
    // Státuszfüggő rend: „Elvesztett” 12 hónap után; a szerződéses (mérföldkő) ügyfél nem kerül az inaktivitási felülvizsgálatba.
    const ageTo = async (id: string, at: string) => {
      await raw("update customers set created_at = $2, updated_at = $2 where id = $1", [id, at]);
      await raw("update activities set occurred_at = $2 where customer_id = $1", [id, at]);
      await raw("update tasks set created_at = $2, completed_at = $2 where customer_id = $1", [id, at]);
    };
    const lostOld = await seedCompany("Régen Elvesztett Kft.");
    await raw("update customers set crm_status = 'lost' where id = $1", [lostOld.cust.id]);
    await ageTo(lostOld.cust.id, "2025-10-01");
    const lostNew = await seedCompany("Nemrég Elvesztett Kft.");
    await raw("update customers set crm_status = 'lost' where id = $1", [lostNew.cust.id]);
    await ageTo(lostNew.cust.id, "2026-06-01");
    const client3y = await seedCompany("Szerződéses Ügyfél Kft.");
    await raw("update customers set crm_status = 'capital_placed' where id = $1", [client3y.cust.id]);
    await ageTo(client3y.cust.id, "2023-01-01");
    const r = (await body(await dpo.get("/api/privacy/retention"))) as { settings: { inactiveMonths: number }; candidates: { customerId: string; reason: string; name: string }[] };
    expect(r.settings.inactiveMonths).toBe(24);
    expect(r.candidates).toEqual(expect.arrayContaining([
      expect.objectContaining({ customerId: old.cust.id, reason: "inactive" }),
      expect.objectContaining({ customerId: removed.cust.id, reason: "removed", name: "Régen Eltávolított Kft." }),
    ]));
    expect(r.candidates).toEqual(expect.arrayContaining([expect.objectContaining({ customerId: lostOld.cust.id, reason: "lost" })]));
    expect(r.candidates.map((c) => c.customerId)).not.toContain(lostNew.cust.id);
    expect(r.candidates.map((c) => c.customerId)).not.toContain(client3y.cust.id);
    expect(r.candidates.some((c) => c.name === "Törölt ügyfél")).toBe(false);
    expect((await raw("select count(*)::int as n from customers where id = any($1) and erased_at is null", [[old.cust.id, removed.cust.id]]))[0].n).toBe(2);
    const ov = await body(await dpo.get("/api/privacy/overview"));
    expect(ov).toMatchObject({ canErase: true });
    expect(Number(ov.open)).toBeGreaterThan(0);
  });

  it("PV07: visszavont jog azonnal hat; a felhasználókezelő a felületen is kioszthatja az adatvédelmi jogokat", async () => {
    await revokePermission(t.db, { email: "pilot.egy@example.test", permission: "crm.privacy.erase", operator: OPERATOR, env: "local" });
    const req = (await newRequest(dpo, { kind: "erasure", subjectLabel: "Valaki", identityVerified: true })).body.request!;
    expect((await dpo.post("/api/privacy/erase", { requestId: req.id, confirmation: ERASE_CONFIRMATION_WORD })).status).toBe(403);
    expect(((await (await dpo.get("/api/auth/me")).json()) as { permissions: string[] }).permissions).toEqual(expect.arrayContaining(["crm.privacy.manage"]));
    await grant(t.db, "pilot.egy@example.test", "crm.users.manage");
    const r = await t.db.asUser(dpoId, (tx) => tx.query<{ r: string }>("select app_admin_set_permission($1, 'crm.privacy.manage', true) as r", [workerId]));
    expect(r[0].r).toBe("granted");
    expect((await worker.get("/api/privacy/requests")).status).toBe(200);
    await t.db.asUser(dpoId, (tx) => tx.query("select app_admin_set_permission($1, 'crm.privacy.manage', false)", [workerId]));
    expect((await worker.get("/api/privacy/requests")).status).toBe(403);
    await grant(t.db, "pilot.egy@example.test", "crm.privacy.erase");
  });

  it("PV08: technikai megőrzés (CLI) - csak lejárt technikai rekordok; előnézet nem ír; üzemeltető nélkül nem fut", async () => {
    await raw("insert into sessions (token_hash, user_id, expires_at, last_seen_at) values ('lejart', $1, now() - interval '1 day', now() - interval '2 days')", [workerId]);
    await raw("insert into request_log (request_id, user_id, op, response, created_at) values ('00000000-0000-4000-8000-000000000001', $1, 'note.create', '{}'::jsonb, now() - interval '90 days')", [workerId]);
    const settings = { inactiveMonths: 24, lostMonths: 12, removedMonths: 6, requestLogDays: 30 };
    const pre = await technicalRetention(t.db, { env: "local", settings, apply: false });
    expect(pre).toMatchObject({ applied: false, counts: { sessions: 1, requestLog: 1 } });
    await expect(technicalRetention(t.db, { env: "local", settings, apply: true })).rejects.toThrow(/JG_OPERATOR/);
    await expect(technicalRetention(t.db, { env: "production", settings, apply: true, operator: OPERATOR })).rejects.toThrow();
    const customersBefore = (await raw("select count(*)::int as n from customers"))[0].n;
    const done = await technicalRetention(t.db, { env: "local", settings, apply: true, operator: OPERATOR });
    expect(done.counts.sessions).toBe(1);
    expect((await raw("select count(*)::int as n from sessions where token_hash = 'lejart'"))[0].n).toBe(0);
    expect((await raw("select count(*)::int as n from customers"))[0].n).toBe(customersBefore);
    // A bejelentkezett munkamenetek érvényesek maradnak.
    expect((await dpo.get("/api/auth/me")).status).toBe(200);
    expect((await raw("select operation from ops_log order by id desc limit 1"))[0].operation).toBe("retention.technical");
  });

  it("PV09: mentés/visszaállítás - az új táblák a mentés részei; régebbi mentés után a törlési napló újra anonimizál", async () => {
    // Mentés a v1.3 állapotról, majd visszaállítás üres adatbázisba: a kérelmek és a tiltólista is visszaáll.
    const b = await exportBackup(t.db, "local");
    expect(b.counts.privacy_requests).toBeGreaterThan(0);
    expect(b.counts.privacy_suppressions).toBeGreaterThan(0);
    const target = await makeTestDb(kind);
    try {
      const counts = await restoreBackup(target.db, b, "local");
      expect(counts.privacy_requests).toBe(b.counts.privacy_requests);
      expect(counts.privacy_suppressions).toBe(b.counts.privacy_suppressions);
    } finally {
      await target.cleanup();
    }
    // Régebbi (anonimizálás előtti) mentés: a ledger szerinti újra-anonimizálás megakadályozza, hogy a törölt adat feléledjen.
    const victim = await seedCompany("Később Törölt Kft.");
    const before = await exportBackup(t.db, "local");
    const req = (await newRequest(helper, { kind: "erasure", customerId: victim.cust.id, identityVerified: true })).body.request!;
    expect((await dpo.post("/api/privacy/erase", { requestId: req.id, confirmation: ERASE_CONFIRMATION_WORD })).status).toBe(200);
    const ledger = await erasureLedger(t.db, "local");
    expect(ledger.customerIds).toContain(victim.cust.id);
    expect(JSON.stringify(ledger)).not.toContain("Törölt Kft");
    const old = await makeTestDb(kind);
    try {
      await restoreBackup(old.db, before, "local");
      expect((await old.db.system((tx) => tx.query("select company_name from customers where id = $1", [victim.cust.id])))[0].company_name).toBe("Később Törölt Kft.");
      await expect(reapplyErasures(old.db, { env: "local", customerIds: ledger.customerIds, operatorEmail: "pilot.egy@example.test", operator: "" })).rejects.toThrow(/JG_OPERATOR/);
      const r = await reapplyErasures(old.db, { env: "local", customerIds: [...ledger.customerIds, "nincs-ilyen"], operatorEmail: "pilot.egy@example.test", operator: OPERATOR });
      expect(r.erased).toContain(victim.cust.id);
      expect(r.missing).toBe(1);
      expect((await old.db.system((tx) => tx.query("select company_name, erased_at from customers where id = $1", [victim.cust.id])))[0].company_name).toBe("Törölt ügyfél");
      const again = await reapplyErasures(old.db, { env: "local", customerIds: ledger.customerIds, operatorEmail: "pilot.egy@example.test", operator: OPERATOR });
      expect(again.erased).toEqual([]);
    } finally {
      await old.cleanup();
    }
  });
});

describe.each(DRIVERS)("v1.3 séma-visszagörgetés (%s)", (kind) => {
  it("RB01: adatvédelmi adat mellett megáll és semmi nem változik; tudatos vállalással a v1.2 sémára áll vissza; újra előre alkalmazható", async () => {
    const t = await makeTestDb(kind);
    const sql13 = readFileSync(join(__dirname, "../../scripts/sql/v1.3-schema-rollback.sql"), "utf8").replace(/^begin;$/m, "").replace(/^commit;$/m, "");
    try {
      const { a } = await addPilotUsers(t.db);
      await t.db.system((tx) => tx.query("insert into customers (id, type, display_name, owner_id, created_at, updated_at) values ('c-1','individual','Rita',$1,now(),now())", [a.id]));
      await t.db.system((tx) => tx.query("insert into privacy_requests (id, kind, customer_id, channel, received_at, due_at, created_by, updated_by) values ('pr-0000000000000001','access','c-1','email',now(),now() + interval '1 month',$1,$1)", [a.id]));
      const before = await t.db.system((tx) => tx.query("select id, display_name, deleted_at from customers"));
      await expect(t.db.system((tx) => tx.exec(sql13))).rejects.toThrow(/adatvédelmi rekord/);
      expect(await checkSchema(t.db, "local")).toEqual({ ok: true });
      await t.db.system(async (tx) => { await tx.query("select set_config('jg.rollback_discard_privacy', 'yes', true)"); await tx.exec(sql13); });
      expect(await checkSchema(t.db, "local", MIGRATIONS.slice(0, 11))).toEqual({ ok: true });
      expect(await t.db.system((tx) => tx.query("select to_regclass('privacy_requests') as a, to_regclass('privacy_suppressions') as b"))).toEqual([{ a: null, b: null }]);
      expect(await t.db.system((tx) => tx.query("select count(*)::int as n from information_schema.columns where table_name = 'customers' and column_name like 'erased%'"))).toEqual([{ n: 0 }]);
      expect(await t.db.system((tx) => tx.query("select id, display_name, deleted_at from customers"))).toEqual(before);
      expect((await migrate(t.db, { env: "local" })).applied).toEqual(["0012_crm_privacy"]);
    } finally {
      await t.cleanup();
    }
  });
});
