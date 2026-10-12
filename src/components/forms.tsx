"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import {
  CRM_STATUS_LABELS, TASK_TEXT_MAX, TASK_TYPES, VERIFICATION_COMPLIANCE_WARNING, VERIFICATION_SOURCES, VERIFICATION_SOURCE_LABELS,
} from "@/domain/constants";
import type { Customer, Task } from "@/domain/types";
import { fromDateInputValue } from "@/lib/format";
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

/** Szimulált szolgáltatói igazolás mezői: forráskategória + compliance tudomásulvétel (a „Tőke elhelyezve” státuszhoz). */
export function VerificationFields({ source, ack, onSource, onAck, error }: { source: string; ack: boolean; onSource: (v: string) => void; onAck: (v: boolean) => void; error?: string }) {
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

// ---------------------------------------------------- „Tőke elhelyezve” igazolás
export function CapitalPlacedModal({ open, onClose, customer }: { open: boolean; onClose: () => void; customer: Customer }) {
  return (
    <Modal open={open} onClose={onClose} title={`Státusz: ${CRM_STATUS_LABELS.capital_placed}`}>
      <CapitalPlacedForm onClose={onClose} customer={customer} />
    </Modal>
  );
}
function CapitalPlacedForm({ onClose, customer }: { onClose: () => void; customer: Customer }) {
  const { repo, currentUserId } = useDemoData();
  const [source, setSource] = useState("");
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.changeCrmStatus(customer.id, {
      toStatus: "capital_placed", recordedBy: currentUserId,
      verification: source || ack ? { sourceCategory: source || undefined, complianceAcknowledged: ack } : undefined,
    });
    if (!r.ok) return setErrors({ ...r.errors, ...(r.errors.toStatus ? { _form: r.errors.toStatus } : {}) });
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Státusz rögzítése" onCancel={onClose}>
      <p className="text-sm">A „{CRM_STATUS_LABELS.capital_placed}” szolgáltatói mérföldkő: csak igazolt (a demóban szimulált) visszaigazolás alapján rögzíthető. A JG nem vesz át ügyfélpénzt; a tőke elhelyezése a szolgáltatónál történik.</p>
      <VerificationFields source={source} ack={ack} onSource={setSource} onAck={setAck} error={errors.verification} />
    </FormShell>
  );
}

const counter = (text: string) => `${text.length} / ${TASK_TEXT_MAX} karakter`;

// ------------------------------------------------------------ Új feladat (modál)
/**
 * Új feladat (v0.5.1): külön modál. A feladat neve a kiválasztott feladattípus neve (központi lista: TASK_TYPES), az Input
 * (leírás) opcionális, a határidő opcionális. A feladat automatikusan az ügyfél aktuális státuszához kapcsolódik.
 */
export function NewTaskModal({ open, onClose, customerId, statusLabel }: { open: boolean; onClose: () => void; customerId: string; statusLabel: string }) {
  return (
    <Modal open={open} onClose={onClose} title="Új feladat">
      <NewTaskForm onClose={onClose} customerId={customerId} statusLabel={statusLabel} />
    </Modal>
  );
}
function NewTaskForm({ onClose, customerId, statusLabel }: { onClose: () => void; customerId: string; statusLabel: string }) {
  const { repo, currentUserId } = useDemoData();
  const [taskType, setTaskType] = useState("");
  const [description, setDescription] = useState("");
  const [due, setDue] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const busy = useRef(false); // dupla kattintás/Enter elleni védelem
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    const r = repo.createTask({ customerId, taskType: taskType || undefined, description, dueAt: fromDateInputValue(due) || undefined, assigneeId: currentUserId, recordedBy: currentUserId });
    if (!r.ok) {
      busy.current = false;
      return setErrors(r.errors);
    }
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat létrehozása" onCancel={onClose}>
      <p className="text-[13px] text-ink-muted">Az új feladat a(z) „{statusLabel}” státuszhoz kapcsolódik.</p>
      <SelectInput label="Feladat típusa" required value={taskType} error={errors.taskType} onChange={(e) => setTaskType(e.target.value)} autoFocus>
        <option value="">— válassz —</option>
        {TASK_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </SelectInput>
      <TextArea label="Leírás / Input" value={description} error={errors.description} maxLength={TASK_TEXT_MAX} rows={4} onChange={(e) => setDescription(e.target.value)} hint={`Mit kell elvégezni, vagy milyen információ alapján dolgozunk (opcionális). ${counter(description)}`} />
      <TextInput label="Határidő (opcionális)" type="date" value={due} error={errors.dueAt} onChange={(e) => setDue(e.target.value)} />
    </FormShell>
  );
}

// -------------------------------------------------------- Feladat lezárása (modál)
/**
 * Feladat lezárása (v0.5.1): az elvégzettként jelölés ezt a modált nyitja; a lezárás csak itt, kitöltött Output (eredmény)
 * mellett válik véglegessé. „Mégse” esetén a feladat nyitott marad.
 */
export function CloseTaskModal({ open, onClose, task }: { open: boolean; onClose: () => void; task: Task }) {
  return (
    <Modal open={open} onClose={onClose} title="Feladat lezárása">
      <CloseTaskForm onClose={onClose} task={task} />
    </Modal>
  );
}
function CloseTaskForm({ onClose, task }: { onClose: () => void; task: Task }) {
  const { repo, currentUserId } = useDemoData();
  const [output, setOutput] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const busy = useRef(false);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (busy.current) return;
    busy.current = true;
    const r = repo.closeTask(task.id, { output, recordedBy: currentUserId });
    if (!r.ok) {
      busy.current = false;
      return setErrors(r.errors);
    }
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat lezárása" onCancel={onClose}>
      <div className="space-y-3 rounded-md bg-canvas p-3 text-sm">
        <div>
          <p className="text-xs font-medium text-ink-muted">Feladat</p>
          <p className="break-words font-medium">{task.title}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-ink-muted">Input</p>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{task.description || "— nincs megadva —"}</p>
        </div>
      </div>
      <TextArea label="Eredmény / Output" required value={output} error={errors.output} maxLength={TASK_TEXT_MAX} rows={4} onChange={(e) => setOutput(e.target.value)} autoFocus hint={`Mi történt, milyen eredménnyel zárult a feladat. ${counter(output)}`} />
    </FormShell>
  );
}
