import { randomBytes } from "node:crypto";
import { z } from "zod";
import { DemoRepository, type Result } from "@/data/repository";
import { TASK_TEXT_MAX } from "@/domain/constants";
import { emptySnapshot, type Customer, type DataSnapshot } from "@/domain/types";
import type { AuthUser } from "../auth/service";
import type { Db, Tx } from "../db/types";
import { DELETE_CONFIRMATION_WORD, features } from "../features";
import { findDuplicates, maskRemoved, type DuplicateCandidate } from "@/domain/duplicates";
import { contactFromRow, customerFromRow, type Row } from "./rows";
import { loadSnapshot, saveDiff } from "./store";

/**
 * A kliens által hívható, szerveroldali műveletek (zárt lista). A rögzítő/felelős azonosítót MINDIG a hitelesített munkamenetből
 * állítjuk be - a kliens által küldött érték soha nem számít. Az üzleti szabályok a közös tartományi réteg (`DemoRepository`)
 * szabályai; a szerver ezt egy zárolt tranzakcióban futtatja, majd a különbséget menti (csak beszúrás/frissítés, törlés nincs).
 * A régi folyamat-, megkereshetőségi és tiltakozási műveletek szándékosan nem érhetők el az API-n.
 */
const id = z.string().min(1).max(120);
const record = z.record(z.string(), z.unknown());

type Scope = { customerId: string } | { taskId: string } | null;
interface AuditInfo { action: string; entityType: string; entityId?: string; customerId?: string; detail?: Record<string, unknown> }
interface OpDef<A, R> {
  args: z.ZodType<A>;
  scope(a: A): Scope;
  /** Tartományi szabályok a zárolt ügyfélszeleten (a különbség mentődik). */
  run?(repo: DemoRepository, a: A, u: AuthUser): Result<R>;
  /** Előzetes, szerveroldali ellenőrzés a tranzakcióban (pl. duplikáció); nem null eredménynél a művelet nem fut. */
  precheck?(tx: Tx, a: A): Promise<Result<R> | null>;
  /** Közvetlen, szűk SQL-művelet ugyanabban a tranzakcióban (pl. logikai törlés), ha a tartományi modellben nincs megfelelője. */
  custom?(tx: Tx, a: A, u: AuthUser, now: Date): Promise<Result<R>>;
  audit(a: A, value: R, before: DataSnapshot, after: DataSnapshot): AuditInfo;
}
const defineOp = <A, R>(d: OpDef<A, R>) => d;

const changedFields = (b?: Customer, a?: Customer) =>
  b && a ? Object.keys({ ...a, ...b }).filter((k) => k !== "updatedAt" && JSON.stringify((a as never)[k]) !== JSON.stringify((b as never)[k])) : [];

