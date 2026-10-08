"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import {
  CALL_OUTCOMES, CALL_OUTCOME_LABELS, CONTACT_STATUSES, CONTACT_STATUS_LABELS, DEMO_USERS, MANUAL_ACTIVITY_TYPES, ACTIVITY_LABELS, NO_RESULT_REASONS,
  NO_RESULT_REASON_LABELS, OUTREACH_CHANNELS, OUTREACH_CHANNEL_LABELS, OUTREACH_COMPLIANCE_NOTICE, PROCESS_SOURCES, PROCESS_SOURCE_LABELS,
  PROCESS_STATUS_LABELS, PROCESS_TYPES, PROCESS_TYPE_LABELS, RESTRICTION_KINDS, RESTRICTION_LABELS, TASK_STATUSES, TASK_STATUS_LABELS,
  VERIFICATION_COMPLIANCE_WARNING, VERIFICATION_SOURCES, VERIFICATION_SOURCE_LABELS, VERIFIED_CONTACT_STATUSES,
} from "@/domain/constants";
import { contactName, customerName } from "@/domain/logic";
import type { ActivityType, CompanyContact, Customer, CustomerProcess, DataSnapshot, ProcessStatus } from "@/domain/types";
import { isMilestone, nextSteps, requiresReason } from "@/domain/workflow";
import { fromInputValue, nowInputValue } from "@/lib/format";
import { Modal } from "./ui/modal";
import { SelectInput, TextArea, TextInput } from "./ui/form";
import { Button } from "./ui/primitives";

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

function CustomerSelect({ data, value, onChange, error }: { data: DataSnapshot; value: string; onChange: (v: string) => void; error?: string }) {
  const sorted = [...data.customers].sort((a, b) => customerName(a).localeCompare(customerName(b), "hu"));
  return (
    <SelectInput label="Ügyfél" required value={value} error={error} onChange={(e) => onChange(e.target.value)}>
      <option value="">— válassz —</option>
      {sorted.map((c) => <option key={c.id} value={c.id}>{customerName(c)}</option>)}
    </SelectInput>
  );
}

/** Kapcsolattartó-választó: csak az adott cég kapcsolattartóit kínálja; magánszemélynél nem jelenik meg. */
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

function ProcessSelect({ data, customerId, value, onChange }: { data: DataSnapshot; customerId: string; value: string; onChange: (v: string) => void }) {
  if (!customerId) return null;
  const list = data.processes.filter((p) => p.customerId === customerId);
  return (
    <SelectInput label="Kapcsolódó folyamat (opcionális)" value={value} onChange={(e) => onChange(e.target.value)}>
      <option value="">— nincs —</option>
      {list.map((p) => <option key={p.id} value={p.id}>{p.title}{p.closure.state !== "active" ? " (lezárt)" : ""}</option>)}
    </SelectInput>
  );
}

/** Szimulált szolgáltatói / kapcsolati igazolás mezői: forrás-kategória + compliance tudomásulvétel. */
function VerificationFields({ source, ack, onSource, onAck, error }: { source: string; ack: boolean; onSource: (v: string) => void; onAck: (v: boolean) => void; error?: string }) {
  return (
    <fieldset className="space-y-3 rounded-md bg-warn-soft p-3">
      <legend className="px-1 text-sm font-semibold text-warn">Igazolás (szimulált)</legend>
      <p className="text-[13px] text-ink">{VERIFICATION_COMPLIANCE_WARNING}</p>
      <SelectInput label="Az igazolás forrásának kategóriája" required value={source} onChange={(e) => onSource(e.target.value)}>
        <option value="">— válassz —</option>
        {VERIFICATION_SOURCES.map((s) => <option key={s} value={s}>{VERIFICATION_SOURCE_LABELS[s]}</option>)}
      </SelectInput>
      <label className="flex items-start gap-2 text-sm">
        <input type="checkbox" className="mt-0.5 h-5 w-5 accent-accent" checked={ack} onChange={(e) => onAck(e.target.checked)} />
        <span>Tudomásul veszem a figyelmeztetést (jogosultság, nincs számlaszám/egyenleg/bizonylat, nincs valós szinkron).</span>
      </label>
      <p className="text-[13px] text-ink-muted">A rögzítés időpontja és a rögzítő (az aktuális demófelhasználó) automatikusan naplózódik.</p>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    </fieldset>
  );
}

interface Defaults { customerId?: string; processId?: string; companyContactId?: string }
interface ModalProps { open: boolean; onClose: () => void; defaults?: Defaults }

