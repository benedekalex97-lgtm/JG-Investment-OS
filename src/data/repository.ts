import type { ZodError } from "zod";
import {
  closeInput, companyContactInput, contactStatusInput, crmStatusChangeInput, customerInput, customerUpdateInput, manualActivityInput,
  newCustomerForm, processInput, reopenInput, restrictionInput, statusChangeInput, taskInput,
} from "@/domain/schemas";
import {
  CONTACT_STATUS_LABELS, CRM_STATUS_LABELS, DEFAULT_CRM_STATUS, NO_RESULT_REASON_LABELS, PROCESS_STATUS_LABELS, RESTRICTION_LABELS, VERIFICATION_SOURCE_LABELS,
} from "@/domain/constants";
import { buildDisplayName, primaryContactOf, splitName, validateRelations } from "@/domain/logic";
import type {
  Activity, CompanyContact, Contactability, ContactabilityStatus, ContactChannel, ContactPurpose, Customer, CustomerProcess,
  DataSnapshot, EvidenceStatus, Task, TaskStatus, Verification,
} from "@/domain/types";
import { initialStatus, isActive, isCrmMilestone, isMilestone, validateClosure, validateContactStatusChange, validateCrmStatusChange, validateTransition } from "@/domain/workflow";

export type Result<T> = { ok: true; value: T } | { ok: false; errors: Record<string, string> };
const fail = <T>(errors: Record<string, string>): Result<T> => ({ ok: false, errors });
const ok = <T>(value: T): Result<T> => ({ ok: true, value });

function zodErrors(e: ZodError): Record<string, string> {
  const out: Record<string, string> = {};
  for (const issue of e.issues) {
    // A beágyazott kapcsolati személy mezői laposan jelennek meg (lastName, phone, ...), a verification egy hibakulcs alatt.
    const field = String(issue.path[0] === "contact" ? (issue.path[1] ?? "contact") : (issue.path[0] ?? "_form"));
    if (!(field in out)) out[field] = issue.code === "unrecognized_keys" ? `Nem engedélyezett mező: ${issue.keys.join(", ")}` : issue.message;
  }
  return out;
}

/**
 * Adat-hozzáférési absztrakció. A UI csak ezt ismeri; a v0.2 DemoRepository memóriában dolgozik.
 * Egy későbbi perzisztens implementáció ugyanezt a felületet valósíthatja meg - a jogosultság-ellenőrzésnek
 * ott szerveroldalon kell megvalósulnia. Minden üzleti művelet naplózott Activity-t hoz létre.
 */
export interface DataRepository {
  getSnapshot(): DataSnapshot;
  createCustomer(input: unknown): Result<Customer>;
  /** Új ügyfél az egyszerű űrlapból (üzleti minimum: név); cégnél a kapcsolati személlyel együtt, mindent vagy semmit alapon. */
  createCustomerFromForm(input: unknown): Result<{ customer: Customer; contact?: CompanyContact }>;
  /** Ügyféladatok szerkesztése (a kapcsolati státusz és a korlátozás külön, naplózott művelet). */
  updateCustomer(id: string, input: unknown): Result<Customer>;
  /** v0.5: az ügyfél egyetlen aktuális kapcsolati státuszának kézi módosítása (nem érinti a feladatokat). */
  changeCrmStatus(customerId: string, input: unknown): Result<Customer>;
  updateCustomerOwner(id: string, ownerId: string): Result<Customer>;
  changeContactStatus(id: string, input: unknown): Result<Customer>;
  setRestriction(id: string, input: unknown): Result<Customer>;
  addContact(companyId: string, input: unknown): Result<CompanyContact>;
  updateContact(id: string, input: unknown): Result<CompanyContact>;
  createProcess(input: unknown): Result<CustomerProcess>;
  updateProcess(id: string, patch: { ownerId?: string; companyContactId?: string | null; title?: string }): Result<CustomerProcess>;
  changeProcessStatus(id: string, input: unknown): Result<CustomerProcess>;
  closeProcess(id: string, input: unknown): Result<CustomerProcess>;
  reopenProcess(id: string, input: unknown): Result<CustomerProcess>;
  createTask(input: unknown): Result<Task>;
  updateTask(id: string, patch: { dueAt?: string | null; assigneeId?: string; title?: string }, recordedBy: string): Result<Task>;
  setTaskStatus(id: string, status: TaskStatus, recordedBy: string): Result<Task>;
  createActivity(input: unknown): Result<Activity>;
  setContactability(
    target: { customerId?: string; companyContactId?: string },
    purpose: ContactPurpose, channel: ContactChannel, status: ContactabilityStatus, evidence: EvidenceStatus,
  ): Result<Contactability>;
}