export const OPS = {
  "note.create": defineOp({
    args: z.object({ customerId: id, text: z.string().trim().min(1).max(2000) }).strict(),
    scope: (a) => ({ customerId: a.customerId }),
    run: (repo, a, u) => repo.createActivity({ customerId: a.customerId, type: "note", summary: a.text, recordedBy: u.id, occurredAt: new Date().toISOString() }),
    audit: (_a, v) => ({ action: "note.create", entityType: "activity", entityId: v.id, customerId: v.customerId }),
  }),
  // CRM-013: erős egyezés (azonos e-mail / telefonszám) esetén a létrehozáshoz explicit megerősítés kell (`confirmDuplicates`).
  "customer.create": defineOp({
    args: z.object({ input: record, confirmDuplicates: z.boolean().optional() }).strict(),
    scope: () => null,
    precheck: async (tx, a) => {
      if (a.confirmDuplicates === true) return null;
      const strong = (await strongDuplicates(tx, a.input)).filter((d) => d.level === "strong");
      return strong.length ? { ok: false, errors: { _duplicate: "Lehetséges, hogy ez az ügyfél már szerepel az adatbázisban. A létrehozáshoz megerősítés szükséges." }, duplicates: strong } : null;
    },
    run: (repo, a, u) => repo.createCustomerFromForm({ ...a.input, recordedBy: u.id }),
    audit: (a, v) => ({
      action: "customer.create", entityType: "customer", entityId: v.customer.id, customerId: v.customer.id,
      detail: { type: v.customer.type, crmStatus: v.customer.crmStatus, ...(a.confirmDuplicates ? { duplicateConfirmed: true } : {}) },
    }),
  }),
  "customer.update": defineOp({
    args: z.object({ id, input: record }).strict(),
    scope: (a) => ({ customerId: a.id }),
    run: (repo, a) => repo.updateCustomer(a.id, a.input),
    audit: (a, v, b, af) => ({
      action: "customer.update", entityType: "customer", entityId: v.id, customerId: v.id,
      // Csak a módosított mezők nevei kerülnek az auditba (személyes adat értéke nem).
      detail: { fields: changedFields(b.customers.find((c) => c.id === a.id), af.customers.find((c) => c.id === a.id)) },
    }),
  }),
  "customer.changeStatus": defineOp({
    args: z.object({ customerId: id, input: record }).strict(),
    scope: (a) => ({ customerId: a.customerId }),
    run: (repo, a, u) => repo.changeCrmStatus(a.customerId, { ...a.input, recordedBy: u.id }),
    audit: (a, v, b) => ({
      action: "customer.status_change", entityType: "customer", entityId: v.id, customerId: v.id,
      detail: { from: b.customers.find((c) => c.id === a.customerId)?.crmStatus ?? null, to: v.crmStatus },
    }),
  }),
  "task.create": defineOp({
    args: z.object({
      input: z.object({ customerId: id, taskType: z.string().max(60).optional(), inputKey: z.string().max(60).optional(), inputNote: z.string().max(2000).optional(), dueAt: z.string().max(40).optional() }).strict(),
    }).strict(),
    scope: (a) => ({ customerId: a.input.customerId }),
    run: (repo, a, u) => repo.createTask({ ...a.input, assigneeId: u.id, recordedBy: u.id }),
    audit: (_a, v) => ({ action: "task.create", entityType: "task", entityId: v.id, customerId: v.customerId, detail: { taskType: v.taskType ?? null, inputKey: v.inputKey ?? null, crmStatus: v.crmStatus ?? null } }),
  }),
  // v0.9: Sikeres/Sikertelen + kötelező szabad szöveges Output. A régi (legördülős) `outputKey`/`outputNote` alak már nem fogadható el.
  // A szabályokat (kötelező, nem üres, hosszkorlát) a tartományi réteg ellenőrzi; itt csak a nyers méretet korlátozzuk.
  "task.close": defineOp({
    args: z.object({ taskId: id, input: z.object({ outcome: z.string().max(20).optional(), output: z.string().max(TASK_TEXT_MAX * 2).optional() }).strict() }).strict(),
    scope: (a) => ({ taskId: a.taskId }),
    run: (repo, a, u) => repo.closeTask(a.taskId, { ...a.input, recordedBy: u.id }),
    // Az auditba csak a minősítés és az Output hossza kerül (a szöveg személyes adatot tartalmazhat).
    audit: (_a, v) => ({ action: "task.close", entityType: "task", entityId: v.id, customerId: v.customerId, detail: { outcome: v.outputs?.at(-1)?.outcome ?? null, outputLength: v.outputs?.at(-1)?.text.length ?? 0 } }),
  }),
  "task.reopen": defineOp({
    args: z.object({ taskId: id }).strict(),
    scope: (a) => ({ taskId: a.taskId }),
    run: (repo, a, u) => repo.setTaskStatus(a.taskId, "open", u.id),
    audit: (_a, v) => ({ action: "task.reopen", entityType: "task", entityId: v.id, customerId: v.customerId }),
  }),
  "task.setDue": defineOp({
    args: z.object({ taskId: id, dueAt: z.string().max(40).nullable() }).strict(),
    scope: (a) => ({ taskId: a.taskId }),
    run: (repo, a, u) => repo.updateTask(a.taskId, { dueAt: a.dueAt }, u.id),
    audit: (_a, v, b) => ({
      action: "task.update_due", entityType: "task", entityId: v.id, customerId: v.customerId,
      detail: { hasDue: v.dueAt !== undefined, changed: (b.tasks.find((t) => t.id === v.id)?.dueAt ?? null) !== (v.dueAt ?? null) },
    }),
  }),
  // CRM-006: tesztügyfél logikai eltávolítása. Csak bekapcsolt szerveroldali kapcsolóval és a beírt megerősítő szóval; a rekord és
  // minden kapcsolódó adat megmarad (deleted_at/deleted_by), az ügyfél kikerül az aktív CRM-ből. Ismételt kérés: „nem található”.
  "customer.delete": defineOp({
    args: z.object({ customerId: id, confirmation: z.string().max(40) }).strict(),
    scope: (a) => ({ customerId: a.customerId }),
    custom: async (tx, a, u, now) => {
      if (!features().testCustomerDelete) return { ok: false, errors: { _form: "Az ügyfél törlése ebben a környezetben nincs engedélyezve." } };
      if (a.confirmation.trim() !== DELETE_CONFIRMATION_WORD) return { ok: false, errors: { confirmation: `A törléshez írd be pontosan: ${DELETE_CONFIRMATION_WORD}` } };
      const rows = await tx.query<{ id: string }>("update customers set deleted_at = $2, deleted_by = $3 where id = $1 and deleted_at is null returning id", [a.customerId, now.toISOString(), u.id]);
      return rows.length ? { ok: true, value: { id: a.customerId } } : NOT_FOUND;
    },
    audit: (a) => ({ action: "customer.soft_delete", entityType: "customer", entityId: a.customerId, customerId: a.customerId, detail: { reversible: true } }),
  }),
} as const;

export type OpName = keyof typeof OPS;
export const isOpName = (s: string): s is OpName => Object.hasOwn(OPS, s);

