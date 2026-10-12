"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import {
  CRM_STATUS_LABELS, NOTE_OPTION_KEY, TASK_INPUT_OPTIONS, TASK_NOTE_MAX, TASK_OUTPUT_OPTIONS, TASK_TYPES, VERIFICATION_COMPLIANCE_WARNING,
  VERIFICATION_SOURCES, VERIFICATION_SOURCE_LABELS,
} from "@/domain/constants";
import { inputText } from "@/domain/logic";
import type { Customer, Task } from "@/domain/types";
import { fromDateInputValue } from "@/lib/format";
import { Modal } from "./ui/modal";
import { SelectInput, TextArea, TextInput } from "./ui/form";
import { Button } from "./ui/primitives";

type Errors = Record<string, string>;

function FormShell({ onSubmit, errors, children, submitLabel, onCancel, busy = false }: { onSubmit: (e: FormEvent) => void; errors: Errors; children: ReactNode; submitLabel: string; onCancel: () => void; busy?: boolean }) {
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}
      {children}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Mégse</Button>
        <Button type="submit" disabled={busy} aria-busy={busy}>{submitLabel}</Button>
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
      <p className="text-[13px] text-ink-muted">A rögzítés időpontja és a rögzítő (a bejelentkezett felhasználó) automatikusan naplózódik.</p>
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
  const { repo } = useCrmData();
  const [source, setSource] = useState("");
  const [ack, setAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const r = await repo.changeCrmStatus(customer.id, {
      toStatus: "capital_placed",
      verification: source || ack ? { sourceCategory: source || undefined, complianceAcknowledged: ack } : undefined,
    });
    setBusy(false);
    if (!r.ok) return setErrors({ ...r.errors, ...(r.errors.toStatus ? { _form: r.errors.toStatus } : {}) });
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Státusz rögzítése" onCancel={onClose} busy={busy}>
      <p className="text-sm">A „{CRM_STATUS_LABELS.capital_placed}” szolgáltatói mérföldkő: csak igazolt visszaigazolás alapján rögzíthető. A JG nem vesz át ügyfélpénzt; a tőke elhelyezése a szolgáltatónál történik.</p>
      <VerificationFields source={source} ack={ack} onSource={setSource} onAck={setAck} error={errors.verification} />
    </FormShell>
  );
}

const counter = (text: string, max: number) => `${text.length} / ${max} karakter`;

// ------------------------------------------------------------ Új feladat (modál)
/**
 * Új feladat (v0.6): külön modál. A feladat neve a kiválasztott feladattípus neve (központi lista: TASK_TYPES), az Input
 * legördülő lista (központi lista: TASK_INPUT_OPTIONS, opcionális), a határidő opcionális. A feladat automatikusan az ügyfél
 * aktuális státuszához kapcsolódik.
 */
