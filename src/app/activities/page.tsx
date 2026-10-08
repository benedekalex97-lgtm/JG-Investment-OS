"use client";

import { useState } from "react";
import { ActivityLine, DataGate } from "@/components/common";
import { ActivityFormModal } from "@/components/forms";
import { FilterSelect } from "@/components/ui/form";
import { Button, Card, EmptyState, PageHeader } from "@/components/ui/primitives";
import { ACTIVITY_LABELS, ACTIVITY_TYPES } from "@/domain/constants";
import type { ActivityType } from "@/domain/types";

export default function ActivitiesPage() {
  const [modal, setModal] = useState<ActivityType | null>(null);
  const [type, setType] = useState("");
  return (
    <>
      <PageHeader title="Tevékenységek" description="Belső demórekordok. Nincs kapcsolat telefonrendszerrel, naptárral vagy e-maillel." />
      <div className="mb-4 flex flex-wrap gap-2" role="group" aria-label="Rögzítés">
        <Button onClick={() => setModal("call")}>Hívás rögzítése</Button>
        <Button variant="secondary" onClick={() => setModal("note")}>Jegyzet rögzítése</Button>
        <Button variant="secondary" onClick={() => setModal("meeting")}>Meeting rögzítése</Button>
        <Button variant="secondary" onClick={() => setModal("follow_up")}>Utánkövetés rögzítése</Button>
      </div>
      <DataGate>
        {(data) => {
          const rows = data.activities.filter((a) => !type || a.type === type).sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt));
          return (
            <Card>
              <div className="border-b border-line p-4 sm:max-w-xs">
                <FilterSelect label="Típus" value={type} onChange={(e) => setType(e.target.value)}>
                  <option value="">Összes</option>
                  {ACTIVITY_TYPES.map((t) => <option key={t} value={t}>{ACTIVITY_LABELS[t]}</option>)}
                </FilterSelect>
              </div>
              {rows.length === 0 ? <EmptyState title="Nincs tevékenység" /> : <ul className="divide-y divide-line">{rows.map((a) => <ActivityLine key={a.id} activity={a} data={data} />)}</ul>}
            </Card>
          );
        }}
      </DataGate>
      {modal ? <ActivityFormModal open onClose={() => setModal(null)} initialType={modal} key={modal} /> : null}
    </>
  );
}
