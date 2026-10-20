"use client";

import { useState } from "react";
import { useUserName } from "@/components/common";
import { Button, Card, CardHeader, EmptyState } from "@/components/ui/primitives";
import { CLOSURE_LABELS, PROCESS_STATUS_LABELS } from "@/domain/constants";
import { customerHistory, type HistoryEntry } from "@/domain/history";
import type { Customer, DataSnapshot } from "@/domain/types";
import { cn } from "@/lib/cn";
import { formatDate, formatDateTime } from "@/lib/format";

const PAGE = 30;

/** Visszafogott jelölés a bal szélen: lezárásnál a minősítés színe, egyébként semleges. */
const MARK: Record<string, string> = { success: "border-ok", failure: "border-danger", task: "border-accent/40", status: "border-info/50", other: "border-line-strong" };

function Entry({ e }: { e: HistoryEntry }) {
  const userName = useUserName();
  return (
    <li className={cn("border-l-4 px-4 py-3", MARK[e.outcome ?? e.kind])}>
      <p className="text-[13px] text-ink-muted"><time dateTime={e.occurredAt}>{formatDateTime(e.occurredAt)}</time></p>
      <h3 className="mt-0.5 text-sm font-semibold text-ink">{e.title}</h3>
      {e.details.length ? (
        <dl className="mt-1 space-y-0.5 text-sm">
          {e.details.map((d, i) => (
            <div key={`${d.label}-${i}`} className="flex min-w-0 flex-wrap gap-x-1">
              <dt className="text-ink-muted">{d.label}:</dt>
              <dd className={cn("min-w-0 break-words", d.multiline && "basis-full whitespace-pre-wrap sm:basis-auto")}>{d.value}</dd>
            </div>
          ))}
        </dl>
      ) : null}
      <p className="mt-1 text-[13px] text-ink-muted">Rögzítette: {userName(e.recordedBy)}</p>
    </li>
  );
}

/**
 * Előzmények (v0.9): mindig látható (nem lenyitható), időrendi lista - a legfrissebb esemény elöl. A meglévő aktivitásnaplóból
 * dolgozik: feladat létrehozása, Sikeres/Sikertelen lezárás az adott lezárás Outputjával, újranyitás, átidőzítés, kapcsolati
 * státusz változása és minden korábbi naplózott esemény. A régi folyamatok (archív adat) a lista alatt maradnak elérhetők.
 * Az ügyféljegyzetek külön blokkban vannak.
 */
export function CustomerHistory({ data, customer }: { data: DataSnapshot; customer: Customer }) {
  const userName = useUserName();
  const [shown, setShown] = useState(PAGE);
  const entries = customerHistory(data, customer.id, formatDate);
  const processes = data.processes.filter((p) => p.customerId === customer.id);
  const rest = entries.length - shown;
  return (
    <Card id="elozmenyek">
      <CardHeader title="Előzmények" count={entries.length} />
      {entries.length ? (
        <ol className="divide-y divide-line" aria-label="Előzmények, a legfrissebb elöl">
          {entries.slice(0, shown).map((e) => <Entry key={e.id} e={e} />)}
        </ol>
      ) : (
        <EmptyState title="Még nincs rögzített esemény" hint="A feladatok létrehozása, lezárása, átidőzítése és a státuszváltások itt jelennek meg." />
      )}
      {rest > 0 ? (
        <div className="border-t border-line p-3">
          <Button variant="secondary" size="sm" onClick={() => setShown((n) => n + PAGE)}>További {Math.min(rest, PAGE)} esemény megjelenítése ({rest} még)</Button>
        </div>
      ) : null}
      {processes.length ? (
        <section aria-labelledby="regi-folyamatok-cim" className="border-t border-line p-4">
          <h3 id="regi-folyamatok-cim" className="mb-2 text-xs font-semibold uppercase tracking-wide text-ink-subtle">Régi folyamatok (archív)</h3>
          <ul className="space-y-1 text-sm">
            {processes.map((p) => (
              <li key={p.id} className="break-words">{p.title} · {PROCESS_STATUS_LABELS[p.status]} · {CLOSURE_LABELS[p.closure.state]} · {userName(p.ownerId)}</li>
            ))}
          </ul>
          <p className="mt-2 text-[13px] text-ink-muted">A korábbi folyamatok adata megmaradt; a jelenlegi felület nem kezeli, és nincs leképezve az új státuszokra.</p>
        </section>
      ) : null}
    </Card>
  );
}