export interface RepositoryOptions {
  clock?: () => Date;
  /** Azonosító-generátor (a seed determinisztikus azonosítókat használ). */
  idGen?: (prefix: string) => string;
}

export class DemoRepository implements DataRepository {
  private snap: DataSnapshot;
  private readonly clock: () => Date;
  private readonly idGen?: (prefix: string) => string;

  constructor(initial: DataSnapshot, opts: RepositoryOptions = {}) {
    this.snap = initial;
    this.clock = opts.clock ?? (() => new Date());
    this.idGen = opts.idGen;
  }

  /** Egyedi azonosító; sessionStorage-ból visszatöltött adatnál sem ütközhet meglévővel. */
  private nextId(prefix: string) {
    const s = this.snap;
    const taken = new Set<string>([
      ...s.customers.map((x) => x.id), ...s.contacts.map((x) => x.id), ...s.processes.map((x) => x.id),
      ...s.activities.map((x) => x.id), ...s.tasks.map((x) => x.id), ...s.contactability.map((x) => x.id),
    ]);
    let id: string;
    do id = this.idGen ? this.idGen(prefix) : `${prefix}-${Math.random().toString(36).slice(2, 10)}`;
    while (taken.has(id));
    return id;
  }
  private now() {
    return this.clock().toISOString();
  }
  private commit(patch: Partial<DataSnapshot>) {
    this.snap = { ...this.snap, ...patch };
  }
  private log(a: Omit<Activity, "id" | "occurredAt"> & { occurredAt?: string }): Activity {
    const activity: Activity = { ...a, id: this.nextId("act"), occurredAt: a.occurredAt ?? this.now() };
    this.commit({ activities: [activity, ...this.snap.activities] });
    return activity;
  }
  private verification(input: { sourceCategory: Verification["sourceCategory"] }, by: string): Verification {
    return { sourceCategory: input.sourceCategory, recordedAt: this.now(), recordedBy: by, complianceAcknowledged: true, simulated: true };
  }

  getSnapshot() {
    return this.snap;
  }

  // ------------------------------------------------------------- Ügyfél
  createCustomer(input: unknown): Result<Customer> {
    const parsed = customerInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const t = this.now();
    const base = {
      id: this.nextId("cust"), contactStatus: "prospect" as const, ownerId: d.ownerId, source: d.source, verificationStatus: "demo" as const,
      email: d.email, phone: d.phone, createdAt: t, updatedAt: t,
    };
    const customer: Customer =
      d.type === "individual"
        ? { ...base, type: "individual", firstName: d.firstName, lastName: d.lastName, displayName: buildDisplayName(d.firstName, d.lastName), notes: d.notes }
        : { ...base, type: "company", companyName: d.companyName };
    this.commit({ customers: [customer, ...this.snap.customers] });
    return ok(customer);
  }

