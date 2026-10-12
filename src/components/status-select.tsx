"use client";

import { useState } from "react";
import { CapitalPlacedModal } from "@/components/forms";
import { useDemoData } from "@/data/store";
import { CRM_STATUSES, CRM_STATUS_LABELS } from "@/domain/constants";
import { statusOf } from "@/domain/logic";
import type { Customer } from "@/domain/types";
import { isCrmMilestone } from "@/domain/workflow";

/**
 * Az ügyfél egyetlen aktuális kapcsolati státusza, szerkeszthető választóként az ügyfél neve mellett (az adatlap fejlécében).
 * Hét választható érték, kézzel módosítható, kötelező sorrend nélkül; a váltás nem érinti a feladatokat. A „Tőke elhelyezve”
 * szolgáltatói mérföldkő: igazolási párbeszéd nyílik, a státusz csak annak megerősítésekor változik.
 */
export function StatusSelect({ customer }: { customer: Customer }) {
  const { repo, currentUserId } = useDemoData();
  const [verifying, setVerifying] = useState(false);
  const [error, setError] = useState("");
  const current = statusOf(customer);
  const onChange = (value: string) => {
    setError("");
    if (isCrmMilestone(value as typeof current)) return setVerifying(true);
    const r = repo.changeCrmStatus(customer.id, { toStatus: value, recordedBy: currentUserId });
    if (!r.ok) setError(r.errors.toStatus ?? r.errors._form ?? "A státusz nem módosítható.");
  };
  return (
    <div className="w-full sm:w-72">
      <select
        aria-label="Kapcsolati státusz"
        aria-invalid={Boolean(error)}
        value={current}
        onChange={(e) => onChange(e.target.value)}
        className="block min-h-11 w-full rounded-md bg-accent-soft px-3 text-sm font-semibold text-accent ring-1 ring-accent/40 focus-visible:outline-2 focus-visible:outline-accent aria-[invalid=true]:ring-danger"
      >
        {CRM_STATUSES.map((s) => <option key={s} value={s}>{CRM_STATUS_LABELS[s]}</option>)}
      </select>
      {error ? <p role="alert" className="mt-1 text-[13px] text-danger">{error}</p> : null}
      <CapitalPlacedModal open={verifying} onClose={() => setVerifying(false)} customer={customer} />
    </div>
  );
}
