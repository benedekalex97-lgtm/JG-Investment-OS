"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { VerificationFields } from "@/components/forms";
import { SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Button, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import {
  CONTACT_STATUSES, CONTACT_STATUS_LABELS, CUSTOMER_TYPE_LABELS, DEMO_USERS, OUTREACH_CHANNELS, OUTREACH_CHANNEL_LABELS, OUTREACH_COMPLIANCE_NOTICE,
  PROCESS_SOURCES, PROCESS_SOURCE_LABELS, VERIFIED_CONTACT_STATUSES,
} from "@/domain/constants";
import { cn } from "@/lib/cn";

type Errors = Record<string, string>;

/**
 * Új ügyfél (v0.3, egyszerűsített): típusválasztás, majd csak az üzleti minimum.
 * Magánszemély: név + telefon. Cég: cégnév + kapcsolati személy neve + telefon.
 * E-mail és beosztás/szerep sosem kötelező.
 */
export default function NewCustomerPage() {
  const router = useRouter();
  const { repo, currentUserId } = useDemoData();
  const [type, setType] = useState<"individual" | "company">("individual");
  const [f, setF] = useState({
    lastName: "", firstName: "", phone: "", email: "", notes: "", companyName: "",
    contactLast: "", contactFirst: "", contactPhone: "", contactEmail: "", contactPosition: "",
    contactStatus: "prospect", source: "", ownerId: currentUserId,
  });
  const [vSource, setVSource] = useState("");
  const [vAck, setVAck] = useState(false);
  const [initial, setInitial] = useState({ start: "", title: "", channel: "phone", source: "contact_database" });
  const [errors, setErrors] = useState<Errors>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const needsVerification = (VERIFIED_CONTACT_STATUSES as readonly string[]).includes(f.contactStatus);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const common = {
      ownerId: f.ownerId, source: f.source, contactStatus: f.contactStatus, recordedBy: currentUserId,
      verification: needsVerification && (vSource || vAck) ? { sourceCategory: vSource || undefined, complianceAcknowledged: vAck } : undefined,
    };
    const payload =
      type === "individual"
        ? { type, firstName: f.firstName, lastName: f.lastName, phone: f.phone, email: f.email, notes: f.notes, ...common }
        : { type, companyName: f.companyName, contact: { firstName: f.contactFirst, lastName: f.contactLast, phone: f.contactPhone, email: f.contactEmail, position: f.contactPosition }, ...common };
    const created = repo.createCustomerFromForm(payload);
    if (!created.ok) {
      setErrors(created.errors);
      return;
    }
    const id = created.value.customer.id;
    if (initial.start) {
      const r = repo.createProcess({
        customerId: id, type: initial.start, title: initial.title || (initial.start === "inbound_inquiry" ? "Bejövő érdeklődés" : "Kimenő kapcsolatépítés"),
        channel: initial.channel, source: initial.source, ownerId: f.ownerId, recordedBy: currentUserId,
      });
      // Az ügyfél ekkor már létrejött; a folyamat hibája nem veszíti el az ügyfelet, az adatlapon pótolható.
      if (!r.ok) {
        router.push(`/customers/${id}`);
        return;
      }
    }
    router.push(`/customers/${id}`);
  };

  const contactFieldError = (k: string) => (type === "company" ? errors[k] : undefined);

  return (
    <>
      <PageHeader title="Új ügyfél" description="Válaszd ki az ügyfél típusát, majd add meg az alapadatokat. Az e-mail és a beosztás nem kötelező." />
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

        {type === "individual" ? (
          <Card>
            <CardHeader title="Személyes adatok" />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <TextInput label="Vezetéknév" required value={f.lastName} error={errors.lastName} onChange={set("lastName")} autoComplete="off" />
              <TextInput label="Keresztnév" required value={f.firstName} error={errors.firstName} onChange={set("firstName")} autoComplete="off" />
              <TextInput label="Telefonszám" required type="tel" value={f.phone} error={errors.phone} onChange={set("phone")} autoComplete="off" />
              <TextInput label="E-mail (opcionális)" type="email" value={f.email} error={errors.email} onChange={set("email")} autoComplete="off" />
              <TextArea className="sm:col-span-2" label="Jegyzet (opcionális)" value={f.notes} onChange={set("notes")} hint="Ne írj be valós személyes adatot: ez csak demó." />
            </div>
          </Card>
        ) : (
          <>
            <Card>
              <CardHeader title="Cégadatok" />
              <div className="grid gap-4 p-4">
                <TextInput label="Cégnév" required value={f.companyName} error={errors.companyName} onChange={set("companyName")} autoComplete="off" />
              </div>
            </Card>
            <Card>
              <CardHeader title="Kapcsolati adatok" />
              <div className="grid gap-4 p-4 sm:grid-cols-2">
                <TextInput label="Kapcsolati személy vezetékneve" required value={f.contactLast} error={contactFieldError("lastName")} onChange={set("contactLast")} autoComplete="off" />
                <TextInput label="Kapcsolati személy keresztneve" required value={f.contactFirst} error={contactFieldError("firstName")} onChange={set("contactFirst")} autoComplete="off" />
                <TextInput label="Telefonszám" required type="tel" value={f.contactPhone} error={contactFieldError("phone")} onChange={set("contactPhone")} autoComplete="off" />
                <TextInput label="E-mail (opcionális)" type="email" value={f.contactEmail} error={contactFieldError("email")} onChange={set("contactEmail")} autoComplete="off" />
                <TextInput className="sm:col-span-2" label="Beosztás / szerepkör (opcionális)" value={f.contactPosition} onChange={set("contactPosition")} autoComplete="off" />
              </div>
            </Card>
          </>
        )}

        <Card>
          <CardHeader title="Nyilvántartási adatok" />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            <SelectInput label="Kapcsolati státusz" value={f.contactStatus} error={errors.contactStatus} onChange={set("contactStatus")}>
              {CONTACT_STATUSES.map((s) => <option key={s} value={s}>{CONTACT_STATUS_LABELS[s]}</option>)}
            </SelectInput>
            <SelectInput label="Felelős" required value={f.ownerId} error={errors.ownerId} onChange={set("ownerId")}>
              {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
            </SelectInput>
            <TextInput className="sm:col-span-2" label="Adatforrás (ha ismert)" value={f.source} onChange={set("source")} hint="Pl. weboldali érdeklődés, ajánlás, kontaktadatbázis." />
            {needsVerification ? (
              <div className="sm:col-span-2">
                <VerificationFields source={vSource} ack={vAck} onSource={setVSource} onAck={setVAck} error={errors.verification} />
              </div>
            ) : null}
          </div>
        </Card>

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
                <SelectInput label="Folyamat forrása" value={initial.source} onChange={(e) => setInitial((s) => ({ ...s, source: e.target.value }))}>
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