  /**
   * Új ügyfél az egyszerű űrlapból (v0.5): üzleti minimum a név; minden más opcionális. Az új ügyfél alapértelmezett státusza
   * Kapcsolatfelvételre vár; más induló státusz naplózott státuszváltásként rögzül (a „Tőke elhelyezve” igazolással).
   * Mindent vagy semmit: hiba esetén semmi nem jön létre.
   */
  createCustomerFromForm(input: unknown): Result<{ customer: Customer; contact?: CompanyContact }> {
    const parsed = newCustomerForm.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const t = this.now();
    const base = {
      id: this.nextId("cust"), contactStatus: "prospect" as const, crmStatus: DEFAULT_CRM_STATUS, ownerId: d.recordedBy, source: d.source,
      verificationStatus: "demo" as const, email: d.email, phone: d.phone, createdAt: t, updatedAt: t,
    };
    const draft: Customer =
      d.type === "individual"
        ? { ...base, type: "individual", ...splitName(d.name), displayName: d.name, notes: d.notes }
        : { ...base, type: "company", companyName: d.companyName };
    if (d.crmStatus !== DEFAULT_CRM_STATUS) {
      const errors = validateCrmStatusChange(draft, d.crmStatus, d.verification);
      if (Object.keys(errors).length) return fail(errors);
    }
    this.commit({ customers: [draft, ...this.snap.customers] });
    let contact: CompanyContact | undefined;
    if (d.type === "company" && d.contactName) contact = this.putContactPerson(draft.id, d.contactName, d.contactPosition);
    if (d.crmStatus !== DEFAULT_CRM_STATUS) {
      const r = this.changeCrmStatus(draft.id, { toStatus: d.crmStatus, verification: d.verification, recordedBy: d.recordedBy });
      if (!r.ok) return r;
      return ok({ customer: r.value, contact });
    }
    return ok({ customer: draft, contact });
  }

  /** A cég kapcsolati személye: a meglévő elsődleges rekord neve és szerepe frissül (az azonosító és a hivatkozások maradnak), különben új, elsődleges rekord jön létre. */
  private putContactPerson(companyId: string, name: string, position?: string): CompanyContact {
    const existing = primaryContactOf(this.snap, companyId);
    const t = this.now();
    if (existing) {
      const next: CompanyContact = { ...existing, ...splitName(name), position, isPrimaryContact: true, updatedAt: t };
      this.commit({ contacts: this.snap.contacts.map((k) => (k.id === existing.id ? next : k.companyId === companyId && k.isPrimaryContact ? { ...k, isPrimaryContact: false } : k)) });
      return next;
    }
    const created: CompanyContact = { id: this.nextId("kont"), companyId, ...splitName(name), position, isPrimaryContact: true, createdAt: t, updatedAt: t };
    this.commit({ contacts: [...this.snap.contacts, created] });
    return created;
  }

  /** Ügyféladatok szerkesztése; a kapcsolati státusz külön művelet (`changeCrmStatus`). Egy lépésben, mindent vagy semmit. */
  updateCustomer(id: string, input: unknown): Result<Customer> {
    const cur = this.snap.customers.find((c) => c.id === id);
    if (!cur) return fail({ _form: "Az ügyfél nem található." });
    const parsed = customerUpdateInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    if (d.type !== cur.type) return fail({ _form: "Az ügyfél típusa nem módosítható." });
    const source = d.source ?? cur.source;
    if (d.type === "individual") {
      return this.patchCustomer(id, { ...splitName(d.name), displayName: d.name, phone: d.phone, email: d.email, notes: d.notes, source });
    }
    const primary = primaryContactOf(this.snap, id);
    // A meglévő kapcsolattartói rekord nem veszhet el: üres névvel nem üríthető ki.
    if (!d.contactName && primary) return fail({ contactName: "A kapcsolati személy neve nem üríthető ki (a meglévő kapcsolattartói rekord megmarad)." });
    const res = this.patchCustomer(id, { companyName: d.companyName, phone: d.phone, email: d.email, source });
    if (d.contactName) this.putContactPerson(id, d.contactName, d.contactPosition);
    return res;
  }

  /**
   * Kapcsolati státusz kézi módosítása (v0.5). A státuszváltás kizárólag az ügyfél státuszmezőjét írja és naplóz:
   * nem töröl, nem pipál ki és nem hoz létre feladatot. A „Tőke elhelyezve” szimulált szolgáltatói mérföldkőként, igazolással rögzül.
   */
  changeCrmStatus(customerId: string, input: unknown): Result<Customer> {
    const cur = this.snap.customers.find((c) => c.id === customerId);
    if (!cur) return fail({ _form: "Az ügyfél nem található." });
    const parsed = crmStatusChangeInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const errors = validateCrmStatusChange(cur, d.toStatus, d.verification);
    if (Object.keys(errors).length) return fail(errors);
    const from = cur.crmStatus ?? DEFAULT_CRM_STATUS;
    const milestone = isCrmMilestone(d.toStatus);
    const verification = milestone && d.verification ? this.verification(d.verification, d.recordedBy) : undefined;
    const res = this.patchCustomer(customerId, { crmStatus: d.toStatus });
    this.log({
      customerId, recordedBy: d.recordedBy, type: milestone ? "provider_milestone" : "crm_status_change",
      summary: milestone
        ? `Szimulált szolgáltatói mérföldkő: ${CRM_STATUS_LABELS[d.toStatus]} (igazolás forrása: ${VERIFICATION_SOURCE_LABELS[verification!.sourceCategory]})`
        : `Kapcsolati státusz: ${CRM_STATUS_LABELS[from]} → ${CRM_STATUS_LABELS[d.toStatus]}`,
      meta: { fromCrmStatus: from, toCrmStatus: d.toStatus, verification },
    });
    return res;
  }

