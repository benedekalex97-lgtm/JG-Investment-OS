"use client";

import { useRouter } from "next/navigation";
import { useState, type FormEvent } from "react";
import { VerificationFields } from "@/components/forms";
import { SelectInput, TextInput } from "@/components/ui/form";
import { Button, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import { CRM_STATUSES, CRM_STATUS_LABELS, CUSTOMER_TYPE_LABELS, DEFAULT_CRM_STATUS } from "@/domain/constants";
import { isCrmMilestone } from "@/domain/workflow";
import { cn } from "@/lib/cn";

type Errors = Record<string, string>;

/**
 * Új ügyfél (v0.5): típusválasztás, majd csak az alapadatok. Az üzleti minimum a név (cégnél a cégnév); a telefonszám,
 * az e-mail, a kapcsolati személy, a szerep és az adatforrás opcionális. Nincs felelős-, folyamat- vagy egyéb adminisztratív mező.
 */
export default function NewCustomerPage() {
  const router = useRouter();
  const { repo, currentUserId } = useDemoData();
  const [type, setType] = useState<"individual" | "company">("individual");
  const [f, setF] = useState({ name: "", companyName: "", contactName: "", contactPosition: "", phone: "", email: "", source: "", crmStatus: DEFAULT_CRM_STATUS as string });
  const [vSource, setVSource] = useState("");
  const [vAck, setVAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const milestone = isCrmMilestone(f.crmStatus as typeof DEFAULT_CRM_STATUS);

  const submit = (e: FormEvent) => {
    e.preventDefault();
    const common = {
      phone: f.phone, email: f.email, source: f.source, crmStatus: f.crmStatus, recordedBy: currentUserId,
      verification: milestone && (vSource || vAck) ? { sourceCategory: vSource || undefined, complianceAcknowledged: vAck } : undefined,
    };
    const created = repo.createCustomerFromForm(
      type === "individual"
        ? { type, name: f.name, ...common }
        : { type, companyName: f.companyName, contactName: f.contactName, contactPosition: f.contactPosition, ...common },
    );
    if (!created.ok) return setErrors(created.errors);
    router.push(`/customers/${created.value.customer.id}`);
  };

  return (
    <>
      <PageHeader title="Új ügyfél" description="Válaszd ki az ügyfél típusát. Csak a név kötelező; a többi adat később is megadható." />
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
          <CardHeader title={type === "company" ? "Cég" : "Magánszemély"} />
          <div className="grid gap-4 p-4 sm:grid-cols-2">
            {type === "company" ? (
              <>
                <TextInput label="Cégnév" required value={f.companyName} error={errors.companyName} onChange={set("companyName")} autoComplete="off" />
                <TextInput label="Kapcsolati személy neve (ha ismert)" value={f.contactName} onChange={set("contactName")} autoComplete="off" />
                <TextInput label="Beosztás / szerepkör (opcionális)" value={f.contactPosition} onChange={set("contactPosition")} autoComplete="off" />
              </>
            ) : (
              <TextInput label="Név" required value={f.name} error={errors.name} onChange={set("name")} autoComplete="off" />
            )}
            <TextInput label="Telefonszám (ha ismert)" type="tel" value={f.phone} error={errors.phone} onChange={set("phone")} autoComplete="off" />
            <TextInput label="E-mail (ha ismert)" type="email" value={f.email} error={errors.email} onChange={set("email")} autoComplete="off" />
            <TextInput label="Adatforrás (ha ismert)" value={f.source} onChange={set("source")} hint="Pl. weboldali érdeklődés, ajánlás, kontaktadatbázis." />
            <SelectInput label="Kapcsolati státusz" value={f.crmStatus} error={errors.toStatus} onChange={set("crmStatus")}>
              {CRM_STATUSES.map((s) => <option key={s} value={s}>{CRM_STATUS_LABELS[s]}</option>)}
            </SelectInput>
            {milestone ? (
              <div className="sm:col-span-2"><VerificationFields source={vSource} ack={vAck} onSource={setVSource} onAck={setVAck} error={errors.verification} /></div>
            ) : null}
          </div>
        </Card>

        <p className="text-[13px] text-ink-muted">Demó: ne rögzíts valós személyes adatot. Az adatok csak ebben a böngészőfülben élnek.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit">Ügyfél létrehozása</Button>
          <Button variant="secondary" onClick={() => router.push("/customers")}>Mégse</Button>
        </div>
      </form>
    </>
  );
}
