"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { RestrictedBadge, TypeBadge } from "@/components/common";
import { StatusSelect } from "@/components/status-select";
import { TextInput } from "@/components/ui/form";
import { Button, Card } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import { contactName, customerName, otherContactsOf, primaryContactOf } from "@/domain/logic";
import type { CompanyContact, Customer, DataSnapshot } from "@/domain/types";

type Errors = Record<string, string>;

function Fields({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 p-4 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium text-ink-muted">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{i.value || "—"}</dd>
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
 * Az ügyfél fejléce és alapadatai (v0.5.1): az ügyfél neve MELLETT a szerkeszthető kapcsolati státusz (mobilon a név alatt),
 * alatta az alapadatok és a közvetlen „Szerkesztés”. Magánszemély: név, telefon, e-mail, adatforrás. Cég: cégnév, kapcsolati
 * személy (+ opcionális szerep), telefon, e-mail, adatforrás. Aktív tiltakozás/korlátozás esetén rövid, csak olvasható jelzés.
 */
export function CustomerDetails({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const [editing, setEditing] = useState(false);
  const primary = customer.type === "company" ? primaryContactOf(data, customer.id) : undefined;
  const others = customer.type === "company" ? otherContactsOf(data, customer.id) : [];
  // Régi adat: ha a telefon/e-mail a kapcsolattartó rekordon van, az látszik (az ügyfél saját adata az elsőbbségű).
  const phone = customer.phone ?? primary?.phone;
  const email = customer.email ?? primary?.email;
  return (
    <Card id="ugyfel">
      <header className="flex flex-wrap items-center gap-x-4 gap-y-3 border-b border-line p-4">
        <div className="min-w-0 max-w-full">
          <h1 className="break-words text-2xl font-semibold tracking-tight text-ink">{customerName(customer)}</h1>
          <p className="mt-1 flex flex-wrap items-center gap-2 text-sm text-ink-muted"><TypeBadge type={customer.type} /><RestrictedBadge customer={customer} /></p>
        </div>
        <StatusSelect customer={customer} />
      </header>
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
  );
}

function EditForm({ customer, primary, onDone }: { customer: Customer; primary?: CompanyContact; onDone: () => void }) {
  const { repo } = useDemoData();
  const [f, setF] = useState({
    name: customer.type === "individual" ? customer.displayName : "", companyName: customer.type === "company" ? customer.companyName : "",
    contactName: primary ? contactName(primary) : "", contactPosition: primary?.position ?? "",
    phone: customer.phone ?? primary?.phone ?? "", email: customer.email ?? primary?.email ?? "", source: customer.source,
  });
  const [errors, setErrors] = useState<Errors>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const r = repo.updateCustomer(
      customer.id,
      customer.type === "individual"
        ? { type: "individual", name: f.name, phone: f.phone, email: f.email, source: f.source }
        : { type: "company", companyName: f.companyName, contactName: f.contactName, contactPosition: f.contactPosition, phone: f.phone, email: f.email, source: f.source },
    );
    if (!r.ok) return setErrors(r.errors);
    onDone();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-4 p-4">
      {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
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
        <Button type="submit">Mentés</Button>
        <Button variant="secondary" onClick={onDone}>Mégse</Button>
      </div>
    </form>
  );
}