  private patchCustomer(id: string, patch: Partial<Customer>): Result<Customer> {
    const cur = this.snap.customers.find((c) => c.id === id);
    if (!cur) return fail({ _form: "Az ügyfél nem található." });
    const next = { ...cur, ...patch, updatedAt: this.now() } as Customer;
    this.commit({ customers: this.snap.customers.map((c) => (c.id === id ? next : c)) });
    return ok(next);
  }
  updateCustomerOwner(id: string, ownerId: string) {
    return this.patchCustomer(id, { ownerId });
  }

  /** A kapcsolati státusz váltása külön, naplózott művelet - sosem automatikus. */
  changeContactStatus(id: string, input: unknown): Result<Customer> {
    const cur = this.snap.customers.find((c) => c.id === id);
    if (!cur) return fail({ _form: "Az ügyfél nem található." });
    const parsed = contactStatusInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const errors = validateContactStatusChange(cur.contactStatus, d);
    if (Object.keys(errors).length) return fail(errors);
    const verification = d.verification ? this.verification(d.verification, d.recordedBy) : undefined;
    const res = this.patchCustomer(id, { contactStatus: d.to });
    this.log({
      customerId: id, type: "contact_status_change", recordedBy: d.recordedBy,
      summary: `Kapcsolati státusz: ${CONTACT_STATUS_LABELS[cur.contactStatus]} → ${CONTACT_STATUS_LABELS[d.to]}` +
        (verification ? ` (igazolás forrása: ${VERIFICATION_SOURCE_LABELS[verification.sourceCategory]}, szimulált)` : "") + (d.reason ? `. Indok: ${d.reason}` : ""),
      meta: { fromContactStatus: cur.contactStatus, toContactStatus: d.to, reason: d.reason, verification },
    });
    return res;
  }

  /** Tiltakozás / megkeresési korlátozás rögzítése vagy feloldása. */
  setRestriction(id: string, input: unknown): Result<Customer> {
    const cur = this.snap.customers.find((c) => c.id === id);
    if (!cur) return fail({ _form: "Az ügyfél nem található." });
    const parsed = restrictionInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    if (d.kind && !d.note) return fail({ note: "A rögzítés körülményeinek megadása kötelező." });
    if (!d.kind && !cur.restriction) return fail({ _form: "Nincs rögzített korlátozás." });
    const res = this.patchCustomer(id, { restriction: d.kind ? { kind: d.kind, note: d.note as string, recordedAt: this.now(), recordedBy: d.recordedBy } : undefined });
    this.log({
      customerId: id, type: "restriction_change", recordedBy: d.recordedBy,
      summary: d.kind ? `${RESTRICTION_LABELS[d.kind]} rögzítve: ${d.note}` : `Megkeresési korlátozás feloldva${d.note ? `: ${d.note}` : ""}`,
      meta: { restrictionKind: d.kind },
    });
    return res;
  }

  // -------------------------------------------------------- Kapcsolattartók
  addContact(companyId: string, input: unknown): Result<CompanyContact> {
    const company = this.snap.customers.find((c) => c.id === companyId);
    if (!company || company.type !== "company") return fail({ _form: "Kapcsolattartó csak céghez vehető fel." });
    const parsed = companyContactInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const existing = this.snap.contacts.filter((k) => k.companyId === companyId);
    const t = this.now();
    const contact: CompanyContact = {
      id: this.nextId("kont"), companyId, firstName: d.firstName, lastName: d.lastName, position: d.position, email: d.email,
      phone: d.phone, isPrimaryContact: d.isPrimaryContact || existing.length === 0, createdAt: t, updatedAt: t,
    };
    const others = contact.isPrimaryContact ? this.snap.contacts.map((k) => (k.companyId === companyId ? { ...k, isPrimaryContact: false } : k)) : this.snap.contacts;
    this.commit({ contacts: [...others, contact] });
    return ok(contact);
  }

