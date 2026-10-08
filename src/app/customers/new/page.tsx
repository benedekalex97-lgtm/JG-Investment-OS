"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { ContactFields, emptyContact, type ContactValues } from "@/components/forms";
import { SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Button, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { companyContactInput } from "@/domain/schemas";
import { useDemoData } from "@/data/store";
import { CUSTOMER_TYPE_LABELS, DEMO_USERS, OUTREACH_CHANNELS, OUTREACH_CHANNEL_LABELS, OUTREACH_COMPLIANCE_NOTICE, PROCESS_SOURCES, PROCESS_SOURCE_LABELS } from "@/domain/constants";
import { cn } from "@/lib/cn";

type Errors = Record<string, string>;

export default function NewCustomerPage() {
  const router = useRouter();
  const { repo, data, currentUserId } = useDemoData();
  const [type, setType] = useState<"individual" | "company">("individual");
  const [common, setCommon] = useState({ ownerId: DEMO_USERS[0].id, email: "", phone: "" });
  const [initial, setInitial] = useState({ start: "", title: "", channel: "phone", source: "contact_database" });
  const [individual, setIndividual] = useState({ firstName: "", lastName: "", notes: "" });
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
    const payload = type === "individual" ? { type, ...individual, ...common } : { type, companyName, ...common };
    const created = repo.createCustomer(payload);
    if (!created.ok) {
      setErrors(created.errors);
      return;
    }
    if (type === "company") contacts.forEach((k) => repo.addContact(created.value.id, k));
    if (initial.start) {
      const r = repo.createProcess({
        customerId: created.value.id, type: initial.start, title: initial.title || (initial.start === "inbound_inquiry" ? "Bejövő érdeklődés" : "Kimenő kapcsolatépítés"),
        channel: initial.channel, source: initial.source, ownerId: common.ownerId, recordedBy: currentUserId,
      });
      if (!r.ok) {
        setErrors({ _form: `Az ügyfél létrejött, de a folyamat nem indult el: ${Object.values(r.errors)[0]}` });
        router.push(`/customers/${created.value.id}`);
        return;
      }
    }
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
            {(["individual", "company"] as const).map((t) => (
              <label key={t} className={cn("flex min-h-12 cursor-pointer items-center justify-center rounded-lg px-4 text-sm font-medium ring-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent", type === t ? "bg-accent text-on-accent ring-accent" : "bg-surface ring-line-strong hover:bg-surface-muted")}>
                <input type="radio" name="type" value={t} checked={type === t} onChange={() => { setType(t); setErrors({}); }} className="sr-only" />
                {CUSTOMER_TYPE_LABELS[t]}
              </label>
            ))}
          </div>
        </fieldset>

        {errors._form ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{errors._form}</p> : null}

        <Card>
          <CardHeader title={type === "individual" ? "Személyes adatlap" : "Vállalati adatlap"} />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            {type === "individual" ? (
              <>
                <TextInput label="Vezetéknév" required value={individual.lastName} error={errors.lastName} onChange={(e) => setIndividual((s) => ({ ...s, lastName: e.target.value }))} />
                <TextInput label="Keresztnév" required value={individual.firstName} error={errors.firstName} onChange={(e) => setIndividual((s) => ({ ...s, firstName: e.target.value }))} />
              </>
            ) : (
              <TextInput className="sm:col-span-2" label="Cégnév" required value={companyName} error={errors.companyName} onChange={(e) => setCompanyName(e.target.value)} />
            )}
            <TextInput label={type === "company" ? "E-mail (opcionális)" : "E-mail"} type="email" value={common.email} error={errors.email} onChange={c("email")} />
            <TextInput label={type === "company" ? "Telefon (opcionális)" : "Telefon"} type="tel" value={common.phone} error={errors.phone} onChange={c("phone")} />
            <p className="self-end rounded-md bg-surface-muted p-3 text-[13px] text-ink-muted">Az új ügyfél kapcsolati státusza: <strong>Potenciális ügyfél</strong>. A besorolás később külön, naplózott műveletben módosítható.</p>
            <SelectInput label="Felelős" required value={common.ownerId} error={errors.ownerId} onChange={c("ownerId")}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </SelectInput>
            {type === "individual" ? <TextArea className="sm:col-span-2" label="Jegyzet (demó)" value={individual.notes} onChange={(e) => setIndividual((s) => ({ ...s, notes: e.target.value }))} hint="Ne írj be valós személyes adatot – ez csak demó." /> : null}
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

        <Card>
          <CardHeader title="Kezdő folyamat (opcionális)" />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <SelectInput label="Folyamat indítása" value={initial.start} onChange={(e) => setInitial((s) => ({ ...s, start: e.target.value, source: e.target.value === "inbound_inquiry" ? "web_inquiry" : "contact_database", channel: e.target.value === "inbound_inquiry" ? "web_form" : "phone" }))}>
              <option value="">Nem indítok folyamatot</option>
              <option value="outbound_outreach">Kimenő kapcsolatépítés</option>
              <option value="inbound_inquiry">Bejövő érdeklődés</option>
            </SelectInput>
            {initial.start ? (
              <>
                <TextInput label="Rövid megnevezés (opcionális)" value={initial.title} onChange={(e) => setInitial((s) => ({ ...s, title: e.target.value }))} />
                <SelectInput label="Megkeresési csatorna" value={initial.channel} onChange={(e) => setInitial((s) => ({ ...s, channel: e.target.value }))}>
                  {OUTREACH_CHANNELS.map((c) => <option key={c} value={c}>{OUTREACH_CHANNEL_LABELS[c]}</option>)}
                </SelectInput>
                <SelectInput label="Forrás" value={initial.source} onChange={(e) => setInitial((s) => ({ ...s, source: e.target.value }))}>
                  {PROCESS_SOURCES.map((c) => <option key={c} value={c}>{PROCESS_SOURCE_LABELS[c]}</option>)}
                </SelectInput>
              </>
            ) : null}
            {initial.start === "outbound_outreach" ? <p className="rounded-md bg-warn-soft p-3 text-[13px] text-ink sm:col-span-2">{OUTREACH_COMPLIANCE_NOTICE}</p> : null}
          </div>
        </Card>

        <div className="flex flex-wrap gap-2">
          <Button type="submit">Ügyfél létrehozása</Button>
          <Button variant="secondary" onClick={() => router.push("/customers")}>Mégse</Button>
        </div>
      </form>
    </>
  );
}
