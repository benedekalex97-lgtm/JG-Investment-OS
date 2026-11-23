"use client";

import Link from "next/link";
import { useMemo, useState } from "react";
import { DataGate } from "@/components/common";
import { TextInput } from "@/components/ui/form";
import { Badge, Button, Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { channelReport, type ChannelReport } from "@/domain/logic";
import type { DataSnapshot } from "@/domain/types";
import { cn } from "@/lib/cn";

/**
 * Csatornák (v1.2): csatornánként az ügyfelek száma Pipeline-státuszonként bontva, a létrehozás napja szerinti (budapesti nap) időszakszűrővel.
 * Egyszerű, olvasható kimutatás - a későbbi „Mérések” oldal alapja. A számok az aktív (nem eltávolított) ügyfelekből készülnek.
 */
function ReportTable({ report, from, to }: { report: ChannelReport; from: string; to: string }) {
  const cell = (n: number | undefined) => (n ? <span className="font-medium text-ink">{n}</span> : <span className="text-ink-subtle">0</span>);
  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[40rem] text-left text-sm" data-testid="channel-report">
        <caption className="sr-only">Ügyfelek száma érkezési csatornánként és Pipeline-státuszonként{from || to ? `, létrehozás: ${from || "…"} – ${to || "…"}` : ""}</caption>
        <thead className="text-xs uppercase tracking-wide text-ink-subtle">
          <tr>
            <th scope="col" className="sticky left-0 bg-surface px-4 py-2 font-medium">Érkezési csatorna</th>
            <th scope="col" className="px-3 py-2 text-right font-medium">Összesen</th>
            {report.statuses.map((s) => <th key={s.key} scope="col" className="px-3 py-2 text-right font-medium normal-case tracking-normal">{s.label}{s.archived ? <span className="block text-[11px] font-normal text-ink-subtle">archivált</span> : null}</th>)}
          </tr>
        </thead>
        <tbody className="divide-y divide-line">
          {report.rows.map((r) => (
            <tr key={r.channel} data-channel={r.channel} className={cn(r.total === 0 && "text-ink-muted")}>
              <th scope="row" className="sticky left-0 bg-surface px-4 py-2.5 text-left font-medium">
                <Link href={`/customers?csatorna=${encodeURIComponent(r.channel)}`} className="break-words text-accent hover:underline">{r.label}</Link>
                {r.def && !r.def.isActive ? <Badge tone="warn" className="ml-2">Archivált</Badge> : null}
                {!r.def ? <Badge tone="neutral" className="ml-2">Nincs a katalógusban</Badge> : null}
              </th>
              <td className="px-3 py-2.5 text-right font-semibold text-ink" data-testid="row-total">{r.total}</td>
              {report.statuses.map((s) => <td key={s.key} className="px-3 py-2.5 text-right">{cell(r.byStatus[s.key])}</td>)}
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr className="border-t-2 border-line-strong bg-canvas font-semibold">
            <th scope="row" className="sticky left-0 bg-canvas px-4 py-2.5 text-left">Összesen</th>
            <td className="px-3 py-2.5 text-right" data-testid="grand-total">{report.totals.total}</td>
            {report.statuses.map((s) => <td key={s.key} className="px-3 py-2.5 text-right">{report.totals.byStatus[s.key] ?? 0}</td>)}
          </tr>
        </tfoot>
      </table>
    </div>
  );
}

function Report({ data }: { data: DataSnapshot }) {
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const invalid = Boolean(from && to && from > to);
  const report = useMemo(() => channelReport(data, invalid ? {} : { from, to }), [data, from, to, invalid]);
  return (
    <div className="space-y-4">
      <Card>
        <div className="grid gap-3 p-4 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
          <TextInput label="Létrehozva ettől (nap)" type="date" value={from} onChange={(e) => setFrom(e.target.value)} max={to || undefined} />
          <TextInput label="Létrehozva eddig (nap, beleértve)" type="date" value={to} onChange={(e) => setTo(e.target.value)} min={from || undefined} />
          <Button variant="secondary" onClick={() => { setFrom(""); setTo(""); }} disabled={!from && !to}>Szűrő törlése</Button>
        </div>
        {invalid ? <p role="alert" className="border-t border-line px-4 py-3 text-sm text-danger">A kezdő nap nem lehet későbbi a záró napnál; a kimutatás az összes időszakot mutatja.</p> : null}
      </Card>
      <Card>
        <p className="border-b border-line px-4 py-3 text-[13px] text-ink-muted" role="status" aria-live="polite">
          {report.totals.total} ügyfél {from || to ? `(létrehozva: ${from || "kezdet"} – ${to || "ma"})` : "(teljes időszak)"}. A napok budapesti idő szerintiek.
        </p>
        {data.customers.length === 0 ? <EmptyState title="Még nincs rögzített ügyfél." hint="A kimutatás az ügyfelek érkezési csatornájából készül." /> : <ReportTable report={report} from={from} to={to} />}
      </Card>
    </div>
  );
}

export default function ChannelsReportPage() {
  return (
    <>
      <PageHeader
        title="Csatornák"
        description="Honnan érkeztek az ügyfelek: csatornánként az ügyfelek száma, kapcsolati státuszonként bontva. Az időszakszűrő az ügyfél létrehozásának napjára vonatkozik."
        actions={<><LinkButton href="/pipeline" variant="secondary">Pipeline</LinkButton><LinkButton href="/customers" variant="secondary">Ügyfelek</LinkButton></>}
      />
      <DataGate>{(data) => <Report data={data} />}</DataGate>
    </>
  );
}