  updateContact(id: string, input: unknown): Result<CompanyContact> {
    const cur = this.snap.contacts.find((k) => k.id === id);
    if (!cur) return fail({ _form: "A kapcsolattartó nem található." });
    const parsed = companyContactInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const next: CompanyContact = { ...cur, firstName: d.firstName, lastName: d.lastName, position: d.position, email: d.email, phone: d.phone, isPrimaryContact: d.isPrimaryContact, updatedAt: this.now() };
    this.commit({
      contacts: this.snap.contacts.map((k) => (k.id === id ? next : next.isPrimaryContact && k.companyId === cur.companyId ? { ...k, isPrimaryContact: false } : k)),
    });
    return ok(next);
  }

  // ------------------------------------------------------------- Folyamat
  createProcess(input: unknown): Result<CustomerProcess> {
    const parsed = processInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const rel = validateRelations(this.snap, { customerId: d.customerId, companyContactId: d.companyContactId });
    if (rel) return fail({ companyContactId: rel });
    const customer = this.snap.customers.find((c) => c.id === d.customerId) as Customer;
    if (d.type === "outbound_outreach" && customer.restriction) {
      return fail({ type: `Kimenő kapcsolatépítés nem indítható: ${RESTRICTION_LABELS[customer.restriction.kind]} van rögzítve.` });
    }
    const t = this.now();
    const { recordedBy, ...rest } = d;
    // Az új folyamat NEM módosítja az ügyfél kapcsolati státuszát.
    const process: CustomerProcess = { id: this.nextId("proc"), ...rest, status: initialStatus(d.type), closure: { state: "active" }, createdAt: t, updatedAt: t };
    this.commit({ processes: [process, ...this.snap.processes] });
    this.log({
      customerId: d.customerId, processId: process.id, companyContactId: d.companyContactId, type: "process_created", recordedBy,
      summary: `Folyamat létrehozva: ${process.title} (${PROCESS_STATUS_LABELS[process.status]})`, meta: { toStatus: process.status },
    });
    return ok(process);
  }

  updateProcess(id: string, patch: { ownerId?: string; companyContactId?: string | null; title?: string }): Result<CustomerProcess> {
    const cur = this.snap.processes.find((p) => p.id === id);
    if (!cur) return fail({ _form: "A folyamat nem található." });
    if (patch.title !== undefined && !patch.title.trim()) return fail({ title: "Folyamat megnevezése kötelező" });
    const next: CustomerProcess = {
      ...cur, ...(patch.ownerId ? { ownerId: patch.ownerId } : {}), ...(patch.title ? { title: patch.title.trim() } : {}),
      ...(patch.companyContactId !== undefined ? { companyContactId: patch.companyContactId ?? undefined } : {}), updatedAt: this.now(),
    };
    const rel = validateRelations(this.snap, { customerId: next.customerId, companyContactId: next.companyContactId });
    if (rel) return fail({ companyContactId: rel });
    this.commit({ processes: this.snap.processes.map((p) => (p.id === id ? next : p)) });
    return ok(next);
  }

  private putProcess(next: CustomerProcess) {
    this.commit({ processes: this.snap.processes.map((p) => (p.id === next.id ? next : p)) });
  }

