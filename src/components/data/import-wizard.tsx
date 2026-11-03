"use client";

import Link from "next/link";
import { useMemo, useRef, useState } from "react";
import { SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Badge, Button, Card, CardHeader, ErrorState, type Tone } from "@/components/ui/primitives";
import { download, errorReportCsv, saveBlob, upload } from "@/data/data-client";
import { useCrmData } from "@/data/store";
import {
  canImportExplicitly, IMPORT_FIELD_LABELS, IMPORT_FIELDS, importsByDefault, mappingProblems, SOURCE_VERIFICATION, SOURCE_VERIFICATION_LABELS,
  type ColumnMapping, type ImportDecision, type ImportFieldKey, type RowState,
} from "@/domain/data-import";
import type { CommitResult, InspectResult, PreviewResult, PreviewRow } from "@/server/data/import";
import { cn } from "@/lib/cn";

/**
 * Importvarázsló (v1.0, CRM-014-016). Lépések: (1) fájl és adatforrás, (2) oszlopok megfeleltetése, (3) előnézet soronkénti
 * döntéssel, (4) eredmény. Adatbázisba csak a (3) lépés végén, kifejezett „Importálás véglegesítése” után kerül adat; a szerver
 * ekkor mindent újraellenőriz. A kiválasztott fájl csak a memóriában van (nincs böngészős tárolás).
 */
type Step = 1 | 2 | 3 | 4;
const STEPS = ["Fájl és adatforrás", "Oszlopok", "Előnézet és döntés", "Eredmény"] as const;

