"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import type { Result } from "@/data/repository";
import { ACTIVITY_LABELS, ACTIVITY_TYPES, CASE_STAGES, CASE_STAGE_LABELS, DEMO_USERS, TASK_STATUSES, TASK_STATUS_LABELS } from "@/domain/constants";
import { contactName, customerName } from "@/domain/logic";
import type { ActivityType, CompanyContact, DataSnapshot } from "@/domain/types";
import { fromInputValue, nowInputValue, toInputValue } from "@/lib/format";
import { Button } from "./ui/primitives";
import { Modal } from "./ui/modal";
import { SelectInput, TextArea, TextInput } from "./ui/form";

type Errors = Record<string, string>;

function FormShell({ onSubmit, errors, children, submitLabel, onCancel }: { onSubmit: (e: FormEvent) => void; errors: Errors; children: ReactNode; submitLabel: string; onCancel: () => void }) {
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}
      {children}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel}>Mégse</Button>
        <Button type="submit">{submitLabel}</Button>
      </div>
    </form>
  );
}

const UserOptions = () => <>{DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}</>;

function CustomerSelect({ data, value, onChange, error, disabled }: { data: DataSnapshot; value: string; onChange: (v: string) => void; error?: string; disabled?: boolean }) {
  const sorted = [...data.customers].sort((a, b) => customerName(a).localeCompare(customerName(b), "hu"));
  return (
    <SelectInput label="Ügyfél" required value={value} error={error} disabled={disabled} onChange={(e) => onChange(e.target.value)}>
      <option value="">— válassz —</option>
      {sorted.map((c) => <option key={c.id} value={c.id}>{customerName(c)}</option>)}
    </SelectInput>
  );
}

/** Kapcsolattartó-választó: csak az adott cég kapcsolattartóit kínálja fel; magánszemélynél nem jelenik meg. */
function ContactSelect({ data, customerId, value, onChange, error }: { data: DataSnapshot; customerId: string; value: string; onChange: (v: string) => void; error?: string }) {
  const customer = data.customers.find((c) => c.id === customerId);
  if (customer?.type !== "company") return null;
  const list: CompanyContact[] = data.contacts.filter((k) => k.companyId === customer.id);
  return (
    <SelectInput label="Kapcsolattartó (opcionális)" value={value} error={error} onChange={(e) => onChange(e.target.value)}>
      <option value="">— nincs kijelölve —</option>
      {list.map((k) => <option key={k.id} value={k.id}>{contactName(k)}{k.position ? ` (${k.position})` : ""}</option>)}
    </SelectInput>
  );
}

function CaseSelect({ data, customerId, value, onChange }: { data: DataSnapshot; customerId: string; value: string; onChange: (v: string) => void }) {
  const list = data.cases.filter((c) => c.customerId === customerId);
  if (!customerId) return null;
  return (
    <SelectInput label="Kapcsolódó ügy (opcionális)" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— nincs —</option>
      {list.map((c) => <option key={c.id} value={c.id}>{c.title}</option>)}
    </SelectInput>
  );
}

interface Defaults { customerId?: string; caseId?: string; companyContactId?: string }
interface ModalProps { open: boolean; onClose: () => void; defaults?: Defaults; onDone?: () => void }

// ------------------------------------------------------------------- Ügy
export function CaseFormModal({ open, onClose, defaults, onDone }: ModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Új ügy">
      <CaseForm onClose={onClose} defaults={defaults} onDone={onDone} />
    </Modal>
  );
}
function CaseForm({ onClose, defaults, onDone }: Omit<ModalProps, "open">) {
  const { data, repo } = useDemoData();
  const [v, setV] = useState({
    customerId: defaults?.customerId ?? "", companyContactId: "", title: "", stage: "clarify_need", ownerId: DEMO_USERS[0].id,
    nextAction: "", nextActionDueAt: "",
  });
  const [errors, setErrors] = useState<Errors>({});
  if (!data) return null;
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val, ...(k === "customerId" ? { companyContactId: "" } : {}) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createCase({ ...v, nextActionDueAt: fromInputValue(v.nextActionDueAt) });
    if (!r.ok) return setErrors(r.errors);
    onDone?.();
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Ügy létrehozása" onCancel={onClose}>
      <CustomerSelect data={data} value={v.customerId} onChange={set("customerId")} error={errors.customerId} disabled={Boolean(defaults?.customerId)} />
      <ContactSelect data={data} customerId={v.customerId} value={v.companyContactId} onChange={set("companyContactId")} error={errors.companyContactId} />
      <TextInput label="Ügy címe" required value={v.title} error={errors.title} onChange={(e) => set("title")(e.target.value)} />
      <SelectInput label="Szakasz" value={v.stage} onChange={(e) => set("stage")(e.target.value)}>
        {CASE_STAGES.map((s) => <option key={s} value={s}>{CASE_STAGE_LABELS[s]}</option>)}
      </SelectInput>
      <SelectInput label="Felelős" required value={v.ownerId} error={errors.ownerId} onChange={(e) => set("ownerId")(e.target.value)}><UserOptions /></SelectInput>
      <TextInput label="Következő lépés" value={v.nextAction} onChange={(e) => set("nextAction")(e.target.value)} />
      <TextInput label="Következő lépés határideje" type="datetime-local" value={v.nextActionDueAt} error={errors.nextActionDueAt} onChange={(e) => set("nextActionDueAt")(e.target.value)} />
    </FormShell>
  );
}

