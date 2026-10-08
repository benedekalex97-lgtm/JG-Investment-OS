"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ContactFields, emptyContact, type ContactValues } from "@/components/forms";
import { SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Button, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { companyContactInput } from "@/domain/schemas";
import { useDemoData } from "@/data/store";
import { CUSTOMER_TYPE_LABELS, DEMO_USERS, LIFECYCLE_LABELS, LIFECYCLE_STATUSES } from "@/domain/constants";
import { cn } from "@/lib/cn";

type Errors = Record<string, string>;

export default function NewCustomerPage() {
  const router = useRouter();
  const { repo, data } = useDemoData();
  const [type, setType] = useState<"person" | "company">("person");
  const [common, setCommon] = useState({ lifecycleStatus: "prospect", ownerId: DEMO_USERS[0].id, email: "", phone: "" });
  const [person, setPerson] = useState({ firstName: "", lastName: "", notes: "" });
  const [companyName, setCompanyName] = useState("");
  const [contacts, setContacts] = useState<ContactValues[]>([]);
  const [errors, setErrors] = useState<Errors>({});
  const [contactErrors, setContactErrors] = useState<Record<number, Errors>>({});

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!data) return;
    // A kapcsolattartókat előre validáljuk, hogy részleges létrehozás ne történhessen.
    if (type === "company") {
      const failed: Record<number, Errors> = {};
      contacts.forEach((k, i) => {
        const p = companyContactInput.safeParse(k);
        if (!p.success) {
          const errs: Errors = {};
          for (const issue of p.error.issues) errs[String(issue.path[0])] ??= issue.message;
          failed[i] = errs;
        }
      });
      setContactErrors(failed);
      if (Object.keys(failed).length) {
        setErrors({ _form: "Néhány kapcsolattartó adata hibás. Javítsd vagy távolítsd el őket." });
        return;
      }
    }
    const payload = type === "person" ? { type, ...person, ...common } : { type, companyName, ...common };
    const created = repo.createCustomer(payload);
    if (!created.ok) {
      setErrors(created.errors);
      return;
    }
    if (type === "company") contacts.forEach((k) => repo.addContact(created.value.id, k));
    router.push(`/customers/${created.value.id}`);
  };

  const c = (k: keyof typeof common) => (e: { target: { value: string } }) => setCommon((s) => ({ ...s, [k]: e.target.value }));

  return (
    <>
      <PageHeader title="Új ügyfél" description="Először válaszd ki az ügyfél típusát." />
      <form onSubmit={submit} noValidate className="space-y-6">
        <fieldset>
          <legend className="mb-2 text-sm font-medium">Ügyféltípus</legend>
          <div className="grid max-w-md grid-cols-2 gap-3">
            {(["person", "company"] as const).map((t) => (
              <label key={t} className={cn("flex min-h-12 cursor-pointer items-center justify-center rounded-lg px-4 text-sm font-medium ring-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent", type === t ? "bg-accent text-on-accent ring-accent" : "bg-surface ring-line-strong hover:bg-surface-muted")}>
                <input type="radio" name="type" value={t} checked={type === t} onChange={() => { setType(t); setErrors({}); }} className="sr-only" />
                {CUSTOMER_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>

        {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}

        <Card>
          <CardHeader title={type === "person" ? "Személyes adatlap" : "Vállalati adatlap"} />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            {type === "person" ? (
              <>
                <TextInput label="Vezetéknév" required value={person.lastName} error={errors.lastName} onChange={(e) => setPerson((s) => ({ ...s, lastName: e.target.value }))} />
                <TextInput label="Keresztnév" required value={person.firstName} error={errors.firstName} onChange={(e) => setPerson((s) => ({ ...s, firstName: e.target.value }))} />
              </>
            ) : (
              <TextInput className="sm:col-span-2" label="Cégnév" required value={companyName} error={errors.companyName} onChange={(e) => setCompanyName(e.target.value)} />
            )}
            <TextInput label={type === "company" ? "E-mail (opcionális)" : "E-mail"} type="email" value={common.email} error={errors.email} onChange={c("email")} />
            <TextInput label={type === "company" ? "Telefon (opcionális)" : "Telefon"} type="tel" value={common.phone} error={errors.phone} onChange={c("phone")} />
            <SelectInput label="Ügyfélstátusz" value={common.lifecycleStatus} onChange={c("lifecycleStatus")}>
              {LIFECYCLE_STATUSES.map((s) => <option key={s} value={s}>{LIFECYCLE_LABELS[s]}</option>)}
            </SelectInput>
            <SelectInput label="Felelős" required value={common.ownerId} error={errors.ownerId} onChange={c("ownerId")}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </SelectInput>
            {type === "person" ? <TextArea className="sm:col-span-2" label="Jegyzet (demó)" value={person.notes} onChange={(e) => setPerson((s) => ({ ...s, notes: e.target.value }))} hint="Ne írj be valós személyes adatot – ez csak demó." /> : null}
          </div>
        </Card>

        {type === "company" ? (
          <Card>
            <CardHeader title="Kapcsolattartók" count={contacts.length} action={<Button size="sm" variant="secondary" onClick={() => setContacts((cs) => [...cs, { ...emptyContact, isPrimaryContact: cs.length === 0 }])}>Kapcsolattartó hozzáadása</Button>} />
            {contacts.length === 0 ? <p className="p-4 text-sm text-ink-muted">Nincs még kapcsolattartó. Egy céghez 0..N kapcsolattartó vehető fel; később a cégprofilban is pótolható.</p> : null}
            <ul className="divide-y divide-line">
              {contacts.map((k, i) => (
                <li key={i} className="space-y-3 p-4">
                  <ContactFields
                    value={k}
                    errors={contactErrors[i]}
                    onChange={(v) => setContacts((cs) => cs.map((x, j) => (j === i ? v : v.isPrimaryContact ? { ...x, isPrimaryContact: false } : x)))}
                  />
                  <Button size="sm" variant="danger" onClick={() => setContacts((cs) => cs.filter((_, j) => j !== i))}>Kapcsolattartó eltávolítása</Button>
                </li>
              ))}
            </ul>
          </Card>
        ) : null}

        <div className="flex flex-wrap gap-2">
          <Button type="submit">Ügyfél létrehozása</Button>
          <Button variant="secondary" onClick={() => router.push("/customers")}>Mégse</Button>
        </div>
      </form>
    </>
  );
}