  changeProcessStatus(id: string, input: unknown): Result<CustomerProcess> {
    const cur = this.snap.processes.find((p) => p.id === id);
    if (!cur) return fail({ _form: "A folyamat nem található." });
    const parsed = statusChangeInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const errors = validateTransition(cur, d);
    if (Object.keys(errors).length) return fail(errors);
    const milestone = isMilestone(d.toStatus);
    const verification = milestone && d.verification ? this.verification(d.verification, d.recordedBy) : undefined;
    const next: CustomerProcess = { ...cur, status: d.toStatus, updatedAt: this.now() };
    this.putProcess(next);
    this.log({
      customerId: cur.customerId, processId: id, companyContactId: cur.companyContactId, recordedBy: d.recordedBy,
      type: milestone ? "provider_milestone" : "status_change",
      summary: milestone
        ? `Szimulált szolgáltatói mérföldkő: ${PROCESS_STATUS_LABELS[d.toStatus]} (igazolás forrása: ${VERIFICATION_SOURCE_LABELS[verification!.sourceCategory]})`
        : `Státusz: ${PROCESS_STATUS_LABELS[cur.status]} → ${PROCESS_STATUS_LABELS[d.toStatus]}`,
      meta: { fromStatus: cur.status, toStatus: d.toStatus, reason: d.reason, verification },
    });
    return ok(next);
  }

  closeProcess(id: string, input: unknown): Result<CustomerProcess> {
    const cur = this.snap.processes.find((p) => p.id === id);
    if (!cur) return fail({ _form: "A folyamat nem található." });
    const parsed = closeInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const errors = validateClosure(cur, d, this.snap);
    if (Object.keys(errors).length) return fail(errors);
    const t = this.now();
    const closure =
      d.outcome === "success"
        ? { state: "closed_success" as const, closedAt: t, closedBy: d.recordedBy }
        : { state: "closed_no_result" as const, reason: d.reason, reasonNote: d.reasonNote, closedAt: t, closedBy: d.recordedBy };
    const next: CustomerProcess = { ...cur, closure, updatedAt: t };
    this.putProcess(next);
    this.log({
      customerId: cur.customerId, processId: id, companyContactId: cur.companyContactId, type: "process_closed", recordedBy: d.recordedBy,
      summary: d.outcome === "success"
        ? "Folyamat sikeresen lezárva: az első pénzelhelyezés igazolt (szimulált)."
        : `Folyamat eredmény nélkül lezárva: ${NO_RESULT_REASON_LABELS[d.reason]}${d.reasonNote ? ` — ${d.reasonNote}` : ""}`,
      meta: { closureState: closure.state, closureReason: closure.reason, reason: d.outcome === "no_result" ? d.reasonNote : undefined },
    });
    // Későbbre halasztás: újraértékelési FELADAT készül - automatikus megkeresés nem.
    if (d.outcome === "no_result" && d.reason === "postponed" && d.followUpDueAt) {
      this.createTask({
        customerId: cur.customerId, processId: id, companyContactId: cur.companyContactId, title: `Újraértékelés: ${cur.title}`,
        description: "Későbbre halasztott folyamat - döntés az újranyitásról. Nem indít automatikus megkeresést.",
        assigneeId: cur.ownerId, dueAt: d.followUpDueAt, recordedBy: d.recordedBy,
      });
    }
    return ok(next);
  }

  reopenProcess(id: string, input: unknown): Result<CustomerProcess> {
    const cur = this.snap.processes.find((p) => p.id === id);
    if (!cur) return fail({ _form: "A folyamat nem található." });
    if (isActive(cur)) return fail({ _form: "A folyamat már aktív." });
    const parsed = reopenInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const next: CustomerProcess = { ...cur, closure: { state: "active" }, updatedAt: this.now() };
    this.putProcess(next);
    this.log({
      customerId: cur.customerId, processId: id, companyContactId: cur.companyContactId, type: "process_reopened", recordedBy: parsed.data.recordedBy,
      summary: `Folyamat újranyitva. Indok: ${parsed.data.reason}`, meta: { reason: parsed.data.reason },
    });
    return ok(next);
  }

  // -------------------------------------------------------------- Feladat
  createTask(input: unknown): Result<Task> {
    const parsed = taskInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const { recordedBy, ...d } = parsed.data;
    const rel = validateRelations(this.snap, d);
    if (rel) return fail({ customerId: rel });
    const t = this.now();
    // v0.5: a feladat automatikusan az ügyfél AKTUÁLIS státuszához kapcsolódik (külön státuszválasztás nélkül).
    const customer = this.snap.customers.find((c) => c.id === d.customerId) as Customer;
    const task: Task = { id: this.nextId("task"), ...d, crmStatus: d.crmStatus ?? customer.crmStatus ?? DEFAULT_CRM_STATUS, createdAt: t, completedAt: d.status === "done" ? t : undefined };
    this.commit({ tasks: [task, ...this.snap.tasks] });
    this.log({
      customerId: d.customerId, processId: d.processId, companyContactId: d.companyContactId, type: "task_created", recordedBy: recordedBy ?? d.assigneeId,
      summary: `Feladat létrehozva: ${task.title}`, meta: { taskId: task.id },
    });
    return ok(task);
  }

