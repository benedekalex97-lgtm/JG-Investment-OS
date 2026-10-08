import type { ZodError } from "zod";
import {
  activityInput, caseInput, companyContactInput, customerInput, taskInput,
  type ActivityInput, type CaseInput, type CompanyContactInput, type CustomerInput, type TaskInput,
} from "@/domain/schemas";
import { applyTaskStatus, buildDisplayName, validateRelations } from "@/domain/logic";
import type {
  Activity, Case, CompanyContact, Contactability, ContactabilityStatus, ContactChannel, ContactPurpose,
  Customer, DataSnapshot, EvidenceStatus, LifecycleStatus, TaskStatus, Task,
} from "@/domain/types";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };

const fail = <T>(errors: Record<string, string>): Result<T> => ({ ok: false, errors });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

function zodErrors(e: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    const key = String(issue.path[0] ?? "_form");
    if (!(key in out)) out[key] = issue.code === "unrecognized_keys" ? `Nem engedélyezett mező: ${issue.keys.join(", ")}` : issue.message;
  }
  return out;
}

/**
 * Adat-hozzáférési absztrakció. A UI csak ezt ismeri; a v0.1 DemoRepository
 * memóriában dolgozik. Későbbi perzisztens (pl. SQL) implementáció ugyanezt a
 * felületet valósíthatja meg - a UI változtatása nélkül.
 */
export interface DataRepository {
  getSnapshot(): DataSnapshot;
  createCustomer(input: unknown): Result<Customer>;
  updateCustomerStatus(id: string, status: LifecycleStatus): Result<Customer>;
  updateCustomerOwner(id: string, ownerId: string): Result<Customer>;
  addContact(companyId: string, input: unknown): Result<CompanyContact>;
  updateContact(id: string, input: unknown): Result<CompanyContact>;
  createCase(input: unknown): Result<Case>;
  updateCase(id: string, patch: Partial<Pick<CaseInput, "stage" | "closureStatus" | "ownerId" | "nextAction" | "nextActionDueAt" | "companyContactId" | "title">>): Result<Case>;
  createTask(input: unknown): Result<Task>;
  updateTask(id: string, patch: { dueAt?: string; assigneeId?: string; title?: string }): Result<Task>;
  setTaskStatus(id: string, status: TaskStatus): Result<Task>;
  createActivity(input: unknown): Result<Activity>;
  setContactability(
    target: { customerId?: string; companyContactId?: string },
    purpose: ContactPurpose, channel: ContactChannel, status: ContactabilityStatus, evidence: EvidenceStatus,
  ): Result<Contactability>;
}

export class DemoRepository implements DataRepository {
  private snap: DataSnapshot;
  private seq = 1000;

  constructor(initial: DataSnapshot, private readonly clock: () => Date = () => new Date()) {
    this.snap = initial;
  }

  private nextId(prefix: string) {
    this.seq += 1;
    return `${prefix}-${this.seq}`;
  }
  private now() {
    return this.clock().toISOString();
  }
  /** Immutábilis csere, hogy a React-store változást érzékeljen. */
  private commit(patch: Partial<DataSnapshot>) {
    this.snap = { ...this.snap, ...patch };
  }

  getSnapshot() {
    return this.snap;
  }

  createCustomer(input: unknown): Result<Customer> {
    const parsed = customerInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const t = this.now();
    const base = {
      id: this.nextId("cust"), lifecycleStatus: d.lifecycleStatus, ownerId: d.ownerId, source: d.source,
      verificationStatus: "demo" as const, email: d.email, phone: d.phone, createdAt: t, updatedAt: t,
    };
    const customer: Customer =
      d.type === "person"
        ? { ...base, type: "person", firstName: d.firstName, lastName: d.lastName, displayName: buildDisplayName(d.firstName, d.lastName), notes: d.notes }
        : { ...base, type: "company", companyName: d.companyName };
    this.commit({ customers: [customer, ...this.snap.customers] });
    return ok(customer);
  }

  private patchCustomer(id: string, patch: Partial<Customer>): Result<Customer> {
    const cur = this.snap.customers.find((c) => c.id === id);
    if (!cur) return fail({ _form: "Az ügyfél nem található." });
    const next = { ...cur, ...patch, updatedAt: this.now() } as Customer;
    this.commit({ customers: this.snap.customers.map((c) => (c.id === id ? next : c)) });
    return ok(next);
  }
  updateCustomerStatus(id: string, status: LifecycleStatus) {
    return this.patchCustomer(id, { lifecycleStatus: status });
  }
  updateCustomerOwner(id: string, ownerId: string) {
    return this.patchCustomer(id, { ownerId });
  }

  addContact(companyId: string, input: unknown): Result<CompanyContact> {
    const company = this.snap.customers.find((c) => c.id === companyId);
    if (!company || company.type !== "company") return fail({ _form: "Kapcsolattartó csak céghez vehető fel." });
    const parsed = companyContactInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d: CompanyContactInput = parsed.data;
    const existing = this.snap.contacts.filter((k) => k.companyId === companyId);
    const t = this.now();
    const contact: CompanyContact = {
      id: this.nextId("kont"), companyId, firstName: d.firstName, lastName: d.lastName, position: d.position,
      email: d.email, phone: d.phone, isPrimaryContact: d.isPrimaryContact || existing.length === 0, createdAt: t, updatedAt: t,
    };
    const others = contact.isPrimaryContact
      ? this.snap.contacts.map((k) => (k.companyId === companyId ? { ...k, isPrimaryContact: false } : k))
      : this.snap.contacts;
    this.commit({ contacts: [...others, contact] });
    return ok(contact);
  }