// ------------------------------------------------------------ Új folyamat
export function ProcessFormModal({ open, onClose, customer, defaultType }: { open: boolean; onClose: () => void; customer: Customer; defaultType?: CustomerProcess["type"] }) {
  return (
    <Modal open={open} onClose={onClose} title="Új folyamat">
      <ProcessForm onClose={onClose} customer={customer} defaultType={defaultType} />
    </Modal>
  );
}
function ProcessForm({ onClose, customer, defaultType }: { onClose: () => void; customer: Customer; defaultType?: CustomerProcess["type"] }) {
  const { data, repo, currentUserId } = useDemoData();
  const [v, setV] = useState({ type: defaultType ?? "inbound_inquiry", title: "", companyContactId: "", channel: "phone", source: "web_inquiry", ownerId: customer.ownerId });
  const [errors, setErrors] = useState<Errors>({});
  if (!data) return null;
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val }));
  const outboundBlocked = v.type === "outbound_outreach" && Boolean(customer.restriction);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createProcess({ ...v, customerId: customer.id, recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Folyamat létrehozása" onCancel={onClose}>
      <p className="rounded-md bg-info-soft p-3 text-[13px] text-info">Az új folyamat nem módosítja az ügyfél kapcsolati státuszát. A meglévő folyamatok és aktivitások megmaradnak.</p>
      <SelectInput label="Folyamattípus" required value={v.type} error={errors.type} onChange={(e) => set("type")(e.target.value)}>
        {PROCESS_TYPES.map((t) => <option key={t} value={t}>{PROCESS_TYPE_LABELS[t]}</option>)}
      </SelectInput>
      {v.type === "outbound_outreach" ? <p className="rounded-md bg-warn-soft p-3 text-[13px] text-ink">{OUTREACH_COMPLIANCE_NOTICE}</p> : null}
      {outboundBlocked ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{RESTRICTION_LABELS[customer.restriction!.kind]} van rögzítve: kimenő kapcsolatépítés nem indítható.</p> : null}
      <TextInput label="Rövid megnevezés" required value={v.title} error={errors.title} onChange={(e) => set("title")(e.target.value)} />
      <ContactSelect data={data} customerId={customer.id} value={v.companyContactId} onChange={set("companyContactId")} error={errors.companyContactId} />
      <div className="grid gap-3 sm:grid-cols-2">
        <SelectInput label="Megkeresési csatorna" value={v.channel} onChange={(e) => set("channel")(e.target.value)}>
          {OUTREACH_CHANNELS.map((c) => <option key={c} value={c}>{OUTREACH_CHANNEL_LABELS[c]}</option>)}
        </SelectInput>
        <SelectInput label="Forrás" value={v.source} onChange={(e) => set("source")(e.target.value)}>
          {PROCESS_SOURCES.map((s) => <option key={s} value={s}>{PROCESS_SOURCE_LABELS[s]}</option>)}
        </SelectInput>
      </div>
      <SelectInput label="Felelős" required value={v.ownerId} error={errors.ownerId} onChange={(e) => set("ownerId")(e.target.value)}><UserOptions /></SelectInput>
    </FormShell>
  );
}

// ------------------------------------------------------- Státuszváltás
export function StatusChangeModal({ open, onClose, process }: { open: boolean; onClose: () => void; process: CustomerProcess }) {
  return (
    <Modal open={open} onClose={onClose} title="Státusz váltása">
      <StatusChangeForm onClose={onClose} process={process} />
    </Modal>
  );
}
function StatusChangeForm({ onClose, process }: { onClose: () => void; process: CustomerProcess }) {
  const { repo, currentUserId } = useDemoData();
  const steps = nextSteps(process);
  const [to, setTo] = useState<string>(steps.next ?? "");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const target = to as ProcessStatus;
  const needsReason = to ? requiresReason(process, target) : false;
  const milestone = to ? isMilestone(target) : false;
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!to) return setErrors({ toStatus: "Válaszd ki a célstátuszt" });
    const r = repo.changeProcessStatus(process.id, {
      toStatus: to, reason, recordedBy: currentUserId,
      verification: milestone && (source || ack) ? { sourceCategory: source || undefined, complianceAcknowledged: ack } : undefined,
    });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  const group = (label: string, list: ProcessStatus[]) => list.length ? <optgroup label={label}>{list.map((s) => <option key={s} value={s}>{PROCESS_STATUS_LABELS[s]}</option>)}</optgroup> : null;
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Státusz rögzítése" onCancel={onClose}>
      <p className="text-sm">Jelenlegi státusz: <strong>{PROCESS_STATUS_LABELS[process.status]}</strong>. A folyamat nem kötelezően lineáris; minden váltás naplózódik.</p>
      <SelectInput label="Új státusz" required value={to} error={errors.toStatus} onChange={(e) => { setTo(e.target.value); setErrors({}); }}>
        <option value="">— válassz —</option>
        {steps.next ? group("Következő lépés", [steps.next]) : null}
        {group("Előreugrás (indoklással)", steps.skipAhead)}
        {group("Visszalépés (indoklással)", steps.back)}
      </SelectInput>
      {to ? (
        <TextArea label={needsReason ? "Indoklás" : "Megjegyzés (opcionális)"} required={needsReason} value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
      ) : null}
      {milestone ? <VerificationFields source={source} ack={ack} onSource={setSource} onAck={setAck} error={errors.verification} /> : null}
    </FormShell>
  );
}