/**
 * Erős duplikáció-egyezések a szerveroldali állapot alapján (az eltávolított rekordokat is beleértve, de azok adatai nélkül). Az új
 * ügyfelek létrehozása tranzakciós zárral sorba rendezett, így két egyidejű, azonos adatú felvitel közül a második már látja az elsőt.
 */
async function strongDuplicates(tx: Tx, input: Record<string, unknown>): Promise<DuplicateCandidate[]> {
  await tx.query("select pg_advisory_xact_lock(hashtextextended('jg.customer.create', 0))");
  const str = (k: string) => (typeof input[k] === "string" ? (input[k] as string) : undefined);
  const draft = { type: input.type === "company" ? "company" : "individual", name: str("name"), companyName: str("companyName"), contactName: str("contactName"), phone: str("phone"), email: str("email") } as const;
  if (!draft.phone && !draft.email) return [];
  const customers = await tx.query<Row>("select * from customers");
  const contacts = await tx.query<Row>("select * from company_contacts");
  const removed = new Set(customers.filter((r) => r.deleted_at !== null).map((r) => String(r.id)));
  return findDuplicates({ customers: customers.map((r) => customerFromRow(r)), contacts: contacts.map(contactFromRow) }, draft)
    .map((d) => (d.customerId && removed.has(d.customerId) ? maskRemoved(d) : d));
}

export const newId = (prefix: string) => `${prefix}-${randomBytes(8).toString("hex")}`;

export type OpOutcome =
  | { kind: "result"; result: Result<unknown>; snapshot: DataSnapshot; replayed: boolean }
  | { kind: "bad_args" };

const NOT_FOUND: Result<never> = { ok: false, errors: { _form: "A rekord nem található." } };

async function resolveCustomer(tx: Tx, scope: Scope): Promise<string | null | undefined> {
  if (!scope) return null;
  if ("customerId" in scope) return scope.customerId;
  const rows = await tx.query<{ customer_id: string }>("select customer_id from tasks where id = $1", [scope.taskId]);
  return rows[0]?.customer_id;
}

/** Egy művelet végrehajtása egyetlen, RLS-es tranzakcióban: idempotencia-ellenőrzés, zárolás, szabályok, mentés, audit. */
export async function executeOp(db: Db, user: AuthUser, req: { requestId: string; op: OpName; args: unknown }, clock: () => Date = () => new Date()): Promise<OpOutcome> {
  const def = OPS[req.op] as unknown as OpDef<unknown, unknown>;
  const parsed = def.args.safeParse(req.args);
  if (!parsed.success) return { kind: "bad_args" };
  const args = parsed.data;

  return db.asUser(user.id, async (tx) => {
    await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [req.requestId]);
    const prior = await tx.query<{ response: Result<unknown>; user_id: string; op: string }>("select response, user_id, op from request_log where request_id = $1", [req.requestId]);
    if (prior.length) {
      const snapshot = await loadSnapshot(tx);
      if (prior[0].user_id !== user.id || prior[0].op !== req.op) return { kind: "bad_args" } as const;
      return { kind: "result", result: prior[0].response, snapshot, replayed: true } as const;
    }

    const customerId = await resolveCustomer(tx, def.scope(args));
    if (customerId === undefined) return { kind: "result", result: NOT_FOUND, snapshot: await loadSnapshot(tx), replayed: false } as const;
    if (customerId !== null) {
      // A logikailag törölt ügyfélen (és feladatain) semmilyen művelet nem hajtható végre - a felület megkerülésével sem.
      const locked = await tx.query<{ deleted_at: unknown }>("select deleted_at from customers where id = $1 for update", [customerId]);
      if (!locked.length || locked[0].deleted_at !== null) return { kind: "result", result: NOT_FOUND, snapshot: await loadSnapshot(tx), replayed: false } as const;
    }

    if (def.precheck) {
      const blocked = await def.precheck(tx, args);
      if (blocked) return { kind: "result", result: blocked, snapshot: await loadSnapshot(tx), replayed: false } as const;
    }

    const before = customerId === null ? emptySnapshot() : await loadSnapshot(tx, customerId);
    const repo = new DemoRepository(before, { clock, idGen: newId });
    const result = def.custom ? await def.custom(tx, args, user, clock()) : def.run!(repo, args, user);
    if (result.ok) {
      const after = repo.getSnapshot();
      await saveDiff(tx, before, after);
      const a = def.audit(args, result.value, before, after);
      await tx.query(
        "insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail) values ($1,$2,$3,$4,$5,$6::jsonb)",
        [user.id, a.action, a.entityType, a.entityId ?? null, a.customerId ?? null, a.detail ? JSON.stringify(a.detail) : null],
      );
      await tx.query("insert into request_log (request_id, user_id, op, response) values ($1,$2,$3,$4::jsonb)", [req.requestId, user.id, req.op, JSON.stringify(result)]);
    }
    return { kind: "result", result, snapshot: await loadSnapshot(tx), replayed: false } as const;
  });
}

