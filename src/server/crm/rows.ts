import { DEFAULT_CRM_STATUS } from "@/domain/constants";
import type {
  Activity, CompanyContact, Contactability, Customer, CustomerProcess, DataSnapshot, Task, TaskOutput,
} from "@/domain/types";

/** Az adatbázis-sor <-> tartományi objektum leképezése. A sorok kulcsai oszlopnevek (snake_case). */
export type Row = Record<string, unknown>;

const iso = (v: unknown): string => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const isoOpt = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : iso(v));
const str = (v: unknown): string | undefined => (v === null || v === undefined ? undefined : String(v));
const strict = (v: unknown): string => (v === null || v === undefined ? "" : String(v));
const dbTime = (v: string | undefined): string | null => (v === undefined ? null : v);

export function customerFromRow(r: Row, restriction?: Row): Customer {
  const base = {
    id: strict(r.id),
    contactStatus: r.contact_status as Customer["contactStatus"],
    ...(r.crm_status ? { crmStatus: r.crm_status as Customer["crmStatus"] } : {}),
    ownerId: strict(r.owner_id),
    source: strict(r.source),
    verificationStatus: r.verification_status as Customer["verificationStatus"],
    ...(str(r.email) !== undefined ? { email: str(r.email) } : {}),
    ...(str(r.phone) !== undefined ? { phone: str(r.phone) } : {}),
    ...(restriction
      ? { restriction: { kind: restriction.kind as "objection" | "restriction", note: strict(restriction.note), recordedAt: iso(restriction.recorded_at), recordedBy: strict(restriction.recorded_by) } }
      : {}),
    createdAt: iso(r.created_at),
    updatedAt: iso(r.updated_at),
  };
  if (r.type === "individual") {
    return { ...base, type: "individual", firstName: strict(r.first_name), lastName: strict(r.last_name), displayName: strict(r.display_name), ...(str(r.notes) !== undefined ? { notes: str(r.notes) } : {}) };
  }
  return { ...base, type: "company", companyName: strict(r.company_name) };
}
export function customerToRow(c: Customer): Row {
  return {
    id: c.id, type: c.type,
    first_name: c.type === "individual" ? c.firstName : null, last_name: c.type === "individual" ? c.lastName : null,
    display_name: c.type === "individual" ? c.displayName : null, company_name: c.type === "company" ? c.companyName : null,
    notes: c.type === "individual" ? (c.notes ?? null) : null,
    contact_status: c.contactStatus, crm_status: c.crmStatus ?? null, owner_id: c.ownerId, source: c.source,
    verification_status: c.verificationStatus, email: c.email ?? null, phone: c.phone ?? null, created_at: c.createdAt, updated_at: c.updatedAt,
  };
}