  updateContact(id: string, input: unknown): Result<CompanyContact> {
    const cur = this.snap.contacts.find((k) => k.id === id);
    if (!cur) return fail({ _form: "A kapcsolattartó nem található." });
    const parsed = companyContactInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const next: CompanyContact = {
      ...cur, firstName: d.firstName, lastName: d.lastName, position: d.position, email: d.email, phone: d.phone,
      isPrimaryContact: d.isPrimaryContact, updatedAt: this.now(),
    };
    this.commit({
      contacts: this.snap.contacts.map((k) => {
        if (k.id === id) return next;
        return next.isPrimaryContact && k.companyId === cur.companyId ? { ...k, isPrimaryContact: false } : k;
      }),
    });
    return ok(next);
  }

  createCase(input: unknown): Result<Case> {
    const parsed = caseInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const rel = validateRelations(this.snap, { customerId: d.customerId, companyContactId: d.companyContactId });
    if (rel) return fail({ companyContactId: rel });
    const t = this.now();
    const created: Case = { id: this.nextId("case"), ...d, createdAt: t, updatedAt: t };
    this.commit({ cases: [created, ...this.snap.cases] });
    return ok(created);
  }

  updateCase(id: string, patch: Parameters<DataRepository["updateCase"]>[1]): Result<Case> {
    const cur = this.snap.cases.find((c) => c.id === id);
    if (!cur) return fail({ _form: "Az ügy nem található." });
    const next: Case = { ...cur, ...patch, updatedAt: this.now() };
    const rel = validateRelations(this.snap, { customerId: next.customerId, companyContactId: next.companyContactId });
    if (rel) return fail({ companyContactId: rel });
    this.commit({ cases: this.snap.cases.map((c) => (c.id === id ? next : c)) });
    return ok(next);
  }

  createTask(input: unknown): Result<Task> {
    const parsed = taskInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d: TaskInput = parsed.data;
    const rel = validateRelations(this.snap, d);
    if (rel) return fail({ customerId: rel });
    const base: Task = { id: this.nextId("task"), ...d, createdAt: this.now() };
    const created = applyTaskStatus(base, d.status, this.clock());
    this.commit({ tasks: [created, ...this.snap.tasks] });
    return ok(created);
  }

  updateTask(id: string, patch: { dueAt?: string; assigneeId?: string; title?: string }): Result<Task> {
    const cur = this.snap.tasks.find((t) => t.id === id);
    if (!cur) return fail({ _form: "A feladat nem található." });
    if (patch.dueAt !== undefined && Number.isNaN(Date.parse(patch.dueAt))) return fail({ dueAt: "Érvénytelen dátum" });
    if (patch.title !== undefined && !patch.title.trim()) return fail({ title: "Feladat címe kötelező" });
    const next = { ...cur, ...patch };
    this.commit({ tasks: this.snap.tasks.map((t) => (t.id === id ? next : t)) });
    return ok(next);
  }

  setTaskStatus(id: string, status: TaskStatus): Result<Task> {
    const cur = this.snap.tasks.find((t) => t.id === id);
    if (!cur) return fail({ _form: "A feladat nem található." });
    const next = applyTaskStatus(cur, status, this.clock());
    this.commit({ tasks: this.snap.tasks.map((t) => (t.id === id ? next : t)) });
    return ok(next);
  }

  createActivity(input: unknown): Result<Activity> {
    const parsed = activityInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d: ActivityInput = parsed.data;
    const rel = validateRelations(this.snap, d);
    if (rel) return fail({ customerId: rel });
    const created: Activity = { id: this.nextId("act"), ...d };
    this.commit({ activities: [created, ...this.snap.activities] });
    return ok(created);
  }

  setContactability(
    target: { customerId?: string; companyContactId?: string },
    purpose: ContactPurpose, channel: ContactChannel, status: ContactabilityStatus, evidence: EvidenceStatus,
  ): Result<Contactability> {
    if (!target.customerId === !target.companyContactId) return fail({ _form: "Pontosan egy célpont (ügyfél vagy kapcsolattartó) adandó meg." });
    const same = (r: Contactability) =>
      r.purpose === purpose && r.channel === channel &&
      (target.customerId ? r.customerId === target.customerId : r.companyContactId === target.companyContactId);
    const existing = this.snap.contactability.find(same);
    const next: Contactability = {
      id: existing?.id ?? this.nextId("cont"), customerId: target.customerId, companyContactId: target.companyContactId,
      purpose, channel, status, evidenceStatus: evidence, verifiedAt: status === "unknown" ? undefined : this.now(),
    };
    this.commit({ contactability: existing ? this.snap.contactability.map((r) => (r === existing ? next : r)) : [...this.snap.contactability, next] });
    return ok(next);
  }
}
