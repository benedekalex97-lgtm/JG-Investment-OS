"use client";

import { useEffect, useState } from "react";
import { PermissionGate } from "@/components/data/data-nav";
import { Badge, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { getJson } from "@/data/data-client";
import { SOURCE_VERIFICATION_LABELS, type SourceVerification } from "@/domain/data-import";
import type { ImportJobView } from "@/server/data/import";
import { formatDateTime } from "@/lib/format";

/** Importelőzmények (CRM-016): az importnapló személyes adat nélküli metaadatai (fájlnév és sortartalom nincs tárolva). */
function History() {
  const [jobs, setJobs] = useState<ImportJobView[] | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    void (async () => {
      const r = await getJson<{ jobs: ImportJobView[] }>("/api/data/import/jobs");
      if (r.ok) setJobs(r.value.jobs); else setError(r.message);
    })();
  }, []);
  if (error) return <ErrorState message={error} />;
  if (!jobs) return <LoadingState />;
  if (!jobs.length) return <Card><EmptyState title="Még nem volt import." hint="Az importelőzmények itt jelennek meg az előnézet elkészítésétől kezdve." /></Card>;
  return (
    <ul className="space-y-3" aria-label="Importelőzmények">
      {jobs.map((j) => (
        <li key={j.id} className="rounded-lg bg-surface p-4 ring-1 ring-line" data-testid="import-job">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-ink">{formatDateTime(j.createdAt)}</span>
            {j.status === "completed" ? <Badge tone="ok">Véglegesítve</Badge> : j.expired ? <Badge tone="neutral">Lejárt előnézet (nem véglegesítve)</Badge> : <Badge tone="warn">Előnézet (nem véglegesítve)</Badge>}
            <Badge tone="accent">{j.fileType.toUpperCase()}</Badge>
            <span className="ml-auto break-all text-xs text-ink-subtle">Import ID: {j.id}</span>
          </div>
          <dl className="mt-3 grid gap-x-6 gap-y-2 text-sm sm:grid-cols-2 lg:grid-cols-3">
            <Item label="Importáló" value={j.createdByName} />
            <Item label="Adatforrás" value={j.sourceName} />
            <Item label="Cél" value={j.purpose} />
            <Item label="Forrás ellenőrzése" value={SOURCE_VERIFICATION_LABELS[j.sourceVerification as SourceVerification] ?? j.sourceVerification} />
            <Item label="Nyilatkozat" value={j.complianceDeclared ? "Elfogadva" : "Nem fogadta el"} />
            <Item label="Fájl SHA-256" value={<span title={j.fileSha256} className="font-mono text-xs">{j.fileSha256.slice(0, 16)}…</span>} />
            <Item label="Feldolgozott sorok" value={`${j.totalRows} (érvényes ${j.validRows}, figyelmeztetés ${j.warningRows}, hibás ${j.errorRows}, egyezés ${j.duplicateRows}, üres ${j.emptyRows})`} />
            <Item label="Eredmény" value={j.status === "completed" ? `${j.createdCount} létrehozva, ${j.skippedCount} kihagyva` : "—"} />
            <Item label="Jóváhagyás" value={j.committedAt ? `${j.committedByName ?? "—"}, ${formatDateTime(j.committedAt)}` : "—"} />
          </dl>
        </li>
      ))}
    </ul>
  );
}

function Item({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className="mt-0.5 break-words text-ink">{value}</dd>
    </div>
  );
}

export default function HistoryPage() {
  return (
    <>
      <PageHeader title="Adatkezelés" description="Az ügyféladat-importok naplója: ki, mikor, milyen forrásból, milyen eredménnyel. A fájl és a sorok tartalma nem kerül tárolásra." />
      <PermissionGate permission="crm.import.history.read"><History /></PermissionGate>
    </>
  );
}
