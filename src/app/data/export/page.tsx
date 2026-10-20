"use client";

import { useEffect, useState } from "react";
import { DataTabs, PermissionGate } from "@/components/data/data-nav";
import { FilterSelect } from "@/components/ui/form";
import { Button, Card, CardHeader, ErrorState, PageHeader } from "@/components/ui/primitives";
import { download, postJson } from "@/data/data-client";
import { CUSTOMER_TYPES, CUSTOMER_TYPE_LABELS } from "@/domain/constants";
import { ordered } from "@/domain/config";
import { optionLabel, useCrmConfig } from "@/components/common";
import { cn } from "@/lib/cn";

/**
 * Ügyfelek exportálása (v1.0, CRM-017): formátum, szűrők, várható rekordszám, letöltés. A szerver minden kérésnél újra ellenőrzi a
 * jogosultságot és a szűrőket; a keresőkifejezés POST-törzsben megy (nem kerül URL-be), és az auditnaplóba sem kerül a szövege.
 */
type Filters = { query: string; type: string; crmStatus: string; source: string };
const clean = (f: Filters) => Object.fromEntries(Object.entries(f).filter(([, v]) => v.trim() !== "")) as Partial<Filters>;

function ExportForm() {
  const config = useCrmConfig();
  const [format, setFormat] = useState<"xlsx" | "csv">("xlsx");
  const [f, setF] = useState<Filters>({ query: "", type: "", crmStatus: "", source: "" });
  const [count, setCount] = useState<number | null>(null);
  const [sources, setSources] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [done, setDone] = useState("");

  useEffect(() => {
    let live = true;
    const t = setTimeout(async () => {
      const r = await postJson<{ count: number; sources: string[] }>("/api/data/export/count", { filters: clean(f) });
      if (!live) return;
      if (r.ok) { setCount(r.value.count); setSources(r.value.sources); setError(""); } else { setCount(null); setError(r.message); }
    }, 300);
    return () => { live = false; clearTimeout(t); };
  }, [f]);

  const run = async () => {
    setBusy(true);
    setError("");
    setDone("");
    const r = await download("/api/data/export", { format, filters: clean(f) });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setDone(`Az exportálás elkészült: ${r.value.count ?? "?"} ügyfél (${r.value.filename}).`);
  };
  const set = (k: keyof Filters) => (e: { target: { value: string } }) => setF((s) => ({ ...s, [k]: e.target.value }));

  return (
    <div className="space-y-5">
      <Card>
        <CardHeader title="1. Formátum" />
        <fieldset className="p-4">
          <legend className="sr-only">Exportformátum</legend>
          <div className="grid gap-2 sm:grid-cols-2">
            {([["xlsx", "Excel (.xlsx)", "Külön munkalap az ügyfeleknek és az összes kapcsolattartónak. Az értékek szövegként, változatlanul kerülnek a fájlba."],
              ["csv", "CSV (.csv)", "Egy sor ügyfelenként, az elsődleges kapcsolattartóval. Pontosvesszős, UTF-8. A =, +, -, @ kezdetű értékek elé aposztróf kerül (képletvédelem)."]] as const).map(([v, label, hint]) => (
              <label key={v} className={cn("flex cursor-pointer items-start gap-3 rounded-md p-3 ring-1", format === v ? "bg-accent-soft ring-accent" : "bg-surface ring-line-strong")}>
                <input type="radio" name="export-format" value={v} checked={format === v} onChange={() => setFormat(v)} className="mt-1 size-4" />
                <span><span className="block text-sm font-medium text-ink">{label}</span><span className="block text-[13px] text-ink-muted">{hint}</span></span>
              </label>
            ))}
          </div>
        </fieldset>
      </Card>
      <Card>
        <CardHeader title="2. Szűrők" />
        <div className="grid gap-3 p-4 sm:grid-cols-2 lg:grid-cols-4">
          <label className="block text-xs font-medium text-ink-muted sm:col-span-2 lg:col-span-4">
            Szöveges keresés (név, cégnév, kapcsolati személy, telefonszám, e-mail)
            <input type="search" value={f.query} onChange={set("query")} maxLength={200} className="mt-1 block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control" />
          </label>
          <FilterSelect label="Pipeline-státusz" value={f.crmStatus} onChange={set("crmStatus")}>
            <option value="">Összes</option>
            {ordered(config.statuses).map((s) => <option key={s.key} value={s.key}>{optionLabel(s)}</option>)}
          </FilterSelect>
          <FilterSelect label="Ügyféltípus" value={f.type} onChange={set("type")}>
            <option value="">Összes</option>
            {CUSTOMER_TYPES.map((t) => <option key={t} value={t}>{CUSTOMER_TYPE_LABELS[t]}</option>)}
          </FilterSelect>
          <FilterSelect label="Adatforrás" value={f.source} onChange={set("source")} className="sm:col-span-2">
            <option value="">Összes</option>
            {sources.map((s) => <option key={s} value={s}>{s}</option>)}
          </FilterSelect>
        </div>
      </Card>
      <Card>
        <CardHeader title="3. Rekordszám" />
        <div className="space-y-3 p-4">
          <p role="status" aria-live="polite" className="text-sm text-ink" data-testid="export-count">
            {count === null ? "A várható rekordszám számítása…" : <>Várhatóan <span className="text-lg font-semibold">{count}</span> aktív ügyfél kerül exportálásra.</>}
          </p>
          <p className="text-[13px] text-ink-muted">Csak aktív ügyfelek. Nem kerül a fájlba: ügyféljegyzet, feladatok és Outputok, előzmények, auditnapló, felhasználói és belépési adatok. A megkeresési korlátozás ténye szerepel.</p>
        </div>
      </Card>
      <p className="rounded-md bg-warn-soft p-3 text-sm text-warn">A letöltött fájl személyes adatot tartalmaz. Csak jogosult célra használd, ne továbbítsd és ne tárold nem védett helyen; a felhasználás után töröld.</p>
      {error ? <ErrorState title="Az exportálás nem sikerült" message={error} /> : null}
      {done ? <p role="status" className="rounded-md bg-ok-soft p-3 text-sm text-ok">{done}</p> : null}
      <Button onClick={() => void run()} disabled={busy || count === 0} aria-busy={busy} data-testid="export-run">{busy ? "Exportálás folyamatban…" : "4. Exportálás"}</Button>
    </div>
  );
}

export default function ExportPage() {
  return (
    <>
      <PageHeader title="Adatkezelés" description="Ügyfelek exportálása Excel- vagy CSV-fájlba a meglévő szűrési feltételekkel. Ez nem teljes adatbázismentés." />
      <DataTabs />
      <PermissionGate permission="crm.customer.export"><ExportForm /></PermissionGate>
    </>
  );
}