// ------------------------------------------------------------ Lezárás
export function CloseProcessModal({ open, onClose, process }: { open: boolean; onClose: () => void; process: CustomerProcess }) {
  return (
    <Modal open={open} onClose={onClose} title="Folyamat lezárása">
      <CloseForm onClose={onClose} process={process} />
    </Modal>
  );
}
function CloseForm({ onClose, process }: { onClose: () => void; process: CustomerProcess }) {
  const { repo, currentUserId } = useDemoData();
  const canSucceed = process.status === "first_deposit_verified";
  const [outcome, setOutcome] = useState<"success" | "no_result">(canSucceed ? "success" : "no_result");
  const [reason, setReason] = useState("");
  const [note, setNote] = useState("");
  const [followUp, setFollowUp] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.closeProcess(process.id, outcome === "success" ? { outcome, recordedBy: currentUserId } : { outcome, reason: reason || undefined, reasonNote: note, followUpDueAt: fromInputValue(followUp), recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Lezárás rögzítése" onCancel={onClose}>
      <fieldset className="space-y-2">
        <legend className="mb-1 text-sm font-medium">Lezárás típusa</legend>
        <label className={`flex min-h-11 items-start gap-2 text-sm ${canSucceed ? "" : "opacity-60"}`}>
          <input type="radio" name="outcome" className="mt-1 h-5 w-5 accent-accent" disabled={!canSucceed} checked={outcome === "success"} onChange={() => setOutcome("success")} />
          <span>Sikeres lezárás — az első pénzelhelyezés igazolt{canSucceed ? "" : " (csak „Első pénzelhelyezés igazolt” státusznál, rögzített igazolás mellett)"}</span>
        </label>
        <label className="flex min-h-11 items-center gap-2 text-sm">
          <input type="radio" name="outcome" className="h-5 w-5 accent-accent" checked={outcome === "no_result"} onChange={() => setOutcome("no_result")} />
          Eredmény nélküli lezárás
        </label>
      </fieldset>
      {outcome === "no_result" ? (
        <>
          <SelectInput label="Indok" required value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value)}>
            <option value="">— válassz —</option>
            {NO_RESULT_REASONS.map((r) => <option key={r} value={r}>{NO_RESULT_REASON_LABELS[r]}</option>)}
          </SelectInput>
          <TextArea label="Indoklás szövegesen" required={reason === "other"} value={note} error={errors.reasonNote} onChange={(e) => setNote(e.target.value)} />
          {reason === "postponed" ? (
            <TextInput label="Újraértékelés időpontja" required type="datetime-local" value={followUp} error={errors.followUpDueAt} onChange={(e) => setFollowUp(e.target.value)} hint="Ebből feladat készül. Automatikus megkeresés nem indul." />
          ) : null}
        </>
      ) : null}
    </FormShell>
  );
}

