"use client";

import { useState } from "react";
import { CapitalPlacedModal } from "@/components/forms";
import { useCrmData } from "@/data/store";
import { activeOf, findStatus } from "@/domain/config";
import { useCrmConfig } from "@/components/common";
import { statusOf } from "@/domain/logic";
import type { Customer } from "@/domain/types";
import { isCrmMilestone } from "@/domain/workflow";

/**
 * Az ügyfél egyetlen aktuális kapcsolati státusza, szerkeszthető választóként az ügyfél neve mellett (az adatlap fejlécében).
 * A választható értékek a katalógus AKTÍV státuszai (v1.1); ha az ügyfél archivált státuszban van, az a jelenlegi értékként látszik,
 * de nem választható újra. Kötelező sorrend nincs; a váltás nem érinti a feladatokat. Az igazolást igénylő (mérföldkő) státusznál
 * igazolási párbeszéd nyílik, a státusz csak annak megerősítésekor változik.
 */
export function StatusSelect({ customer }: { customer: Customer }) {
  const { repo } = useCrmData();
  const config = useCrmConfig();
  const [verifying, setVerifying] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const current = statusOf(customer);
  const currentDef = findStatus(config, current);
  const onChange = async (value: string) => {
    setError("");
    if (isCrmMilestone(config, value)) return setVerifying(value);
    setBusy(true);
    const r = await repo.changeCrmStatus(customer.id, { toStatus: value });
    setBusy(false);
    // Sikertelen mentésnél a választó a mentett (szerver) állapotot mutatja tovább.
    if (!r.ok) setError(r.errors.toStatus ?? r.errors._form ?? "A státusz nem módosítható.");
  };
  return (
    <div className="w-full sm:w-72">
      <select
        aria-label="Kapcsolati státusz"
        aria-invalid={Boolean(error)}
        value={current}
        disabled={busy}
        onChange={(e) => void onChange(e.target.value)}
        className="block min-h-11 w-full rounded-md bg-accent-soft px-3 text-sm font-semibold text-accent ring-1 ring-accent/40 focus-visible:outline-2 focus-visible:outline-accent aria-[invalid=true]:ring-danger"
      >
        {currentDef && !currentDef.isActive ? <option value={current} disabled>{currentDef.label} (archivált)</option> : null}
        {!currentDef ? <option value={current} disabled>{current}</option> : null}
        {activeOf(config.statuses).map((s) => <option key={s.key} value={s.key}>{s.label}</option>)}
      </select>
      {error ? <p role="alert" className="mt-1 text-[13px] text-danger">{error}</p> : null}
      <CapitalPlacedModal open={verifying !== null} status={verifying ?? ""} onClose={() => setVerifying(null)} customer={customer} />
    </div>
  );
}
