"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { useDemoData } from "@/data/store";
import {
  CRM_STATUS_LABELS, OUTREACH_COMPLIANCE_NOTICE, RESTRICTION_KINDS, RESTRICTION_LABELS, VERIFICATION_COMPLIANCE_WARNING, VERIFICATION_SOURCES,
  VERIFICATION_SOURCE_LABELS,
} from "@/domain/constants";
import type { Customer } from "@/domain/types";
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
      <p className="text-sm">{OUTREACH_COMPLIANCE_NOTICE}</p>
      <p className="text-sm">A rögzített korlátozás jól látható figyelmeztetésként jelenik meg, és a kimenő kapcsolatfelvételi státuszokat (Kapcsolatfelvétel, Kapcsolatépítés) blokkolja.</p>
      <SelectInput label="Típus" value={kind} onChange={(e) => setKind(e.target.value)}>
        {RESTRICTION_KINDS.map((k) => <option key={k} value={k}>{RESTRICTION_LABELS[k]}</option>)}
      </SelectInput>
      <TextArea label="Körülmények / megjegyzés" required value={note} error={errors.note} onChange={(e) => setNote(e.target.value)} />
      {customer.restriction ? <div><Button variant="danger" onClick={lift}>Korlátozás feloldása</Button></div> : null}
    </FormShell>
  );
}

// ------------------------------------------------------ Feladat hozzáadása
/**
 * Új feladat az ügyfélnél: megnevezés + opcionális határidő. Automatikusan az ügyfél aktuális státuszához kapcsolódik
 * (nincs státusz- vagy állapotválasztó, nincs folyamatkapcsolat).
 */
export function AddTaskForm({ customerId, statusLabel }: { customerId: string; statusLabel: string }) {
  const { repo, currentUserId } = useDemoData();
  const [open, setOpen] = useState(false);
  const [title, setTitle] = useState("");
  const [due, setDue] = useState("");
  const [errors, setErrors] = useState<Errors>({});
  const reset = () => { setOpen(false); setTitle(""); setDue(""); setErrors({}); };
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.createTask({ customerId, title, dueAt: fromDateInputValue(due) || undefined, assigneeId: currentUserId, recordedBy: currentUserId });
    if (!r.ok) return setErrors(r.errors);
    reset();
  };
  if (!open) return <div className="p-4"><Button variant="secondary" onClick={() => setOpen(true)}>+ Feladat hozzáadása</Button></div>;
  return (
    <form onSubmit={submit} noValidate className="space-y-3 border-t border-line p-4">
      <p className="text-[13px] text-ink-muted">Az új feladat a(z) „{statusLabel}” státuszhoz kapcsolódik.</p>
      <div className="grid gap-3 sm:grid-cols-[1fr_12rem]">
        <TextInput label="Feladat megnevezése" required value={title} error={errors.title} onChange={(e) => setTitle(e.target.value)} autoFocus />
        <TextInput label="Határidő (opcionális)" type="date" value={due} error={errors.dueAt} onChange={(e) => setDue(e.target.value)} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Feladat hozzáadása</Button>
        <Button variant="secondary" onClick={reset}>Mégse</Button>
      </div>
    </form>
  );
}