export const STATE_LABELS: Record<RowState, string> = {
  V: "Új, érvényes", W: "Ellenőrzést igényel", P: "Lehetséges egyezés", S: "Erős egyezés", R: "Megkeresési korlátozás", E: "Hibás", X: "Üres sor",
};
const STATE_TONE: Record<RowState, Tone> = { V: "ok", W: "warn", P: "info", S: "warn", R: "danger", E: "danger", X: "neutral" };
const FILTERS: { key: string; label: string; match: (s: RowState) => boolean }[] = [
  { key: "all", label: "Mind", match: (s) => s !== "X" },
  { key: "new", label: "Új", match: (s) => s === "V" || s === "W" },
  { key: "dup", label: "Egyezés", match: (s) => s === "P" || s === "S" || s === "R" },
  { key: "err", label: "Hibás", match: (s) => s === "E" },
  { key: "warn", label: "Figyelmeztetés", match: (s) => s === "W" },
];
const PAGE = 50;
const OUTCOME_LABELS: Record<string, string> = {
  created: "Létrehozva", skipped_user: "Kihagyva (döntés)", skipped_error: "Kihagyva (hibás)", skipped_duplicate: "Kihagyva (egyezés)",
  skipped_changed: "Kihagyva (az előnézet óta megváltozott)", skipped_restricted: "Kihagyva (megkeresési korlátozás)", skipped_empty: "Üres sor",
};
const fmtBytes = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1000))} kB`);
const extOf = (name: string) => name.toLowerCase().split(".").pop() ?? "";

export function ImportWizard() {
  const { refresh, features } = useCrmData();
  const [step, setStep] = useState<Step>(1);
  const [file, setFile] = useState<File | null>(null);
  const [encoding, setEncoding] = useState<"utf-8" | "windows-1250">("utf-8");
  const [info, setInfo] = useState<InspectResult | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping>([]);
  const [meta, setMeta] = useState({ sourceName: "", purpose: "", sourceVerification: "" as string, defaultType: "" as "" | "individual" | "company", declared: false });
  const [preview, setPreview] = useState<PreviewResult | null>(null);
  const [decisions, setDecisions] = useState<Record<number, ImportDecision>>({});
  const [result, setResult] = useState<CommitResult | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [metaErrors, setMetaErrors] = useState<Record<string, string>>({});
  const fileInput = useRef<HTMLInputElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);

  const go = (s: Step) => {
    setStep(s);
    setError("");
    setTimeout(() => heading.current?.focus(), 0);
  };

  const inspect = async (f: File, enc = encoding, sheetIndex?: number) => {
    setError("");
    const type = extOf(f.name);
    if (type !== "csv" && type !== "xlsx") {
      setInfo(null);
      setError("Nem támogatott fájlformátum. Csak .csv és .xlsx tölthető fel.");
      return;
    }
    setBusy(true);
    const r = await upload<InspectResult>("/api/data/import/inspect", f, { fileType: type, ...(type === "csv" ? { encoding: enc } : {}), ...(sheetIndex !== undefined ? { sheetIndex } : {}) });
    setBusy(false);
    if (!r.ok) {
      setInfo(null);
      setError(r.message);
      return;
    }
    setInfo(r.value);
    setMapping(r.value.suggestedMapping);
  };

  const problems = useMemo(() => (info ? mappingProblems(mapping, meta.defaultType || null) : []), [info, mapping, meta.defaultType]);
  const typeMapped = mapping.includes("type");

  const validateMeta = () => {
    const e: Record<string, string> = {};
    if (!meta.sourceName.trim()) e.sourceName = "Az adatforrás megnevezése kötelező.";
    if (!meta.purpose.trim()) e.purpose = "Az import céljának megadása kötelező.";
    if (!meta.sourceVerification) e.sourceVerification = "Válaszd ki a forrásadatok ellenőrzési státuszát.";
    setMetaErrors(e);
    return Object.keys(e).length === 0;
  };

  const runPreview = async () => {
    if (!file || !info || problems.length) return;
    setBusy(true);
    setError("");
    const r = await upload<PreviewResult>("/api/data/import/preview", file, {
      fileType: info.fileType, ...(info.fileType === "csv" ? { encoding } : { sheetIndex: info.sheetIndex }), mapping, defaultType: meta.defaultType || null,
      sourceName: meta.sourceName, purpose: meta.purpose, sourceVerification: meta.sourceVerification, complianceDeclared: meta.declared,
    });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setPreview(r.value);
    setDecisions({});
    go(3);
  };

  const willImport = (row: PreviewRow) => {
    const d = decisions[row.rowNo];
    if (d === "skip") return false;
    if (d === "import") return canImportExplicitly(row.state);
    return importsByDefault(row.state);
  };
  const toCreate = preview ? preview.rows.filter(willImport).length : 0;
  const skipped = preview ? preview.rows.filter((r) => r.state !== "X").length - toCreate : 0;

  const commit = async () => {
    if (!file || !preview || busy) return;
    setBusy(true);
    setError("");
    const r = await upload<CommitResult>("/api/data/import/commit", file, { jobId: preview.jobId, decisions: Object.fromEntries(Object.entries(decisions).map(([k, v]) => [k, v])) });
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setResult(r.value);
    void refresh();
    go(4);
  };

  const restart = () => {
    setFile(null); setInfo(null); setMapping([]); setPreview(null); setDecisions({}); setResult(null); setError("");
    setMeta({ sourceName: "", purpose: "", sourceVerification: "", defaultType: "", declared: false });
    if (fileInput.current) fileInput.current.value = "";
    go(1);
  };

  return (
    <div className="space-y-5">
      <ol className="grid grid-cols-2 gap-2 text-[13px] sm:grid-cols-4" aria-label="Az import lépései">
        {STEPS.map((label, i) => (
          <li key={label} aria-current={step === i + 1 ? "step" : undefined}
            className={cn("rounded-md px-3 py-2 ring-1", step === i + 1 ? "bg-accent text-on-accent ring-accent" : step > i + 1 ? "bg-ok-soft text-ok ring-ok/20" : "bg-surface text-ink-muted ring-line")}>
            <span className="font-semibold">{i + 1}.</span> {label}
          </li>
        ))}
      </ol>
      <h2 ref={heading} tabIndex={-1} className="text-lg font-semibold text-ink focus:outline-none">{STEPS[step - 1]}</h2>
      {error ? <ErrorState title="A művelet nem sikerült" message={error} /> : null}

      {step === 1 ? (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Fájl kiválasztása" action={<Button variant="ghost" size="sm" onClick={() => void download("/api/data/import/template")}>Importsablon letöltése (.xlsx)</Button>} />
            <div className="space-y-4 p-4">
              <div className="space-y-1">
                <label htmlFor="import-file" className="block text-sm font-medium text-ink">Excel- vagy CSV-fájl<span aria-hidden className="ml-0.5 text-danger">*</span></label>
                <input id="import-file" ref={fileInput} type="file" accept=".csv,.xlsx,text/csv,application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" aria-describedby="import-file-hint"
                  onChange={(e) => { const f = e.target.files?.[0] ?? null; setFile(f); setInfo(null); if (f) void inspect(f); }}
                  className="block w-full min-h-11 rounded-md bg-surface text-sm text-ink ring-1 ring-control file:mr-3 file:min-h-11 file:border-0 file:bg-surface-muted file:px-3 file:text-sm file:font-medium" />
                <p id="import-file-hint" className="text-[13px] text-ink-muted">Támogatott: .xlsx és .csv (makrós .xlsm nem). A fájl nem kerül tárolásra; csak a lenyomata kerül az importnaplóba.</p>
              </div>
              {file && extOf(file.name) === "csv" ? (
                <SelectInput label="Karakterkódolás" value={encoding} onChange={(e) => { const enc = e.target.value as typeof encoding; setEncoding(enc); void inspect(file, enc); }} hint="A régi magyar Excel CSV-mentése gyakran Windows-1250 kódolású.">
                  <option value="utf-8">UTF-8 (alapértelmezett)</option>
                  <option value="windows-1250">Windows-1250 (régi magyar Excel)</option>
                </SelectInput>
              ) : null}
              {info && info.sheets.length > 1 ? (
                <SelectInput label="Munkalap" value={String(info.sheetIndex)} onChange={(e) => file && void inspect(file, encoding, Number(e.target.value))}>
                  {info.sheets.map((s, i) => <option key={i} value={i}>{s.name}{s.hidden ? " (rejtett)" : ""}</option>)}
                </SelectInput>
              ) : null}
              <p role="status" aria-live="polite" className="text-sm text-ink-muted">
                {busy ? "A fájl ellenőrzése folyamatban…" : info ? `Kiválasztva: ${info.fileType.toUpperCase()} · ${fmtBytes(info.size)} · ${info.rowCount} adatsor${info.emptyRows ? ` (+ ${info.emptyRows} üres sor, kimarad)` : ""} · ${info.headers.length} oszlop${info.delimiter ? ` · elválasztó: ${info.delimiter === "\t" ? "tabulátor" : info.delimiter}` : ""}` : ""}
              </p>
            </div>
          </Card>
          <Card>
            <CardHeader title="Adatforrás és adatkezelési nyilatkozat" />
            <div className="grid gap-4 p-4 sm:grid-cols-2">
              <TextInput label="Adatforrás megnevezése" required value={meta.sourceName} error={metaErrors.sourceName} maxLength={200} onChange={(e) => setMeta((m) => ({ ...m, sourceName: e.target.value }))} hint="Pl. „2026-os partnerrendezvény jelentkezői”. Ne tartalmazzon személyes adatot." />
              <SelectInput label="Forrásadatok ellenőrzési státusza" required value={meta.sourceVerification} error={metaErrors.sourceVerification} onChange={(e) => setMeta((m) => ({ ...m, sourceVerification: e.target.value }))}>
                <option value="">Válassz…</option>
                {SOURCE_VERIFICATION.map((v) => <option key={v} value={v}>{SOURCE_VERIFICATION_LABELS[v]}</option>)}
              </SelectInput>
              <TextArea label="Az import célja" required value={meta.purpose} error={metaErrors.purpose} maxLength={500} className="sm:col-span-2" onChange={(e) => setMeta((m) => ({ ...m, purpose: e.target.value }))} />
              <div className="space-y-2 rounded-md bg-info-soft p-3 text-sm text-info sm:col-span-2">
                <p>Az import nem minősül hozzájárulásnak, nem jelöl ügyfelet megkereshetőnek, és nem minősíti a forrást adatvédelmileg megfelelőnek. A nyilatkozat nem pótolja a jogszerűségi ellenőrzést. A JG saját ügyféladatbázisa nem keverhető a K&amp;H / Patria ügynöki adatkezeléssel.</p>
                <label className="flex items-start gap-2 font-medium">
                  <input type="checkbox" className="mt-1 size-4" checked={meta.declared} onChange={(e) => setMeta((m) => ({ ...m, declared: e.target.checked }))} />
                  Nyilatkozom, hogy a forrás eredetének és felhasználási feltételeinek adatkezelési ellenőrzése megtörtént.
                </label>
              </div>
            </div>
          </Card>
          <div className="flex flex-wrap gap-2">
            <Button disabled={!info || busy} onClick={() => validateMeta() && go(2)}>Tovább: oszlopok megfeleltetése</Button>
          </div>
        </div>
      ) : null}

      {step === 2 && info ? (
        <div className="space-y-5">
          <Card>
            <CardHeader title="Oszlopok megfeleltetése" count={info.headers.length} />
            <p className="px-4 pt-3 text-sm text-ink-muted">A rendszer a felismert oszlopnevek alapján javaslatot tett. Ellenőrizd, és szükség esetén módosítsd. A nem hozzárendelt oszlopok nem kerülnek importálásra.</p>
            <ul className="divide-y divide-line">
              {info.headers.map((h, i) => (
                <li key={i} className="grid gap-2 px-4 py-3 sm:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] sm:items-center">
                  <div className="min-w-0">
                    <p className="break-words text-sm font-medium text-ink">{h || `(névtelen ${i + 1}. oszlop)`}</p>
                    <p className="break-words text-xs text-ink-muted">{info.samples[i]?.length ? `Minta: ${info.samples[i].join(" · ")}` : "Nincs érték"}</p>
                  </div>
                  <label className="block min-w-0 text-xs font-medium text-ink-muted">
                    <span className="sr-only">„{h}” oszlop CRM-mezője</span>
                    <select value={mapping[i] ?? ""} onChange={(e) => setMapping((m) => m.map((x, j) => (j === i ? ((e.target.value || null) as ImportFieldKey | null) : x)))}
                      className="block min-h-11 w-full rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control">
                      <option value="">— Nem importálom —</option>
                      {IMPORT_FIELDS.map((f) => <option key={f.key} value={f.key}>{f.label}</option>)}
                    </select>
                  </label>
                </li>
              ))}
            </ul>
          </Card>
          {!typeMapped ? (
            <Card>
              <div className="p-4">
                <SelectInput label="Alapértelmezett ügyféltípus (nincs Ügyféltípus oszlop)" required value={meta.defaultType} onChange={(e) => setMeta((m) => ({ ...m, defaultType: e.target.value as typeof m.defaultType }))}>
                  <option value="">Válassz…</option>
                  <option value="individual">Magánszemély</option>
                  <option value="company">Cég</option>
                </SelectInput>
              </div>
            </Card>
          ) : null}
          {problems.length ? (
            <ul role="alert" className="space-y-1 rounded-md bg-warn-soft p-3 text-sm text-warn">{problems.map((p) => <li key={p.code + p.message}>{p.message}</li>)}</ul>
          ) : null}
          <p className="text-sm text-ink-muted">Az importált ügyfelek „Feldolgozásra vár” státusszal jönnek létre. A fájlban szereplő státusz nem kerül átvételre.</p>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => go(1)}>Vissza</Button>
            <Button disabled={busy || problems.length > 0} aria-busy={busy} onClick={() => void runPreview()}>{busy ? "Előnézet készül…" : "Előnézet készítése"}</Button>
          </div>
        </div>
      ) : null}

      {step === 3 && preview ? (
        <PreviewStep preview={preview} decisions={decisions} setDecisions={setDecisions} willImport={willImport} toCreate={toCreate} skipped={skipped}
          busy={busy} importEnabled={features.customerImport} onBack={() => go(2)} onCommit={() => void commit()} />
      ) : null}

      {step === 4 && result ? (
        <Card>
          <div className="space-y-4 p-4">
            <p role="status" className="rounded-md bg-ok-soft p-3 text-sm font-medium text-ok">{result.replayed ? "Ez az import már korábban véglegesítve lett; az eredmény változatlan." : "Az importálás elkészült."}</p>
            <dl className="grid gap-3 sm:grid-cols-3">
              <Stat label="Létrehozott ügyfél" value={result.created} />
              <Stat label="Kihagyott sor" value={result.skipped} />
              <Stat label="Import azonosító" value={result.jobId} small />
            </dl>
            <ul className="space-y-1 text-sm text-ink">
              {Object.entries(result.outcomes).map(([k, v]) => <li key={k}>{OUTCOME_LABELS[k] ?? k}: <span className="font-semibold">{v}</span></li>)}
              {result.empty ? <li>Üres sor (kimaradt): <span className="font-semibold">{result.empty}</span></li> : null}
            </ul>
            <div className="flex flex-wrap gap-2">
              <Link href="/customers" className="inline-flex min-h-11 items-center rounded-md bg-accent px-4 text-sm font-medium text-on-accent hover:bg-accent-hover">Ügyfelek megnyitása</Link>
              <Link href="/settings/data/history" className="inline-flex min-h-11 items-center rounded-md px-4 text-sm font-medium text-ink ring-1 ring-line-strong hover:bg-surface-muted">Importelőzmények</Link>
              <Button variant="ghost" onClick={restart}>Új import</Button>
            </div>
          </div>
        </Card>
      ) : null}
    </div>
  );
}

function Stat({ label, value, small }: { label: string; value: number | string; small?: boolean }) {
  return (
    <div className="min-w-0 rounded-md bg-canvas p-3 ring-1 ring-line">
      <dt className="text-xs font-medium uppercase tracking-wide text-ink-subtle">{label}</dt>
      <dd className={cn("mt-1 break-all font-semibold text-ink", small ? "text-sm" : "text-2xl")}>{value}</dd>
    </div>
  );
}

function PreviewStep({ preview, decisions, setDecisions, willImport, toCreate, skipped, busy, importEnabled, onBack, onCommit }: {
  preview: PreviewResult; decisions: Record<number, ImportDecision>; setDecisions: (f: (d: Record<number, ImportDecision>) => Record<number, ImportDecision>) => void;
  willImport: (r: PreviewRow) => boolean; toCreate: number; skipped: number; busy: boolean; importEnabled: boolean; onBack: () => void; onCommit: () => void;
}) {
  const [filter, setFilter] = useState("all");
  const [page, setPage] = useState(0);
  const s = preview.summary;
  const f = FILTERS.find((x) => x.key === filter) ?? FILTERS[0];
  const rows = preview.rows.filter((r) => f.match(r.state));
  const pages = Math.max(1, Math.ceil(rows.length / PAGE));
  const visible = rows.slice(page * PAGE, page * PAGE + PAGE);
  const pendingWarn = preview.rows.filter((r) => (r.state === "W") && decisions[r.rowNo] !== "import" && decisions[r.rowNo] !== "skip").length;
  const issues = preview.rows.filter((r) => r.issues.length);
  const blockers = preview.commitBlockers;
  const fieldLabel = (k?: string) => (k ? IMPORT_FIELD_LABELS[k as ImportFieldKey] ?? k : "");
  const setDecision = (rowNo: number, d: ImportDecision | undefined) => setDecisions((m) => {
    const next = { ...m };
    if (d) next[rowNo] = d; else delete next[rowNo];
    return next;
  });

  return (
    <div className="space-y-5">
      <dl className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6" data-testid="import-summary">
        <Stat label="Összes sor" value={s.total} />
        <Stat label="Érvényes új" value={s.valid} />
        <Stat label="Ellenőrzést igényel" value={s.warning} />
        <Stat label="Egyezés (erős vagy lehetséges)" value={s.duplicate} />
        <Stat label="Hibás" value={s.error} />
        <Stat label="Üres sor" value={s.empty} />
      </dl>
      <div role="status" aria-live="polite" className="rounded-md bg-info-soft p-3 text-sm text-info">
        <p><span className="font-semibold">{toCreate} új ügyfél jön létre</span>, {skipped} sor kimarad. Döntés nélkül csak az új, érvényes sorok kerülnek mentésre.</p>
        {s.warning ? <p>{s.warning} sor további ellenőrzést igényel{pendingWarn ? ` (${pendingWarn} még döntésre vár)` : ""}.</p> : null}
        {s.error ? <p>{s.error} sor hibás adatot tartalmaz.</p> : null}
        <p className="text-xs">Az előnézet eddig: {new Date(preview.expiresAt).toLocaleString("hu-HU", { timeZone: "Europe/Budapest" })}. Véglegesítéskor a szerver mindent újraellenőriz.</p>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <div role="group" aria-label="Sorok szűrése" className="flex flex-wrap gap-1">
          {FILTERS.map((x) => {
            const n = preview.rows.filter((r) => x.match(r.state)).length;
            return (
              <button key={x.key} type="button" aria-pressed={filter === x.key} onClick={() => { setFilter(x.key); setPage(0); }}
                className={cn("min-h-9 rounded-full px-3 text-[13px] font-medium ring-1", filter === x.key ? "bg-accent text-on-accent ring-accent" : "bg-surface text-ink ring-line-strong hover:bg-surface-muted")}>
                {x.label} ({n})
              </button>
            );
          })}
        </div>
        {issues.length ? (
          <Button variant="ghost" size="sm" className="ml-auto" onClick={() => saveBlob(errorReportCsv(issues, (st) => STATE_LABELS[st as RowState] ?? st, fieldLabel), "JG_CRM_Import_Hibajegyzek.csv")}>
            Hibajegyzék letöltése (CSV)
          </Button>
        ) : null}
      </div>

      <ul className="space-y-3" aria-label="Importálandó sorok">
        {visible.map((r) => <RowCard key={r.rowNo} row={r} decision={decisions[r.rowNo]} willImport={willImport(r)} onDecision={(d) => setDecision(r.rowNo, d)} fieldLabel={fieldLabel} />)}
        {visible.length === 0 ? <li className="rounded-md bg-surface p-4 text-sm text-ink-muted ring-1 ring-line">Nincs ilyen sor.</li> : null}
      </ul>
      {pages > 1 ? (
        <nav aria-label="Lapozás" className="flex flex-wrap items-center gap-2 text-sm">
          <Button variant="secondary" size="sm" disabled={page === 0} onClick={() => setPage((p) => p - 1)}>Előző</Button>
          <span>{page + 1} / {pages}. oldal</span>
          <Button variant="secondary" size="sm" disabled={page >= pages - 1} onClick={() => setPage((p) => p + 1)}>Következő</Button>
        </nav>
      ) : null}

      {blockers.length || !importEnabled ? (
        <ul role="alert" className="space-y-1 rounded-md bg-warn-soft p-3 text-sm text-warn">
          {blockers.map((b) => <li key={b}>{b}</li>)}
        </ul>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button variant="secondary" onClick={onBack} disabled={busy}>Vissza a megfeleltetéshez</Button>
        <Button onClick={onCommit} disabled={busy || toCreate === 0 || !preview.commitAllowed} aria-busy={busy} data-testid="import-commit">
          {busy ? "Mentés folyamatban…" : `Importálás véglegesítése (${toCreate} ügyfél)`}
        </Button>
      </div>
    </div>
  );
}

function RowCard({ row, decision, willImport, onDecision, fieldLabel }: { row: PreviewRow; decision?: ImportDecision; willImport: boolean; onDecision: (d: ImportDecision | undefined) => void; fieldLabel: (k?: string) => string }) {
  const d = row.display;
  const explicit = canImportExplicitly(row.state) && row.state !== "V";
  const name = `import-row-${row.rowNo}`;
  return (
    <li className="rounded-lg bg-surface p-4 ring-1 ring-line" data-testid={`import-row-${row.rowNo}`}>
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-xs font-semibold text-ink-subtle">{row.rowNo}. sor</span>
        <Badge tone={STATE_TONE[row.state]}>{STATE_LABELS[row.state]}</Badge>
        {d ? <span className="min-w-0 break-words text-sm font-medium text-ink">{d.name} <span className="font-normal text-ink-muted">({d.typeLabel})</span></span> : null}
        <span className={cn("ml-auto text-xs font-medium", willImport ? "text-ok" : "text-ink-muted")}>{row.state === "X" ? "Kimarad" : willImport ? "Importálásra kerül" : "Kimarad"}</span>
      </div>
      {d ? (
        <p className="mt-1 break-words text-[13px] text-ink-muted">
          {[d.phone, d.email, d.contactName ? `Kapcsolattartó: ${d.contactName}` : "", d.contactPhone, d.contactEmail].filter(Boolean).join(" · ") || "Nincs elérhetőség"}
        </p>
      ) : null}
      {row.issues.length ? (
        <ul className="mt-2 space-y-0.5 text-[13px]">
          {row.issues.map((i, k) => <li key={k} className={i.level === "error" ? "text-danger" : "text-warn"}>{i.level === "error" ? "Hiba" : "Figyelmeztetés"}{i.field ? ` (${fieldLabel(i.field)})` : ""}: {i.message}</li>)}
        </ul>
      ) : null}
      {row.matches.length || row.fileMatches.length ? (
        <ul className="mt-2 space-y-1 text-[13px] text-ink">
          {row.matches.map((m, k) => (
            <li key={k} className="break-words">
              <span className="font-medium">{m.level === "strong" ? "Erős egyezés" : "Lehetséges egyezés"}:</span>{" "}
              {m.customerId ? <Link href={`/customers/${m.customerId}`} target="_blank" rel="noopener" className="font-medium text-accent underline underline-offset-2">{m.name}</Link> : <span>{m.name}</span>}
              {" "}({m.typeLabel}) — {m.reasons.join(", ")}{m.restricted ? " — megkeresési korlátozás / tiltakozás" : ""}
              {m.customerId ? <span className="sr-only"> (a meglévő ügyfél új lapon nyílik)</span> : null}
            </li>
          ))}
          {row.fileMatches.map((m) => <li key={`f${m.rowNo}`}>{m.level === "strong" ? "Erős" : "Lehetséges"} egyezés a fájl {m.rowNo}. sorával.</li>)}
        </ul>
      ) : null}
      {row.state === "V" ? (
        <label className="mt-3 flex items-center gap-2 text-sm">
          <input type="checkbox" className="size-4" checked={decision === "skip"} onChange={(e) => onDecision(e.target.checked ? "skip" : undefined)} />
          Kihagyom ezt a sort
        </label>
      ) : explicit ? (
        <fieldset className="mt-3">
          <legend className="text-sm font-medium text-ink">Döntés</legend>
          <div className="mt-1 flex flex-wrap gap-x-4 gap-y-1 text-sm">
            <label className="flex min-h-9 items-center gap-2"><input type="radio" name={name} className="size-4" checked={decision !== "import"} onChange={() => onDecision("skip")} /> Kihagyás</label>
            <label className="flex min-h-9 items-center gap-2"><input type="radio" name={name} className="size-4" checked={decision === "import"} onChange={() => onDecision("import")} /> {row.state === "W" ? "Jóváhagyom az importálást" : "Importálás új ügyfélként"}</label>
          </div>
        </fieldset>
      ) : null}
    </li>
  );
}
