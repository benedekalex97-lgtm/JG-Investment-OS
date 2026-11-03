"use client";

import { useRef, useState, type FormEvent, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { TASK_NOTE_MAX, VERIFICATION_COMPLIANCE_WARNING, VERIFICATION_SOURCES, VERIFICATION_SOURCE_LABELS } from "@/domain/constants";
import { activeOf, findTaskInput, statusLabel } from "@/domain/config";
import { useCrmConfig } from "./common";
import { customerName, statusOf } from "@/domain/logic";
import type { Customer, Task } from "@/domain/types";
import { fromDateInputValue } from "@/lib/format";
import { Modal } from "./ui/modal";
import { SelectInput, TextArea, TextInput } from "./ui/form";
import { Button } from "./ui/primitives";

type Errors = Record<string, string>;

function FormShell({ onSubmit, errors, children, submitLabel, onCancel, cancelLabel = "Mégse", busy = false }: { onSubmit: (e: FormEvent) => void; errors: Errors; children: ReactNode; submitLabel: string; onCancel: () => void; cancelLabel?: string; busy?: boolean }) {
  return (
    <form onSubmit={onSubmit} noValidate className="space-y-4">
      {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}
      {children}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>{cancelLabel}</Button>
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

// ---------------------------------------------------- Szolgáltatói mérföldkő („Tőke elhelyezve”) igazolás
/** Az igazolást igénylő (mérföldkő) státuszra váltás párbeszéde; a státusz a katalógus kulcsa (alapból „capital_placed”). */
export function CapitalPlacedModal({ open, onClose, customer, status = "capital_placed" }: { open: boolean; onClose: () => void; customer: Customer; status?: string }) {
  const config = useCrmConfig();
  return (
    <Modal open={open} onClose={onClose} title={`Státusz: ${statusLabel(config, status)}`}>
      <CapitalPlacedForm onClose={onClose} customer={customer} status={status} label={statusLabel(config, status)} />
    </Modal>
  );
}
function CapitalPlacedForm({ onClose, customer, status, label }: { onClose: () => void; customer: Customer; status: string; label: string }) {
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
      toStatus: status,
      verification: source || ack ? { sourceCategory: source || undefined, complianceAcknowledged: ack } : undefined,
    });
    setBusy(false);
    if (!r.ok) return setErrors({ ...r.errors, ...(r.errors.toStatus ? { _form: r.errors.toStatus } : {}) });
    onClose();
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Státusz rögzítése" onCancel={onClose} busy={busy}>
      <p className="text-sm">A „{label}” szolgáltatói mérföldkő: csak igazolt visszaigazolás alapján rögzíthető. A JG nem vesz át ügyfélpénzt; a tőke elhelyezése a szolgáltatónál történik.</p>
      <VerificationFields source={source} ack={ack} onSource={setSource} onAck={setAck} error={errors.verification} />
    </FormShell>
  );
}

const counter = (text: string, max: number) => `${text.length} / ${max} karakter`;

// ------------------------------------------------------------ Új feladat (modál)
/**
 * Új feladat (v0.6): külön modál. A feladat neve a kiválasztott feladattípus neve, az Input legördülő lista (opcionális), a határidő
 * opcionális; v1.1-től mindkét lista a katalógus aktív elemeiből áll. A feladat automatikusan az ügyfél aktuális státuszához kapcsolódik.
 */
export function NewTaskModal({ open, onClose, customerId }: { open: boolean; onClose: () => void; customerId: string }) {
  return (
    <Modal open={open} onClose={onClose} title="Új feladat">
      <NewTaskForm customerId={customerId} onCancel={onClose} onCreated={onClose} />
    </Modal>
  );
}

/**
 * Az egyetlen feladatfelviteli űrlap (v0.9): az ügyféladatlap „Új feladat” gombja és a lezárás utáni „következő feladat” lépés
 * (CRM-009) is ezt használja. Az ügyfél és a felelős csak olvasható: az ügyfél a hívó által megadott, a felelőst a szerver a
 * munkamenetből állítja be (a bejelentkezett munkatárs). Sikertelen mentésnél a beírt adatok és a hibaüzenet megmaradnak.
 */
export function NewTaskForm({ customerId, onCancel, onCreated, cancelLabel = "Mégse" }: { customerId: string; onCancel: () => void; onCreated: (task: Task) => void; cancelLabel?: string }) {
  const { repo, data, user } = useCrmData();
  const config = useCrmConfig();
  const customer = data?.customers.find((c) => c.id === customerId);
  const [taskType, setTaskType] = useState("");
  const [inputKey, setInputKey] = useState("");
  const [inputNote, setInputNote] = useState("");
  const [due, setDue] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const [busy, setBusy] = useState(false);
  const lock = useRef(false); // dupla kattintás/Enter elleni védelem (a szerver idempotenciája mellett)
  const noteAllowed = findTaskInput(config, inputKey)?.allowsNote === true;
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setErrors({});
    try {
      const r = await repo.createTask({
        customerId, taskType: taskType || undefined, inputKey: inputKey || undefined,
        inputNote: noteAllowed && inputNote.trim() ? inputNote : undefined, dueAt: fromDateInputValue(due) || undefined,
      });
      if (!r.ok) return setErrors(r.errors);
      onCreated(r.value);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <FormShell onSubmit={submit} errors={errors} submitLabel="Feladat létrehozása" onCancel={onCancel} cancelLabel={cancelLabel} busy={busy}>
      <dl className="grid gap-2 rounded-md bg-canvas p-3 text-sm sm:grid-cols-2">
        <div className="min-w-0"><dt className="text-xs font-medium text-ink-muted">Ügyfél</dt><dd className="break-words font-medium">{customer ? customerName(customer) : "—"}</dd></div>
        <div className="min-w-0"><dt className="text-xs font-medium text-ink-muted">Felelős</dt><dd className="break-words">{user?.name ?? "—"} (bejelentkezett munkatárs)</dd></div>
      </dl>
      {customer ? <p className="text-[13px] text-ink-muted">Az új feladat a(z) „{statusLabel(config, statusOf(customer))}” státuszhoz kapcsolódik.</p> : null}
      <SelectInput label="Feladat típusa" required value={taskType} error={errors.taskType} onChange={(e) => setTaskType(e.target.value)} autoFocus>
        <option value="">— válassz —</option>
        {activeOf(config.taskTypes).map((t) => <option key={t.key} value={t.key}>{t.label}</option>)}
      </SelectInput>
      <SelectInput label="Input (opcionális)" value={inputKey} error={errors.inputKey} onChange={(e) => { setInputKey(e.target.value); setErrors((x) => ({ ...x, inputKey: "", inputNote: "" })); }}>
        <option value="">— nincs megadva —</option>
        {activeOf(config.taskInputs).map((o) => <option key={o.key} value={o.key}>{o.label}</option>)}
      </SelectInput>
      {noteAllowed ? (
        <TextArea label="Rövid megjegyzés (opcionális)" value={inputNote} error={errors.inputNote} maxLength={TASK_NOTE_MAX} rows={2} onChange={(e) => setInputNote(e.target.value)} hint={counter(inputNote, TASK_NOTE_MAX)} />
      ) : null}
      <TextInput label="Határidő (opcionális)" type="date" value={due} error={errors.dueAt} onChange={(e) => setDue(e.target.value)} />
    </FormShell>
  );
}
