"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useMemo, useRef, useState, type FormEvent } from "react";
import { VerificationFields } from "@/components/forms";
import { SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader, PageHeader } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";
import { CUSTOMER_TYPE_LABELS, DEFAULT_CRM_STATUS } from "@/domain/constants";
import { activeOf, ACQUISITION_DETAIL_MAX } from "@/domain/config";
import { useCrmConfig } from "@/components/common";
import { findDuplicates, type DuplicateCandidate } from "@/domain/duplicates";
import { splitPhoneList } from "@/domain/phones";
import { isCrmMilestone } from "@/domain/workflow";
import { cn } from "@/lib/cn";

type Errors = Record<string, string>;

/**
 * Új ügyfél (v0.5): típusválasztás, majd csak az alapadatok. Az üzleti minimum a név (cégnél a cégnév); a telefonszám,
 * az e-mail, a kapcsolati személy, a szerep és az adatforrás opcionális. Nincs felelős-, folyamat- vagy egyéb adminisztratív mező.
 */
export default function NewCustomerPage() {
  const router = useRouter();
  const { repo, data, permissions } = useCrmData();
  const canConfirmSuppression = permissions.includes("crm.privacy.manage");
  const [suppressionOk, setSuppressionOk] = useState(false);
  const config = useCrmConfig();
  const [busy, setBusy] = useState(false);
  const [type, setType] = useState<"individual" | "company">("individual");
  const [f, setF] = useState({ name: "", companyName: "", contactName: "", contactPosition: "", phone: "", extraPhones: "", email: "", source: "", crmStatus: DEFAULT_CRM_STATUS as string, acquisitionChannel: "", acquisitionDetail: "" });
  const [vSource, setVSource] = useState("");
  const [vAck, setVAck] = useState(false);
  const [errors, setErrors] = useState<Errors>({});
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));
  const milestone = isCrmMilestone(config, f.crmStatus);
  // CRM-013: lehetséges duplikációk már gépelés közben (a betöltött, aktív ügyfelekből); a szerver mentés előtt újra ellenőriz.
  const local = useMemo(
    () => (data ? findDuplicates(data, { type, name: f.name, companyName: f.companyName, contactName: f.contactName, phone: f.phone, extraPhones: splitPhoneList(f.extraPhones), email: f.email }) : []),
    [data, type, f.name, f.companyName, f.contactName, f.phone, f.extraPhones, f.email],
  );
  const [serverDup, setServerDup] = useState<DuplicateCandidate[]>([]);
  const [needDecision, setNeedDecision] = useState(false);
  const dupPanel = useRef<HTMLElement>(null);
  const shownDup = [...local, ...serverDup.filter((d) => !d.customerId || !local.some((l) => l.customerId === d.customerId))];

  const submit = async (e: FormEvent, confirmDuplicates = false) => {
    e.preventDefault();
    if (busy) return;
    if (!confirmDuplicates && local.length) {
      // A figyelmeztetés nem tilt: a felhasználó dönt (meglévő megnyitása vagy mégis új ügyfél).
      setNeedDecision(true);
      dupPanel.current?.focus();
      return;
    }
    const common = {
      phone: f.phone, extraPhones: f.extraPhones, email: f.email, source: f.source, crmStatus: f.crmStatus,
      acquisitionChannel: f.acquisitionChannel || undefined, acquisitionDetail: f.acquisitionDetail,
      verification: milestone && (vSource || vAck) ? { sourceCategory: vSource || undefined, complianceAcknowledged: vAck } : undefined,
    };
    setBusy(true);
    const created = await repo.createCustomerFromForm(
      type === "individual"
        ? { type, name: f.name, ...common }
        : { type, companyName: f.companyName, contactName: f.contactName, contactPosition: f.contactPosition, ...common },
      { confirmDuplicates, confirmSuppression: suppressionOk },
    );
    if (!created.ok) {
      setBusy(false);
      if (created.duplicates?.length) {
        setServerDup(created.duplicates);
        setNeedDecision(true);
        setTimeout(() => dupPanel.current?.focus(), 0);
        return;
      }
      return setErrors(created.errors);
    }
    router.push(`/customers/${created.value.customer.id}`);
  };

  return (
    <>
      <PageHeader title="Új ügyfél" description="Válaszd ki az ügyfél típusát. A név és az érkezési csatorna kötelező; a többi adat később is megadható." />
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
        {errors._suppressed ? (
          <div role="alert" className="space-y-2 rounded-md bg-danger-soft p-3 text-sm text-danger" data-testid="suppression-warning">
            <p>{errors._suppressed}</p>
            {canConfirmSuppression ? (
              <label className="flex items-start gap-2 text-ink">
                <input type="checkbox" className="mt-1" checked={suppressionOk} onChange={(e) => setSuppressionOk(e.target.checked)} />
                <span>Az érintett maga kezdeményezett új kapcsolatfelvételt; a rögzítést vállalom (naplózódik).</span>
              </label>
            ) : null}
          </div>
        ) : null}

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
            <TextArea label="További telefonszámok (opcionális)" rows={2} value={f.extraPhones} error={errors.extraPhones} onChange={set("extraPhones")} autoComplete="off" hint="Vesszővel, pontosvesszővel vagy új sorral elválasztva; legfeljebb 9 szám. A „Hívás” gomb a fő számot tárcsázza." />
            <TextInput label="E-mail (ha ismert)" type="email" value={f.email} error={errors.email} onChange={set("email")} autoComplete="off" />
            <TextInput label="Adatforrás (ha ismert)" value={f.source} onChange={set("source")} hint="Az adat eredete (pl. import forrása, kontaktadatbázis) - nem azonos az érkezési csatornával." />
            <SelectInput label="Érkezési csatorna" required value={f.acquisitionChannel} error={errors.acquisitionChannel} onChange={set("acquisitionChannel")} hint="Honnan érkezett az ügyfél? Az „Ismeretlen” is választható, de tudatosan.">
              <option value="">— válassz —</option>
              {activeOf(config.acquisitionChannels).map((c) => <option key={c.key} value={c.key}>{c.label}</option>)}
            </SelectInput>
            <TextInput label="Érkezési csatorna részlete (opcionális)" value={f.acquisitionDetail} error={errors.acquisitionDetail} onChange={set("acquisitionDetail")} maxLength={ACQUISITION_DETAIL_MAX} hint="Pl. TBSZ-útmutató; bemutatkozó levél, 2026. nov.; ajánlotta: meglévő ügyfél." autoComplete="off" />
            <SelectInput label="Kapcsolati státusz" value={f.crmStatus} error={errors.toStatus} onChange={set("crmStatus")}>
              {activeOf(config.statuses).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
            </SelectInput>
            {milestone ? (
              <div className="sm:col-span-2"><VerificationFields source={vSource} ack={vAck} onSource={setVSource} onAck={setVAck} error={errors.verification} /></div>
            ) : null}
          </div>
        </Card>

        {shownDup.length ? (
          <section ref={dupPanel} tabIndex={-1} aria-labelledby="duplikacio-cim" className="space-y-3 rounded-lg bg-warn-soft p-4 ring-1 ring-warn/25 focus:outline-2 focus:outline-accent" data-testid="duplicate-warning">
            <h2 id="duplikacio-cim" className="text-sm font-semibold text-warn">Lehetséges, hogy ez az ügyfél már szerepel az adatbázisban.</h2>
            {needDecision ? <p role="alert" className="text-sm text-ink">Nézd meg a meglévő ügyfelet, vagy ha biztosan másik ügyfélről van szó, hozd létre mégis az újat.</p> : null}
            <ul className="space-y-2">
              {shownDup.map((d, i) => (
                <li key={d.customerId ?? `removed-${i}`} className="rounded-md bg-surface p-3 text-sm ring-1 ring-line">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium">{d.name}</span>
                    <span className="text-[13px] text-ink-muted">{d.typeLabel}</span>
                    <Badge tone={d.level === "strong" ? "warn" : "neutral"}>{d.level === "strong" ? "Erős egyezés" : "Lehetséges egyezés"}</Badge>
                  </p>
                  <p className="mt-1 break-words text-[13px] text-ink-muted">{d.reasons.join(" · ")}</p>
                  {d.customerId ? (
                    <Link href={`/customers/${d.customerId}`} className="mt-1 inline-flex min-h-9 items-center text-[13px] font-medium text-accent underline underline-offset-2">Meglévő ügyfél megnyitása<span className="sr-only">: {d.name}</span></Link>
                  ) : <p className="mt-1 text-[13px] text-ink-muted">Az egyező rekord már nem része az aktív CRM-nek; adatai nem jeleníthetők meg. Visszaállításhoz fordulj az üzemeltetőhöz.</p>}
                </li>
              ))}
            </ul>
            <Button variant="secondary" disabled={busy} onClick={(e) => void submit(e, true)}>Mégis új ügyfél létrehozása</Button>
          </section>
        ) : null}

        <p className="text-[13px] text-ink-muted">Az adat az adatbázisba mentődik. Fiktív/előnézeti környezetben ne rögzíts valós személyes adatot.</p>
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={busy} aria-busy={busy}>Ügyfél létrehozása</Button>
          <Button variant="secondary" onClick={() => router.push("/customers")} disabled={busy}>Mégse</Button>
        </div>
      </form>
    </>
  );
}
