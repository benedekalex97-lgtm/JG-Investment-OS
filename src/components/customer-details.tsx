"use client";

import { useState, type FormEvent, type ReactNode } from "react";
import { ContactStatusBadge, TypeBadge, userName } from "@/components/common";
import { SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import { DEMO_USERS, VERIFICATION_LABELS } from "@/domain/constants";
import { contactName, otherContactsOf, primaryContactOf } from "@/domain/logic";
import { contactPersonInput, customerUpdateInput } from "@/domain/schemas";
import type { CompanyContact, Customer, DataSnapshot } from "@/domain/types";
import { formatDate } from "@/lib/format";

type Errors = Record<string, string>;

function Block({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section aria-label={title} className="p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{title}</h3>
      {children}
    </section>
  );
}

function Fields({ items }: { items: { label: string; value: ReactNode }[] }) {
  return (
    <dl className="grid gap-x-6 gap-y-3 sm:grid-cols-2">
      {items.map((i) => (
        <div key={i.label} className="min-w-0">
          <dt className="text-xs font-medium text-ink-muted">{i.label}</dt>
          <dd className="mt-0.5 break-words text-sm text-ink">{i.value || "—"}</dd>
        </div>
      ))}
    </dl>
  );
}

/** A további kapcsolattartók (v0.1/v0.2 adat) megtekintése és elsődlegesnek jelölése - külön modul/főmenü nélkül. */
function OtherContacts({ others }: { others: CompanyContact[] }) {
  const { repo } = useDemoData();
  if (!others.length) return null;
  return (
    <details className="mt-4 rounded-md bg-canvas p-3">
      <summary className="min-h-9 cursor-pointer text-sm font-medium">További kapcsolattartók a cégnél ({others.length})</summary>
      <ul className="mt-2 divide-y divide-line">
        {others.map((k) => (
          <li key={k.id} className="flex flex-wrap items-center justify-between gap-2 py-2">
            <div className="min-w-0 text-sm">
              <p className="break-words font-medium">{contactName(k)}</p>
              <p className="break-all text-[13px] text-ink-muted">{[k.position, k.phone, k.email].filter(Boolean).join(" · ") || "Nincs megadott elérhetőség"}</p>
            </div>
            <Button size="sm" variant="secondary" aria-label={`${contactName(k)} kijelölése elsődleges kapcsolati személynek`} onClick={() => repo.makePrimaryContact(k.id)}>Kijelölés elsődlegesnek</Button>
          </li>
        ))}
      </ul>
    </details>
  );
}

/**
 * Az ügyfél felső blokkja (v0.3). Céges adatlap: CÉGADATOK / KAPCSOLATI ADATOK (egy kapcsolati személy) / NYILVÁNTARTÁSI ADATOK.
 * A külön Kapcsolattartók szekció megszűnt; a CompanyContact rekordok megmaradnak, az elsődleges jelenik meg.
 */
export function CustomerDetails({ data, customer, actions }: { data: DataSnapshot; customer: Customer; actions: ReactNode }) {
  const [editing, setEditing] = useState(false);
  const primary = customer.type === "company" ? primaryContactOf(data, customer.id) : undefined;
  const others = customer.type === "company" ? otherContactsOf(data, customer.id) : [];
  // Régi (v0.2) cégadat: ha nincs kapcsolati személy, a cég saját elérhetősége látszik.
  const phone = customer.type === "company" ? (primary?.phone ?? customer.phone) : customer.phone;
  const email = customer.type === "company" ? (primary?.email ?? customer.email) : customer.email;

  return (
    <Card id="ugyfel">
      <CardHeader
        title="Ügyféladatok"
        action={
          <span className="flex flex-wrap items-center gap-2">
            <TypeBadge type={customer.type} />
            {!editing ? <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>Szerkesztés</Button> : null}
          </span>
        }
      />
      {editing ? (
        <EditForm customer={customer} primary={primary} onDone={() => setEditing(false)} />
      ) : (
        <div className="divide-y divide-line">
          <Block title={customer.type === "company" ? "Cégadatok" : "Személyes adatok"}>
            <Fields
              items={[
                ...(customer.type === "company"
                  ? [{ label: "Cégnév", value: customer.companyName }]
                  : [{ label: "Név", value: customer.displayName }]),
                { label: "Kapcsolati státusz", value: <ContactStatusBadge status={customer.contactStatus} /> },
                { label: "Felelős", value: userName(customer.ownerId) },
                ...(customer.type === "individual" && customer.notes ? [{ label: "Jegyzet (demó)", value: customer.notes }] : []),
              ]}
            />
          </Block>
          <Block title="Kapcsolati adatok">
            <Fields
              items={[
                ...(customer.type === "company" ? [{ label: "Kapcsolati személy neve", value: primary ? contactName(primary) : "" }] : []),
                { label: "Telefonszám", value: phone },
                { label: "E-mail", value: email },
                ...(customer.type === "company" ? [{ label: "Beosztás / szerepkör", value: primary?.position }] : []),
              ]}
            />
            {customer.type === "company" && !primary ? <p className="mt-3 text-[13px] text-ink-muted">Ehhez a céghez még nincs kapcsolati személy megadva. A „Szerkesztés” művelettel adható meg.</p> : null}
            <OtherContacts others={others} />
          </Block>
          <Block title="Nyilvántartási adatok">
            <Fields
              items={[
                { label: "Adatforrás", value: customer.source },
                { label: "Létrehozva", value: formatDate(customer.createdAt) },
                { label: "Módosítva", value: formatDate(customer.updatedAt) },
                { label: "Ellenőrzöttség", value: <Badge>{VERIFICATION_LABELS[customer.verificationStatus]}</Badge> },
              ]}
            />
          </Block>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 border-t border-line p-4">{actions}</div>
    </Card>
  );
}

function EditForm({ customer, primary, onDone }: { customer: Customer; primary?: CompanyContact; onDone: () => void }) {
  const { repo } = useDemoData();
  const [f, setF] = useState({
    firstName: customer.type === "individual" ? customer.firstName : "", lastName: customer.type === "individual" ? customer.lastName : "",
    phone: customer.type === "individual" ? (customer.phone ?? "") : "", email: customer.type === "individual" ? (customer.email ?? "") : "",
    notes: customer.type === "individual" ? (customer.notes ?? "") : "", companyName: customer.type === "company" ? customer.companyName : "",
    contactFirst: primary?.firstName ?? "", contactLast: primary?.lastName ?? "", contactPhone: primary?.phone ?? customer.phone ?? "",
    contactEmail: primary?.email ?? customer.email ?? "", contactPosition: primary?.position ?? "",
    ownerId: customer.ownerId, source: customer.source,
  });
  const [errors, setErrors] = useState<Errors>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const base = customer.type === "individual"
      ? { type: "individual", firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email, notes: f.notes, ownerId: f.ownerId, source: f.source }
      : { type: "company", companyName: f.companyName, ownerId: f.ownerId, source: f.source };
    // Mindent előre validálunk, hogy részleges mentés ne történhessen.
    const errs: Errors = {};
    const customerCheck = customerUpdateInput.safeParse(base);
    if (!customerCheck.success) for (const i of customerCheck.error.issues) errs[String(i.path[0])] ??= i.message;
    const contactPayload = { firstName: f.contactFirst, lastName: f.contactLast, phone: f.contactPhone, email: f.contactEmail, position: f.contactPosition };
    if (customer.type === "company") {
      const contactCheck = contactPersonInput.safeParse(contactPayload);
      if (!contactCheck.success) for (const i of contactCheck.error.issues) errs[`c_${String(i.path[0])}`] ??= i.message;
    }
    if (Object.keys(errs).length) return setErrors(errs);
    const r = repo.updateCustomer(customer.id, base);
    if (!r.ok) return setErrors(r.errors);
    if (customer.type === "company") {
      const c = repo.savePrimaryContact(customer.id, contactPayload);
      if (!c.ok) return setErrors(Object.fromEntries(Object.entries(c.errors).map(([k, v]) => [`c_${k}`, v])));
    }
    onDone();
  };

  return (
    <form onSubmit={submit} noValidate className="space-y-5 p-4">
      {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">{customer.type === "company" ? "Cégadatok" : "Személyes adatok"}</legend>
        {customer.type === "company" ? (
          <TextInput className="sm:col-span-2" label="Cégnév" required value={f.companyName} error={errors.companyName} onChange={set("companyName")} />
        ) : (
          <>
            <TextInput label="Vezetéknév" required value={f.lastName} error={errors.lastName} onChange={set("lastName")} />
            <TextInput label="Keresztnév" required value={f.firstName} error={errors.firstName} onChange={set("firstName")} />
          </>
        )}
        <SelectInput label="Felelős" required value={f.ownerId} error={errors.ownerId} onChange={set("ownerId")}>
          {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
        </SelectInput>
        <p className="self-end text-[13px] text-ink-muted">A kapcsolati státusz külön, naplózott műveletben módosítható.</p>
      </fieldset>
      <fieldset className="grid gap-4 sm:grid-cols-2">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Kapcsolati adatok</legend>
        {customer.type === "company" ? (
          <>
            <TextInput label="Kapcsolati személy vezetékneve" required value={f.contactLast} error={errors.c_lastName} onChange={set("contactLast")} />
            <TextInput label="Kapcsolati személy keresztneve" required value={f.contactFirst} error={errors.c_firstName} onChange={set("contactFirst")} />
            <TextInput label="Telefonszám" required type="tel" value={f.contactPhone} error={errors.c_phone} onChange={set("contactPhone")} />
            <TextInput label="E-mail (opcionális)" type="email" value={f.contactEmail} error={errors.c_email} onChange={set("contactEmail")} />
            <TextInput className="sm:col-span-2" label="Beosztás / szerepkör (opcionális)" value={f.contactPosition} onChange={set("contactPosition")} />
          </>
        ) : (
          <>
            <TextInput label="Telefonszám" required type="tel" value={f.phone} error={errors.phone} onChange={set("phone")} />
            <TextInput label="E-mail (opcionális)" type="email" value={f.email} error={errors.email} onChange={set("email")} />
            <TextArea className="sm:col-span-2" label="Jegyzet (opcionális)" value={f.notes} onChange={set("notes")} />
          </>
        )}
      </fieldset>
      <fieldset className="grid gap-4">
        <legend className="mb-3 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Nyilvántartási adatok</legend>
        <TextInput label="Adatforrás" required value={f.source} error={errors.source} onChange={set("source")} />
      </fieldset>
      <div className="flex flex-wrap gap-2">
        <Button type="submit">Mentés</Button>
        <Button variant="secondary" onClick={onDone}>Mégse</Button>
      </div>
    </form>
  );
}