export function ReopenModal({ open, onClose, process }: { open: boolean; onClose: () => void; process: CustomerProcess }) {
  return (
    <Modal open={open} onClose={onClose} title="Folyamat újranyitása">
      <ReopenForm onClose={onClose} process={process} />
    </Modal>
  );
}
function ReopenForm({ onClose, process }: { onClose: () => void; process: CustomerProcess }) {
  const { repo, currentUserId } = useDemoData();
  const [reason, setReason] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.reopenProcess(process.id, { reason, recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Újranyitás" onCancel={onClose}>
      <p className="text-sm">A folyamat az utolsó státuszában ({PROCESS_STATUS_LABELS[process.status]}) nyílik újra.</p>
      <TextArea label="Indoklás" required value={reason} error={errors.reason} onChange={(e) => setReason(e.target.value)} />
    </FormShell>
  );
}

// ----------------------------------------------------- Kapcsolati státusz
export function ContactStatusModal({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: Customer }) {
  return (
    <Modal open={open} onClose={onClose} title="Kapcsolati státusz módosítása">
      <ContactStatusForm onClose={onClose} customer={customer} />
    </Modal>
  );
}
function ContactStatusForm({ onClose, customer }: { onClose: () => void; customer: Customer }) {
  const { repo, currentUserId } = useDemoData();
  const [to, setTo] = useState("");
  const [reason, setReason] = useState("");
  const [source, setSource] = useState("");
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const needsVerification = (VERIFIED_CONTACT_STATUSES as readonly string[]).includes(to);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.changeContactStatus(customer.id, { to: to || undefined, reason, recordedBy: currentUserId, verification: needsVerification && (source || ack) ? { sourceCategory: source || undefined, complianceAcknowledged: ack } : undefined });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Státusz rögzítése" onCancel={onClose}>
      <p className="text-sm">A kapcsolati státusz külön, naplózott művelet. Egy sikeres folyamat sem módosítja automatikusan.</p>
      <SelectInput label="Új kapcsolati státusz" required value={to} error={errors.to} onChange={(e) => setTo(e.target.value)}>
        <option value="">— válassz —</option>
        {CONTACT_STATUSES.filter((s) => s !== customer.contactStatus).map((s) => <option key={s} value={s}>{CONTACT_STATUS_LABELS[s]}</option>)}
      </SelectInput>
      <TextArea label="Indok (opcionális)" value={reason} onChange={(e) => setReason(e.target.value)} />
      {needsVerification ? <VerificationFields source={source} ack={ack} onSource={setSource} onAck={setAck} error={errors.verification} /> : null}
    </FormShell>
  );
}