export function NewTaskModal({ open, onClose, customerId, statusLabel }: { open: boolean; onClose: () => void; customerId: string; statusLabel: string }) {
  return (
    <Modal open={open} onClose={onClose} title="Új feladat">
      <NewTaskForm onClose={onClose} customerId={customerId} statusLabel={statusLabel} />
    </Modal>
  );
}
function NewTaskForm({ onClose, customerId, statusLabel }: { onClose: () => void; customerId: string; statusLabel: string }) {
  const { repo } = useCrmData();
  const [taskType, setTaskType] = useState("");
  const [inputKey, setInputKey] = useState("");
  const [inputNote, setInputNote] = useState("");
  const [due, setDue] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false); // dupla kattintás/Enter elleni védelem (a szerver idempotenciája mellett)
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const r = await repo.createTask({
      customerId, taskType: taskType || undefined, inputKey: inputKey || undefined,
      inputNote: inputKey === NOTE_OPTION_KEY && inputNote.trim() ? inputNote : undefined, dueAt: fromDateInputValue(due) || undefined,
    });
    lock.current = false;
    setBusy(false);
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat létrehozása" onCancel={onClose} busy={busy}>
      <p className="text-[13px] text-ink-muted">Az új feladat a(z) „{statusLabel}” státuszhoz kapcsolódik.</p>
      <SelectInput label="Feladat típusa" required value={taskType} error={errors.taskType} onChange={(e) => setTaskType(e.target.value)} autoFocus>
        <option value="">— válassz —</option>
        {TASK_TYPES.map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </SelectInput>
      <SelectInput label="Input (opcionális)" value={inputKey} error={errors.inputKey} onChange={(e) => { setInputKey(e.target.value); setErrors((x) => ({ ...x, inputKey: "", inputNote: "" })); }}>
        <option value="">— nincs megadva —</option>
        {TASK_INPUT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </SelectInput>
      {inputKey === NOTE_OPTION_KEY ? (
        <TextArea label="Rövid megjegyzés (opcionális)" value={inputNote} error={errors.inputNote} maxLength={TASK_NOTE_MAX} rows={2} onChange={(e) => setInputNote(e.target.value)} hint={counter(inputNote, TASK_NOTE_MAX)} />
      ) : null}
      <TextInput label="Határidő (opcionális)" type="date" value={due} error={errors.dueAt} onChange={(e) => setDue(e.target.value)} />
    </FormShell>
  );
}

// -------------------------------------------------------- Feladat lezárása (modál)
/**
 * Feladat lezárása (v0.6): az elvégzettként jelölés ezt a modált nyitja; a lezárás csak itt, kiválasztott Output mellett válik
 * véglegessé (egyetlen kiválasztott érték elég). A feladat neve és az Input csak olvasható. A lezárás nem módosítja az ügyfél
 * státuszát. „Mégse” esetén a feladat nyitott marad. Rövid megjegyzés kizárólag az „Egyéb” értékhez adható.
 */
export function CloseTaskModal({ open, onClose, task }: { open: boolean; onClose: () => void; task: Task }) {
  return (
    <Modal open={open} onClose={onClose} title="Feladat lezárása">
      <CloseTaskForm onClose={onClose} task={task} />
    </Modal>
  );
}
function CloseTaskForm({ onClose, task }: { onClose: () => void; task: Task }) {
  const { repo } = useCrmData();
  const [outputKey, setOutputKey] = useState("");
  const [outputNote, setOutputNote] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    const r = await repo.closeTask(task.id, { outputKey, outputNote: outputKey === NOTE_OPTION_KEY && outputNote.trim() ? outputNote : undefined });
    lock.current = false;
    setBusy(false);
    if (!r.ok) return setErrors(r.errors);
    onClose();
  };
  const input = inputText(task);
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat lezárása" onCancel={onClose} busy={busy}>
      <div className="space-y-3 rounded-md bg-canvas p-3 text-sm">
        <div>
          <p className="text-xs font-medium text-ink-muted">Feladat</p>
          <p className="break-words font-medium">{task.title}</p>
        </div>
        <div>
          <p className="text-xs font-medium text-ink-muted">Input</p>
          <p className="max-h-32 overflow-y-auto whitespace-pre-wrap break-words">{input || "— nincs megadva —"}</p>
        </div>
      </div>
      <SelectInput label="Output" required value={outputKey} error={errors.outputKey} onChange={(e) => { setOutputKey(e.target.value); setErrors((x) => ({ ...x, outputKey: "", outputNote: "" })); }} autoFocus>
        <option value="">— válassz —</option>
        {TASK_OUTPUT_OPTIONS.map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </SelectInput>
      {outputKey === NOTE_OPTION_KEY ? (
        <TextArea label="Rövid megjegyzés (opcionális)" value={outputNote} error={errors.outputNote} maxLength={TASK_NOTE_MAX} rows={2} onChange={(e) => setOutputNote(e.target.value)} hint={counter(outputNote, TASK_NOTE_MAX)} />
      ) : null}
    </FormShell>
  );
}
