"use client";

import { useState } from "react";
import { CapitalPlacedModal } from "@/components/forms";
import { SelectInput } from "@/components/ui/form";
import { Card, CardHeader } from "@/components/ui/primitives";
import { useDemoData } from "@/data/store";
import { CRM_STATUSES, CRM_STATUS_LABELS } from "@/domain/constants";
import { statusOf } from "@/domain/logic";
import type { Customer } from "@/domain/types";
import { isCrmMilestone } from "@/domain/workflow";

/**
 * Az ügyfél egyetlen aktuális kapcsolati státusza: hét választható érték, kézzel módosítható, kötelező sorrend nélkül.
 * A váltás nem érinti a feladatokat. A „Tőke elhelyezve” szolgáltatói mérföldkő: igazolási párbeszéd nyílik.
 */
export function StatusPanel({ customer }: { customer: Customer }) {
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
    <Card id="statusz">
      <CardHeader title="Kapcsolati státusz" />
      <div className="space-y-2 p-4">
        <SelectInput label="Aktuális státusz" value={current} error={error} onChange={(e) => onChange(e.target.value)}>
          {CRM_STATUSES.map((s) => <option key={s} value={s}>{CRM_STATUS_LABELS[s]}</option>)}
        </SelectInput>
        <p className="text-[13px] text-ink-muted">A státusz kézzel módosítható, kötelező sorrend nélkül. A váltás nem töröl, nem pipál ki és nem hoz létre feladatot.</p>
      </div>
      <CapitalPlacedModal open={verifying} onClose={() => setVerifying(false)} customer={customer} />
    </Card>
  );
}