// ----------------------------------------------------------- Korlátozás
export function RestrictionModal({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: Customer }) {
  return (
    <Modal open={open} onClose={onClose} title="Tiltakozás / megkeresési korlátozás">
      <RestrictionForm onClose={onClose} customer={customer} />
    </Modal>
  );
}
function RestrictionForm({ onClose, customer }: { onClose: () => void; customer: Customer }) {
  const { repo, currentUserId } = useDemoData();
  const [kind, setKind] = useState<string>(customer.restriction?.kind ?? "objection");
  const [note, setNote] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.setRestriction(customer.id, { kind, note, recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  const lift = () => {
    const r = repo.setRestriction(customer.id, { kind: null, note, recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel={customer.restriction ? "Módosítás" : "Rögzítés"} onCancel={onClose}>
      <p className="text-sm">A rögzített korlátozás jól látható figyelmeztetésként jelenik meg, és a kimenő kapcsolatépítés indítását blokkolja. A „Nem érdeklődik” híváseredmény ettől független, és nem töröl ügyfelet.</p>
      <SelectInput label="Típus" value={kind} onChange={(e) => setKind(e.target.value)}>
        {RESTRICTION_KINDS.map((k) => <option key={k} value={k}>{RESTRICTION_LABELS[k]}</option>)}
      </SelectInput>
      <TextArea label="Körülmények / megjegyzés" required value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
      {customer.restriction ? <div><Button variant="danger" onClick={lift}>Korlátozás feloldása</Button></div> : null}
    </FormShell>
  );
}

// --------------------------------------------------------------- Feladat
export function TaskFormModal({ open, onClose, defaults }: ModalProps) {
  return (
    <Modal open={open} onClose={onClose} title="Új feladat">
      <TaskForm onClose={onClose} defaults={defaults} />
    </Modal>
  );
}
function TaskForm({ onClose, defaults }: { onClose: () => void; defaults?: Defaults }) {
  const { data, repo, currentUserId } = useDemoData();
  const [v, setV] = useState({ customerId: defaults?.customerId ?? "", processId: defaults?.processId ?? "", companyContactId: defaults?.companyContactId ?? "", title: "", description: "", assigneeId: currentUserId, dueAt: nowInputValue(), status: "open" });
  const [errors, setErrors] = useState<Errors>({});
  if (!data) return null;
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val, ...(k === "customerId" ? { processId: "", companyContactId: "" } : {}) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createTask({ ...v, dueAt: fromInputValue(v.dueAt), recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat létrehozása" onCancel={onClose}>
      <CustomerSelect data={data} value={v.customerId} onChange={set("customerId")} error={errors.customerId} />
      <ProcessSelect data={data} customerId={v.customerId} value={v.processId} onChange={set("processId")} />
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

// ------------------------------------------------------------ Aktivitás
export function ActivityFormModal({ open, onClose, defaults, initialType = "call" }: ModalProps & { initialType?: ActivityType }) {
  return (
    <Modal open={open} onClose={onClose} title="Aktivitás rögzítése (demó)">
      <ActivityForm onClose={onClose} defaults={defaults} initialType={initialType} />
    </Modal>
  );
}
function ActivityForm({ onClose, defaults, initialType }: { onClose: () => void; defaults?: Defaults; initialType: ActivityType }) {
  const { data, repo, currentUserId } = useDemoData();
  const [v, setV] = useState({ customerId: defaults?.customerId ?? "", processId: defaults?.processId ?? "", companyContactId: defaults?.companyContactId ?? "", type: initialType as string, summary: "", occurredAt: nowInputValue(), callOutcome: "", callbackDue: "" });
  const [errors, setErrors] = useState<Errors>({});
  if (!data) return null;
  const set = (k: keyof typeof v) => (val: string) => setV((s) => ({ ...s, [k]: val, ...(k === "customerId" ? { processId: "", companyContactId: "" } : {}) }));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createActivity({ customerId: v.customerId, processId: v.processId, companyContactId: v.companyContactId, type: v.type, summary: v.summary, occurredAt: fromInputValue(v.occurredAt), recordedBy: currentUserId, callOutcome: v.type === "call" && v.callOutcome ? v.callOutcome : undefined });
    if (!r.ok) return setErrors(r.errors);
    // Visszahívás-kérésnél opcionális feladat (nem automatikus megkeresés).
    if (v.type === "call" && v.callOutcome === "callback_requested" && v.callbackDue) {
      repo.createTask({ customerId: v.customerId, processId: v.processId, companyContactId: v.companyContactId, title: "Visszahívás", assigneeId: currentUserId, dueAt: fromInputValue(v.callbackDue), recordedBy: currentUserId });
    }
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Rögzítés" onCancel={onClose}>
      <p className="rounded-md bg-info-soft p-3 text-[13px] text-info">Belső demórekord. Nem kapcsolódik telefonrendszerhez, naptárhoz vagy e-mailhez.</p>
      <SelectInput label="Típus" required value={v.type} onChange={(e) => set("type")(e.target.value)}>
        {MANUAL_ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>)}
      </SelectInput>
      <CustomerSelect data={data} value={v.customerId} onChange={set("customerId")} error={errors.customerId} />
      <ProcessSelect data={data} customerId={v.customerId} value={v.processId} onChange={set("processId")} />
      <ContactSelect data={data} customerId={v.customerId} value={v.companyContactId} onChange={set("companyContactId")} />
      {v.type === "call" ? (
        <SelectInput label="Híváseredmény" value={v.callOutcome} error={errors.callOutcome} onChange={(e) => set("callOutcome")(e.target.value)} hint="A hívás eredménye nem azonos a kapcsolatépítési státusszal, azt nem módosítja.">
          <option value="">— nincs megadva —</option>
          {CALL_OUTCOMES.map((o) => <option key={o} value={o}>{CALL_OUTCOME_LABELS[o]}</option>)}
        </SelectInput>
      ) : null}
      {v.type === "call" && v.callOutcome === "callback_requested" ? (
        <TextInput label="Visszahívás időpontja (feladat készül, opcionális)" type="datetime-local" value={v.callbackDue} onChange={(e) => set("callbackDue")(e.target.value)} />
      ) : null}
      <TextArea label="Összefoglaló" required value={v.summary} error={errors.summary} onChange={(e) => set("summary")(e.target.value)} />
      <TextInput label="Időpont" required type="datetime-local" value={v.occurredAt} error={errors.occurredAt} onChange={(e) => set("occurredAt")(e.target.value)} />
    </FormShell>
  );
}

// ---------------------------------------------------------- Kapcsolattartó
export interface ContactValues { firstName: string; lastName: string; position: string; email: string; phone: string; isPrimaryContact: boolean }
export const emptyContact: ContactValues = { firstName: "", lastName: "", position: "", email: "", phone: "", isPrimaryContact: false };

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
    contact ? { firstName: contact.firstName, lastName: contact.lastName, position: contact.position ?? "", email: contact.email ?? "", phone: contact.phone ?? "", isPrimaryContact: contact.isPrimaryContact } : emptyContact,
  );
  const [errors, setErrors] = useState<Errors>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = contact ? repo.updateContact(contact.id, v) : repo.addContact(companyId, v);
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel={contact ? "Mentés" : "Kapcsolattartó felvétele"} onCancel={onClose}>
      <ContactFields value={v} onChange={setV} errors={errors} />
    </FormShell>
  );
}