// -------------------------------------------------------------- Feladat
export function TaskFormModal({ open, onClose, defaults, onDone }: ModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Új feladat">
      <TaskForm onClose={onClose} defaults={defaults} onDone={onDone} />
    </Modal>
  );
}
function TaskForm({ onClose, defaults, onDone }: Omit<ModalProps, "open">) {
  const { data, repo } = useDemoData();
  const [v, setV] = useState({
    customerId: defaults?.customerId ?? "", caseId: defaults?.caseId ?? "", companyContactId: defaults?.companyContactId ?? "",
    title: "", description: "", assigneeId: DEMO_USERS[0].id, dueAt: nowInputValue(), status: "open",
  });
  const [errors, setErrors] = useState<Errors>({});
  if (!data) return null;
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val, ...(k === "customerId" ? { caseId: "", companyContactId: "" } : {}) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createTask({ ...v, dueAt: fromInputValue(v.dueAt) });
    if (!r.ok) return setErrors(r.errors);
    onDone?.();
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat létrehozása" onCancel={onClose}>
      <CustomerSelect data={data} value={v.customerId} onChange={set("customerId")} error={errors.customerId} disabled={Boolean(defaults?.customerId)} />
      <CaseSelect data={data} customerId={v.customerId} value={v.caseId} onChange={set("caseId")} />
      <ContactSelect data={data} customerId={v.customerId} value={v.companyContactId} onChange={set("companyContactId")} />
      <TextInput label="Feladat címe" required value={v.title} error={errors.title} onChange={(e) => set("title")(e.target.value)} />
      <TextArea label="Leírás (opcionális)" value={v.description} onChange={(e) => set("description")(e.target.value)} />
      <SelectInput label="Felelős" required value={v.assigneeId} error={errors.assigneeId} onChange={(e) => set("assigneeId")(e.target.value)}><UserOptions /></SelectInput>
      <TextInput label="Határidő" required type="datetime-local" value={v.dueAt} error={errors.dueAt} onChange={(e) => set("dueAt")(e.target.value)} />
      <SelectInput label="Állapot" value={v.status} onChange={(e) => set("status")(e.target.value)}>
        {TASK_STATUSES.map((s) => <option key={s} value={s}>{TASK_STATUS_LABELS[s]}</option>)}
      </SelectInput>
    </FormShell>
  );
}

