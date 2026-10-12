"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { RestrictedBadge, TypeBadge } from "@/components/common";
import { StatusSelect } from "@/components/status-select";
import { TextInput } from "@/components/ui/form";
import { Button, Card } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";
import { contactName, customerName, otherContactsOf, primaryContactOf } from "@/domain/logic";
import type { CompanyContact, Customer, DataSnapshot } from "@/domain/types";

type Errors = Record<string, string>;

function Fields({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="space-y-3 p-4">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium text-ink-muted">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{i.value || <span className="text-ink-subtle">Nincs megadva</span>}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A további kapcsolattartók (régi adat) megtekintése - csak olvasható, külön modul és főmenü nélkül; az adat megmarad. */
function OtherContacts({ others }: { others: CompanyContact[] }) {
  if (!others.length) return null;
  return (
    <details className="mx-4 mb-4 rounded-md bg-canvas p-3">
      <summary className="min-h-9 cursor-pointer text-sm font-medium">További kapcsolattartók a cégnél ({others.length})</summary>
      <ul className="mt-2 divide-y divide-line">
        {others.map((k) => (
          <li key={k.id} className="py-2 text-sm">
            <p className="break-words font-medium">{contactName(k)}</p>
            <p className="break-all text-[13px] text-ink-muted">{[k.position, k.phone, k.email].filter(Boolean).join(" · ") || "Nincs megadott elérhetőség"}</p>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Az ügyfél fejléce (v0.6): a név MELLETT a szerkeszthető kapcsolati státusz (mobilon a név alatt). A kapcsolati adatok nem itt,
 * hanem a jobb oldali sávban ({@link ContactSidebar}) jelennek meg. Aktív tiltakozás/korlátozás esetén rövid, csak olvasható jelzés.
 */
export function CustomerHeader({ customer, className }: { customer: Customer; className?: string }) {
  return (
    <Card id="ugyfel" className={className}>
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 p-4">
        <div className="min-w-0 max-w-full">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-ink">{customerName(customer)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted"><TypeBadge type={customer.type} /><RestrictedBadge customer={customer} /></p>
        </div>
        <StatusSelect customer={customer} />
      </header>
    </Card>
  );
}

/**
 * Kapcsolati adatok (v0.6): desktopon a jobb oldali sáv, mobilon a név/státusz és a feladatok közé kerülő blokk. Magánszemély: telefon,
 * e-mail, adatforrás. Cég: kapcsolati személy (+ szerep), telefon, e-mail, adatforrás. A hiányzó adat visszafogottan „Nincs megadva”.
 * A szerkesztés ugyanazt az űrlapot használja, mint korábban; mentés után a sáv a friss adatot mutatja.
 */
export function ContactSidebar({ data, customer, className }: { data: DataSnapshot; customer: Customer; className?: string }) {
  const [editing, setEditing] = useState(false);
  const primary = customer.type === "company" ? primaryContactOf(data, customer.id) : undefined;
  const others = customer.type === "company" ? otherContactsOf(data, customer.id) : [];
  // Régi adat: ha a telefon/e-mail a kapcsolattartó rekordon van, az látszik (az ügyfél saját adata az elsőbbségű).
  const phone = customer.phone ?? primary?.phone;
  const email = customer.email ?? primary?.email;
  return (
    <aside aria-labelledby="kapcsolati-adatok-cim" className={className}>
      <Card id="kapcsolati-adatok">
        <div className="border-b border-line px-4 py-3">
          <h2 id="kapcsolati-adatok-cim" className="text-sm font-semibold text-ink">Kapcsolati adatok</h2>
        </div>
        {editing ? (
          <EditForm customer={customer} primary={primary} onDone={() => setEditing(false)} />
        ) : (
          <>
            <Fields
              items={[
                ...(customer.type === "company" ? [{ label: "Kapcsolati személy", value: primary ? `${contactName(primary)}${primary.position ? ` (${primary.position})` : ""}` : "" }] : []),
                { label: "Telefonszám", value: phone },
                { label: "E-mail", value: email },
                { label: "Adatforrás", value: customer.source },
              ]}
            />
            <OtherContacts others={others} />
            <div className="px-4 pb-4"><Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Szerkesztés</Button></div>
          </>
        )}
      </Card>
    </aside>
  );
}

function EditForm({ customer, primary, onDone }: { customer: Customer; primary?: CompanyContact; onDone: () => void }) {
  const { repo } = useCrmData();
  const [busy, setBusy] = useState(false);
  const [f, setF] = useState({
    name: customer.type === "individual" ? customer.displayName : "", companyName: customer.type === "company" ? customer.companyName : "",
    contactName: primary ? contactName(primary) : "", contactPosition: primary?.position ?? "",
    phone: customer.phone ?? primary?.phone ?? "", email: customer.email ?? primary?.email ?? "", source: customer.source,
  });
  const [errors, setErrors] = useState<Errors>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    const r = await repo.updateCustomer(
      customer.id,
      customer.type === "individual"
        ? { type: "individual", name: f.name, phone: f.phone, email: f.email, source: f.source }
        : { type: "company", companyName: f.companyName, contactName: f.contactName, contactPosition: f.contactPosition, phone: f.phone, email: f.email, source: f.source },
    );
    setBusy(false);
    if (!r.ok) return setErrors(r.errors);
    onDone();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-4">
      {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}
      <div className="grid gap-4">
        {customer.type === "company" ? (
          <>
            <TextInput label="Cégnév" required value={f.companyName} error={errors.companyName} onChange={set("companyName")} />
            <TextInput label="Kapcsolati személy neve" value={f.contactName} error={errors.contactName} onChange={set("contactName")} />
            <TextInput label="Beosztás / szerepkör (opcionális)" value={f.contactPosition} onChange={set("contactPosition")} />
          </>
        ) : (
          <TextInput label="Név" required value={f.name} error={errors.name} onChange={set("name")} />
        )}
        <TextInput label="Telefonszám" type="tel" value={f.phone} error={errors.phone} onChange={set("phone")} />
        <TextInput label="E-mail" type="email" value={f.email} error={errors.email} onChange={set("email")} />
        <TextInput label="Adatforrás" value={f.source} error={errors.source} onChange={set("source")} />
      </div>
      <div className="flex flex-wrap gap-2">
        <Button type="submit" disabled={busy} aria-busy={busy}>Mentés</Button>
        <Button variant="secondary" onClick={onDone} disabled={busy}>Mégse</Button>
      </div>
    </form>
  );
}