export const contactFromRow = (r: Row): CompanyContact => ({
  id: strict(r.id), companyId: strict(r.company_id), firstName: strict(r.first_name), lastName: strict(r.last_name),
  ...(str(r.position) !== undefined ? { position: str(r.position) } : {}),
  ...(str(r.email) !== undefined ? { email: str(r.email) } : {}),
  ...(str(r.phone) !== undefined ? { phone: str(r.phone) } : {}),
  isPrimaryContact: Boolean(r.is_primary), createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
export const contactToRow = (k: CompanyContact): Row => ({
  id: k.id, company_id: k.companyId, first_name: k.firstName, last_name: k.lastName, position: k.position ?? null, email: k.email ?? null,
  phone: k.phone ?? null, is_primary: k.isPrimaryContact, created_at: k.createdAt, updated_at: k.updatedAt,
});

export const processFromRow = (r: Row): CustomerProcess => ({
  id: strict(r.id), customerId: strict(r.customer_id),
  ...(str(r.company_contact_id) !== undefined ? { companyContactId: str(r.company_contact_id) } : {}),
  type: r.type as CustomerProcess["type"], title: strict(r.title), status: r.status as CustomerProcess["status"],
  closure: {
    state: r.closure_state as CustomerProcess["closure"]["state"],
    ...(str(r.closure_reason) !== undefined ? { reason: r.closure_reason as CustomerProcess["closure"]["reason"] } : {}),
    ...(str(r.closure_reason_note) !== undefined ? { reasonNote: str(r.closure_reason_note) } : {}),
    ...(isoOpt(r.closed_at) !== undefined ? { closedAt: isoOpt(r.closed_at) } : {}),
    ...(str(r.closed_by) !== undefined ? { closedBy: str(r.closed_by) } : {}),
  },
  channel: r.channel as CustomerProcess["channel"], source: r.source as CustomerProcess["source"], ownerId: strict(r.owner_id),
  createdAt: iso(r.created_at), updatedAt: iso(r.updated_at),
});
export const processToRow = (p: CustomerProcess): Row => ({
  id: p.id, customer_id: p.customerId, company_contact_id: p.companyContactId ?? null, type: p.type, title: p.title, status: p.status,
  closure_state: p.closure.state, closure_reason: p.closure.reason ?? null, closure_reason_note: p.closure.reasonNote ?? null,
  closed_at: dbTime(p.closure.closedAt), closed_by: p.closure.closedBy ?? null, channel: p.channel, source: p.source, owner_id: p.ownerId,
  created_at: p.createdAt, updated_at: p.updatedAt,
});

export const activityFromRow = (r: Row): Activity => ({
  id: strict(r.id), customerId: strict(r.customer_id),
  ...(str(r.process_id) !== undefined ? { processId: str(r.process_id) } : {}),
  ...(str(r.company_contact_id) !== undefined ? { companyContactId: str(r.company_contact_id) } : {}),
  type: r.type as Activity["type"], occurredAt: iso(r.occurred_at), summary: strict(r.summary), recordedBy: strict(r.recorded_by),
  ...(str(r.call_outcome) !== undefined ? { callOutcome: r.call_outcome as Activity["callOutcome"] } : {}),
  ...(r.meta ? { meta: r.meta as Activity["meta"] } : {}),
});
export const activityToRow = (a: Activity): Row => ({
  id: a.id, customer_id: a.customerId, process_id: a.processId ?? null, company_contact_id: a.companyContactId ?? null, type: a.type,
  occurred_at: a.occurredAt, summary: a.summary, recorded_by: a.recordedBy, call_outcome: a.callOutcome ?? null,
  meta: a.meta ? JSON.stringify(a.meta) : null,
});

export function taskFromRow(r: Row, results: Row[] = []): Task {
  const outputs: TaskOutput[] = [...results]
    .sort((a, b) => Number(a.seq) - Number(b.seq))
    .map((o) => ({ ...(str(o.output_key) !== undefined ? { key: o.output_key as TaskOutput["key"] } : {}), text: strict(o.output_text), closedAt: iso(o.closed_at), closedBy: strict(o.closed_by) }));
  return {
    id: strict(r.id), customerId: strict(r.customer_id),
    ...(str(r.process_id) !== undefined ? { processId: str(r.process_id) } : {}),
    ...(str(r.company_contact_id) !== undefined ? { companyContactId: str(r.company_contact_id) } : {}),
    title: strict(r.title),
    ...(str(r.task_type) !== undefined ? { taskType: r.task_type as Task["taskType"] } : {}),
    ...(str(r.description) !== undefined ? { description: str(r.description) } : {}),
    ...(str(r.input_key) !== undefined ? { inputKey: r.input_key as Task["inputKey"] } : {}),
    ...(str(r.input_note) !== undefined ? { inputNote: str(r.input_note) } : {}),
    ...(outputs.length ? { outputs } : {}),
    assigneeId: strict(r.assignee_id),
    ...(isoOpt(r.due_at) !== undefined ? { dueAt: isoOpt(r.due_at) } : {}),
    status: r.status as Task["status"],
    ...(r.crm_status ? { crmStatus: r.crm_status as Task["crmStatus"] } : {}),
    createdAt: iso(r.created_at),
    ...(isoOpt(r.completed_at) !== undefined ? { completedAt: isoOpt(r.completed_at) } : {}),
  };
}
export const taskToRow = (t: Task): Row => ({
  id: t.id, customer_id: t.customerId, process_id: t.processId ?? null, company_contact_id: t.companyContactId ?? null, title: t.title,
  task_type: t.taskType ?? null, description: t.description ?? null, input_key: t.inputKey ?? null, input_note: t.inputNote ?? null,
  assignee_id: t.assigneeId, due_at: t.dueAt ?? null, status: t.status, crm_status: t.crmStatus ?? null, created_at: t.createdAt,
  completed_at: t.completedAt ?? null,
});
export const resultToRow = (taskId: string, seq: number, o: TaskOutput): Row => ({
  task_id: taskId, seq, output_key: o.key ?? null, output_text: o.text, closed_at: o.closedAt, closed_by: o.closedBy,
});

export const contactabilityFromRow = (r: Row): Contactability => ({
  id: strict(r.id),
  ...(str(r.customer_id) !== undefined ? { customerId: str(r.customer_id) } : {}),
  ...(str(r.company_contact_id) !== undefined ? { companyContactId: str(r.company_contact_id) } : {}),
  purpose: r.purpose as Contactability["purpose"], channel: r.channel as Contactability["channel"], status: r.status as Contactability["status"],
  evidenceStatus: r.evidence_status as Contactability["evidenceStatus"],
  ...(isoOpt(r.verified_at) !== undefined ? { verifiedAt: isoOpt(r.verified_at) } : {}),
});
export const contactabilityToRow = (c: Contactability): Row => ({
  id: c.id, customer_id: c.customerId ?? null, company_contact_id: c.companyContactId ?? null, purpose: c.purpose, channel: c.channel,
  status: c.status, evidence_status: c.evidenceStatus, verified_at: c.verifiedAt ?? null,
});

export { DEFAULT_CRM_STATUS };
export type { DataSnapshot };
