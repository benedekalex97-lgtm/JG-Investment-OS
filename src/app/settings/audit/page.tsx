"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionGate } from "@/components/settings/nav";
import { FilterSelect } from "@/components/ui/form";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { getJson } from "@/data/data-client";
import { STATUS_COLOR_LABELS, type StatusColor } from "@/domain/config";
import { formatDateTime } from "@/lib/format";

interface Entry {
  id: number; at: string; via: "app" | "cli"; actorName: string; action: string; entityType: string; entityKey: string; entityLabel?: string;
  outcome: "success" | "rejected"; changes: Record<string, { from: unknown; to: unknown }> | null; reason: string | null;
}

const ENTITY: Record<string, string> = { pipeline_status: "Pipeline-státusz", task_type: "Feladattípus", task_input: "Input-opció", user_permission: "Jogosultság", settings: "Beállítások" };
const ACTION: Record<string, string> = {
  create: "Létrehozva", rename: "Átnevezve", recolor: "Szín módosítva", reorder: "Sorrend módosítva", archive: "Archiválva", reactivate: "Újraaktiválva", update: "Módosítva",
  "permission.grant": "Jogosultság kiosztva", "permission.revoke": "Jogosultság visszavonva", "permission.change": "Jogosultság-módosítás", "settings.denied": "Hozzáférés megtagadva",
};
const FIELD: Record<string, string> = { label: "Megnevezés", description: "Leírás", color: "Szín", sort_order: "Sorrend", is_active: "Aktív", allows_note: "Megjegyzés engedélyezett" };
const REASON: Record<string, string> = {
  self: "saját jogosultság módosítása", invalid_permission: "nem kiosztható jogosultság", last_admin: "utolsó felhasználókezelő admin", no_user: "ismeretlen felhasználó",
  inactive_user: "letiltott felhasználó", system_archive: "rendszerelem archiválása", label_locked: "zárolt megnevezés", protected_field: "védett mező", invalid: "érvénytelen kérés",
};

const actionLabel = (a: string) => ACTION[a] ?? ACTION[a.split(".").pop() ?? ""] ?? a;
const value = (field: string, v: unknown) => {
  if (v === null || v === undefined || v === "") return "—";
  if (typeof v === "boolean") return v ? "Igen" : "Nem";
  if (field === "color") return STATUS_COLOR_LABELS[v as StatusColor] ?? String(v);
  return String(v);
};

/**
 * Beállítások > Változásnapló (SET-008): a konfigurációs és jogosultsági változások, valamint az elutasított kísérletek - csak olvasható.
 * Jelszó, token, ügyféljegyzet vagy ügyféladat nem szerepel benne (a szerver csak konfigurációs értékeket és azonosítókat naplóz).
 */
export default function AuditPage() {
  return (
    <>
      <PageHeader title="Változásnapló" description="Ki, mikor és milyen beállítást vagy jogosultságot módosított. A napló nem szerkeszthető és nem törölhető." />
      <SectionGate permissions={["crm.settings.audit.read"]}><Audit /></SectionGate>
    </>
  );
}

function Audit() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [type, setType] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (before?: number) => {
    setBusy(true);
    const q = new URLSearchParams({ limit: "50", ...(before ? { before: String(before) } : {}), ...(type ? { entityType: type } : {}) });
    const r = await getJson<{ entries: Entry[]; nextBefore: number | null }>(`/api/settings/audit?${q}`);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setEntries((cur) => (before && cur ? [...cur, ...r.value.entries] : r.value.entries));
    setNext(r.value.nextBefore);
  }, [type]);
  // Az első betöltés a render után, időzítve (a meglévő oldalak mintája szerint).
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-4">
      <FilterSelect label="Szűrés" value={type} onChange={(e) => setType(e.target.value)} className="max-w-xs">
        <option value="">Minden bejegyzés</option>
        {Object.entries(ENTITY).map(([k, v]) => <option key={k} value={k}>{v}</option>)}
      </FilterSelect>
      {!entries ? <LoadingState /> : entries.length === 0 ? <Card><EmptyState title="Még nincs bejegyzés." /></Card> : (
        <ol className="space-y-2" aria-label="Változásnapló bejegyzései">
          {entries.map((e) => (
            <li key={e.id} className="rounded-lg bg-surface p-4 text-sm ring-1 ring-line" data-testid="audit-entry">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{actionLabel(e.action)}</span>
                <Badge tone="accent">{ENTITY[e.entityType] ?? e.entityType}</Badge>
                {e.outcome === "rejected" ? <Badge tone="danger">Elutasítva</Badge> : null}
                {e.via === "cli" ? <Badge>Üzemeltetői CLI</Badge> : null}
                <span className="ml-auto text-xs text-ink-subtle"><time dateTime={e.at}>{formatDateTime(e.at)}</time></span>
              </div>
              <p className="mt-1 break-words text-ink">{e.entityLabel ?? e.entityKey} <span className="font-mono text-xs text-ink-muted">({e.entityKey})</span></p>
              <p className="text-xs text-ink-muted">Módosító: {e.actorName}</p>
              {e.reason ? <p className="text-xs text-danger">Ok: {REASON[e.reason] ?? e.reason}</p> : null}
              {e.changes && e.entityType !== "user_permission" ? (
                <dl className="mt-2 grid gap-1 text-[13px] sm:grid-cols-[10rem_minmax(0,1fr)]">
                  {Object.entries(e.changes).map(([f, c]) => (
                    <div key={f} className="contents">
                      <dt className="text-ink-muted">{FIELD[f] ?? f}</dt>
                      <dd className="break-words">{e.action.endsWith(".create") ? value(f, c.to) : <>{value(f, c.from)} → {value(f, c.to)}</>}</dd>
                    </div>
                  ))}
                </dl>
              ) : null}
            </li>
          ))}
        </ol>
      )}
      {next ? <Button variant="secondary" onClick={() => void load(next)} disabled={busy} aria-busy={busy}>Továbbiak betöltése</Button> : null}
    </div>
  );
}