// ------------------------------------------------------------ Tevékenység
export function ActivityFormModal({ open, onClose, defaults, onDone, initialType = "call" }: ModalProps & { initialType?: ActivityType }) {
  return (
    <Modal open={open} onClose={onClose} title="Tevékenység rögzítése (demó)">
      <ActivityForm onClose={onClose} defaults={defaults} onDone={onDone} initialType={initialType} />
    </Modal>
  );
}
function ActivityForm({ onClose, defaults, onDone, initialType }: Omit<ModalProps, "open"> & { initialType: ActivityType }) {
  const { data, repo } = useDemoData();
  const [v, setV] = useState({
    customerId: defaults?.customerId ?? "", caseId: defaults?.caseId ?? "", companyContactId: defaults?.companyContactId ?? "",
    type: initialType as string, summary: "", occurredAt: nowInputValue(), ownerId: DEMO_USERS[0].id,
  });
  const [errors, setErrors] = useState<Errors>({});
  if (!data) return null;
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val, ...(k === "customerId" ? { caseId: "", companyContactId: "" } : {}) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createActivity({ ...v, occurredAt: fromInputValue(v.occurredAt) });
    if (!r.ok) return setErrors(r.errors);
    onDone?.();
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Rögzítés" onCancel={onClose}>
      <p className="rounded-md bg-info-soft p-3 text-[13px] text-info">Belső demórekord. Nem kapcsolódik telefonrendszerhez, naptárhoz vagy e-mailhez.</p>
      <SelectInput label="Típus" required value={v.type} onChange={(e) => set("type")(e.target.value)}>
        {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>)}
      </SelectInput>
      <CustomerSelect data={data} value={v.customerId} onChange={set("customerId")} error={errors.customerId} disabled={Boolean(defaults?.customerId)} />
      <CaseSelect data={data} customerId={v.customerId} value={v.caseId} onChange={set("caseId")} />
      <ContactSelect data={data} customerId={v.customerId} value={v.companyContactId} onChange={set("companyContactId")} />
      <TextArea label="Összefoglaló" required value={v.summary} error={errors.summary} onChange={(e) => set("summary")(e.target.value)} />
      <TextInput label="Időpont" required type="datetime-local" value={v.occurredAt} error={errors.occurredAt} onChange={(e) => set("occurredAt")(e.target.value)} />
      <SelectInput label="Felelős" required value={v.ownerId} error={errors.ownerId} onChange={(e) => set("ownerId")(e.target.value)}><UserOptions /></SelectInput>
    </FormShell>
  );
}

// ---------------------------------------------------------- Kapcsolattartó
export interface ContactValues { firstName: string; lastName: string; position: string; email: string; phone: string; isPrimaryContact: boolean }
export const emptyContact: ContactValues = { firstName: "", lastName: "", position: "", email: "", phone: "", isPrimaryContact: false };

/** Mezők egy kapcsolattartóhoz - az „Új cég” űrlap és a kapcsolattartó-szerkesztő is használja. */
export function ContactFields({ value, onChange, errors = {} }: { value: ContactValues; onChange: (v: ContactValues) => void; errors?: Errors }) {
  const up = <K extends keyof ContactValues>(k: K, val: ContactValues[K]) => onChange({ ...value, [k]: val });
  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <TextInput label="Vezetéknév" required value={value.lastName} error={errors.lastName} onChange={(e) => up("lastName", e.target.value)} />
      <TextInput label="Keresztnév" required value={value.firstName} error={errors.firstName} onChange={(e) => up("firstName", e.target.value)} />
      <TextInput label="Beosztás (opcionális)" value={value.position} onChange={(e) => up("position", e.target.value)} />
      <TextInput label="E-mail (opcionális)" type="email" value={value.email} error={errors.email} onChange={(e) => up("email", e.target.value)} />
      <TextInput label="Telefon (opcionális)" type="tel" value={value.phone} error={errors.phone} onChange={(e) => up("phone", e.target.value)} />
      <label className="flex min-h-11 items-center gap-2 self-end text-sm">
        <input type="checkbox" className="h-5 w-5 accent-accent" checked={value.isPrimaryContact} onChange={(e) => up("isPrimaryContact", e.target.checked)} />
        Elsődleges kapcsolattartó
      </label>
    </div>
  );
}

export function ContactFormModal({ open, onClose, companyId, contact }: { open: boolean; onClose: () => void; companyId: string; contact?: CompanyContact }) {
  return (
    <Modal open={open} onClose={onClose} title={contact ? "Kapcsolattartó szerkesztése" : "Új kapcsolattartó"}>
      <ContactForm onClose={onClose} companyId={companyId} contact={contact} />
    </Modal>
  );
}
function ContactForm({ onClose, companyId, contact }: { onClose: () => void; companyId: string; contact?: CompanyContact }) {
  const { repo } = useDemoData();
  const [v, setV] = useState<ContactValues>(
    contact
      ? { firstName: contact.firstName, lastName: contact.lastName, position: contact.position ?? "", email: contact.email ?? "", phone: contact.phone ?? "", isPrimaryContact: contact.isPrimaryContact }
      : emptyContact,
  );
  const [errors, setErrors] = useState<Errors>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r: Result<CompanyContact> = contact ? repo.updateContact(contact.id, v) : repo.addContact(companyId, v);
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel={contact ? "Mentés" : "Kapcsolattartó felvétele"} onCancel={onClose}>
      <ContactFields value={v} onChange={setV} errors={errors} />
    </FormShell>
  );
}

export { toInputValue };