  private putTask(next: Task) {
    this.commit({ tasks: this.snap.tasks.map((t) => (t.id === next.id ? next : t)) });
  }

  /** Feladat módosítása; `dueAt: null` törli a határidőt (a határidő opcionális). */
  updateTask(id: string, patch: { dueAt?: string | null; assigneeId?: string; title?: string }, recordedBy: string): Result<Task> {
    const cur = this.snap.tasks.find((t) => t.id === id);
    if (!cur) return fail({ _form: "A feladat nem található." });
    if (typeof patch.dueAt === "string" && Number.isNaN(Date.parse(patch.dueAt))) return fail({ dueAt: "Érvénytelen dátum" });
    if (patch.title !== undefined && !patch.title.trim()) return fail({ title: "Feladat címe kötelező" });
    const { dueAt: nextDue, ...rest } = patch;
    const next: Task = { ...cur, ...rest, ...(nextDue === undefined ? {} : { dueAt: nextDue ?? undefined }) };
    this.putTask(next);
    const dueChanged = nextDue !== undefined && (nextDue ?? undefined) !== cur.dueAt;
    const changes = [dueChanged ? "határidő" : "", patch.assigneeId && patch.assigneeId !== cur.assigneeId ? "felelős" : ""].filter(Boolean);
    if (changes.length) {
      this.log({ customerId: cur.customerId, processId: cur.processId, companyContactId: cur.companyContactId, type: "task_updated", recordedBy,
        summary: `Feladat módosítva (${changes.join(", ")}): ${cur.title}`, meta: { taskId: id } });
    }
    return ok(next);
  }

  setTaskStatus(id: string, status: TaskStatus, recordedBy: string): Result<Task> {
    const cur = this.snap.tasks.find((t) => t.id === id);
    if (!cur) return fail({ _form: "A feladat nem található." });
    if (cur.status === status) return ok(cur);
    const next: Task = { ...cur, status, completedAt: status === "done" ? (cur.completedAt ?? this.now()) : undefined };
    this.putTask(next);
    this.log({
      customerId: cur.customerId, processId: cur.processId, companyContactId: cur.companyContactId, recordedBy, meta: { taskId: id },
      type: status === "done" ? "task_completed" : "task_updated",
      summary: status === "done" ? `Feladat elvégezve: ${cur.title}` : `Feladat állapota módosítva: ${cur.title}`,
    });
    return ok(next);
  }

  // ------------------------------------------------------------- Aktivitás
  createActivity(input: unknown): Result<Activity> {
    const parsed = manualActivityInput.safeParse(input);
    if (!parsed.success) return fail(zodErrors(parsed.error));
    const d = parsed.data;
    const rel = validateRelations(this.snap, d);
    if (rel) return fail({ customerId: rel });
    return ok(this.log(d));
  }

  setContactability(
    target: { customerId?: string; companyContactId?: string }, purpose: ContactPurpose, channel: ContactChannel,
    status: ContactabilityStatus, evidence: EvidenceStatus,
  ): Result<Contactability> {
    if (!target.customerId === !target.companyContactId) return fail({ _form: "Pontosan egy célpont (ügyfél vagy kapcsolattartó) adandó meg." });
    const same = (r: Contactability) =>
      r.purpose === purpose && r.channel === channel && (target.customerId ? r.customerId === target.customerId : r.companyContactId === target.companyContactId);
    const existing = this.snap.contactability.find(same);
    const next: Contactability = {
      id: existing?.id ?? this.nextId("cont"), customerId: target.customerId, companyContactId: target.companyContactId, purpose, channel, status,
      evidenceStatus: evidence, verifiedAt: status === "unknown" ? undefined : this.now(),
    };
    this.commit({ contactability: existing ? this.snap.contactability.map((r) => (r === existing ? next : r)) : [...this.snap.contactability, next] });
    return ok(next);
  }
}

