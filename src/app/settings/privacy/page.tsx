"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import { SectionGate } from "@/components/settings/nav";
import { FilterSelect, SelectInput, TextArea, TextInput } from "@/components/ui/form";
import { Modal } from "@/components/ui/modal";
import { Badge, Button, Card, CardHeader, EmptyState, ErrorState, LoadingState, PageHeader, type Tone } from "@/components/ui/primitives";
import { download, getJson, patchJson, postJson } from "@/data/data-client";
import { useCrmData } from "@/data/store";
import { customerName } from "@/domain/logic";
import {
  ERASE_CONFIRMATION_WORD, PRIVACY_CHANNEL_LABELS, PRIVACY_CHANNELS, PRIVACY_KIND_LABELS, PRIVACY_REQUEST_KINDS, PRIVACY_STATUS_LABELS, PROCESSING_INFO,
  type DueState, type PrivacyChannel, type PrivacyRequestKind, type PrivacyRequestStatus,
} from "@/domain/privacy";
import { dayKey } from "@/domain/time";
import { formatDate, formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";

/**
 * Beállítások › Adatvédelem (v1.3, GDPR 12-21. cikk). Az érintetti kérelmek nyilvántartása határidő-figyeléssel, a hozzáférési /
 * hordozhatósági kivonat letöltése, tiltakozás és korlátozás rögzítése, végleges anonimizálás (külön joggal, beírt megerősítéssel), a
 * megőrzési felülvizsgálat és az adatkezelési tájékoztató. Minden jogot a szerver ellenőriz; a felület csak megjelenít.
 */
interface RequestView {
  id: string; kind: PrivacyRequestKind; status: PrivacyRequestStatus; channel: PrivacyChannel; customerId: string | null; customerName: string | null;
  customerState: "active" | "removed" | "erased" | null; subjectLabel: string | null; receivedAt: string; dueAt: string; extended: boolean; dueState: DueState;
  identityVerified: boolean; outcomeNote: string | null; createdBy: string; createdById: string; createdAt: string; updatedBy: string; updatedAt: string; closedAt: string | null;
  closedBy: string | null; version: number;
}
interface Overview { open: number; overdue: number; dueSoon: number; erased: number; suppressions: number; canErase: boolean }
interface Candidate { customerId: string; name: string; type: string; crmStatus: string | null; reason: "inactive" | "lost" | "removed"; lastActivityAt: string; removedAt: string | null; restricted: boolean; openRequest: boolean }

const DUE: Record<DueState, { label: string; tone: Tone } | null> = {
  overdue: { label: "Határidő lejárt", tone: "danger" }, due_soon: { label: "7 napon belül esedékes", tone: "warn" }, ok: null, closed: null,
};
const STATUS_TONE: Record<PrivacyRequestStatus, Tone> = { open: "info", in_progress: "accent", completed: "ok", rejected: "neutral" };
const TABS = [
  { key: "requests", label: "Érintetti kérelmek" },
  { key: "retention", label: "Megőrzés" },
  { key: "info", label: "Adatkezelési tájékoztató" },
] as const;
type TabKey = (typeof TABS)[number]["key"];

export default function PrivacyPage() {
  return (
    <>
      <PageHeader title="Adatvédelem" description="Érintetti kérelmek (GDPR 15-21. cikk) határidővel, adatkivonat, tiltakozás rögzítése, végleges törlés és megőrzési felülvizsgálat. Minden lépés naplózódik." />
      <SectionGate permissions={["crm.privacy.manage"]}><Privacy /></SectionGate>
    </>
  );
}

function Privacy() {
  const [tab, setTab] = useState<TabKey>("requests");
  const [overview, setOverview] = useState<Overview | null>(null);
  const [error, setError] = useState("");
  const loadOverview = useCallback(async () => {
    const r = await getJson<Overview>("/api/privacy/overview");
    if (r.ok) setOverview(r.value); else setError(r.message);
  }, []);
  useEffect(() => { const t = setTimeout(() => void loadOverview(), 0); return () => clearTimeout(t); }, [loadOverview]);
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-4">
      {overview ? (
        <dl className="grid grid-cols-2 gap-3 sm:grid-cols-4" aria-label="Adatvédelmi összesítő">
          <Stat label="Nyitott kérelem" value={overview.open} />
          <Stat label="Lejárt határidő" value={overview.overdue} tone={overview.overdue ? "danger" : undefined} />
          <Stat label="7 napon belül esedékes" value={overview.dueSoon} tone={overview.dueSoon ? "warn" : undefined} />
          <Stat label="Véglegesen törölt ügyfél" value={overview.erased} />
        </dl>
      ) : null}
      <div role="tablist" aria-label="Adatvédelem" className="-mx-4 flex gap-1 overflow-x-auto px-4 sm:mx-0 sm:px-0">
        {TABS.map((t) => (
          <button key={t.key} role="tab" type="button" aria-selected={tab === t.key} aria-controls={`panel-${t.key}`} id={`tab-${t.key}`} onClick={() => setTab(t.key)}
            className={cn("min-h-11 shrink-0 rounded-md px-3 text-sm font-medium ring-1", tab === t.key ? "bg-accent-soft text-accent ring-accent/40" : "text-ink-muted ring-line hover:bg-surface-muted")}>
            {t.label}
          </button>
        ))}
      </div>
      <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`}>
        {tab === "requests" ? <Requests canErase={overview?.canErase === true} onChanged={() => void loadOverview()} /> : tab === "retention" ? <Retention /> : <ProcessingInfo />}
      </div>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: number; tone?: "danger" | "warn" }) {
  return (
    <div className={cn("rounded-lg bg-surface p-3 ring-1 ring-line", tone === "danger" && "bg-danger-soft ring-danger/30", tone === "warn" && "bg-warn-soft ring-warn/30")}>
      <dt className="text-xs font-medium text-ink-muted">{label}</dt>
      <dd className="mt-1 text-2xl font-semibold tabular-nums text-ink">{value}</dd>
    </div>
  );
}

// ------------------------------------------------------------------ Kérelmek

function Requests({ canErase, onChanged }: { canErase: boolean; onChanged: () => void }) {
  const [filter, setFilter] = useState("open_all");
  const [items, setItems] = useState<RequestView[] | null>(null);
  const [error, setError] = useState("");
  const [creating, setCreating] = useState(false);
  const [notice, setNotice] = useState("");
  const load = useCallback(async () => {
    const r = await getJson<{ requests: RequestView[] }>(`/api/privacy/requests${filter ? `?status=${filter}` : ""}`);
    if (r.ok) setItems(r.value.requests); else setError(r.message);
  }, [filter]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  const changed = (msg: string) => { setNotice(msg); void load(); onChanged(); };
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-end gap-3">
        <FilterSelect label="Szűrés" value={filter} onChange={(e) => setFilter(e.target.value)} className="max-w-xs">
          <option value="open_all">Nyitott és folyamatban lévő</option>
          <option value="">Minden kérelem</option>
          {(["completed", "rejected"] as const).map((s) => <option key={s} value={s}>{PRIVACY_STATUS_LABELS[s]}</option>)}
        </FilterSelect>
        <Button onClick={() => setCreating(true)} className="ml-auto">Új kérelem rögzítése</Button>
      </div>
      {notice ? <p role="status" className="rounded-md bg-ok-soft p-3 text-sm text-ok">{notice}</p> : null}
      {!items ? <LoadingState /> : items.length === 0 ? (
        <Card><EmptyState title="Nincs ilyen kérelem." hint="Az érintettől (ügyfél, kapcsolattartó, érdeklődő) érkező adatvédelmi kérelmet itt rögzítsd a beérkezés napján: a határidő (1 hónap) ebből számítódik." /></Card>
      ) : (
        <ul className="space-y-3" aria-label="Érintetti kérelmek">
          {items.map((r) => <RequestItem key={r.id} r={r} canErase={canErase} onChanged={changed} />)}
        </ul>
      )}
      <NewRequestModal open={creating} onClose={() => setCreating(false)} onCreated={() => { setCreating(false); changed("A kérelem rögzítve."); }} />
    </div>
  );
}

function RequestItem({ r, canErase, onChanged }: { r: RequestView; canErase: boolean; onChanged: (msg: string) => void }) {
  const { currentUserId } = useCrmData();
  // Négy-szem elv: a törlési kérelem rögzítője nem hajthatja végre a törlést (az adatbázis is kikényszeríti).
  const ownErasure = r.kind === "erasure" && r.createdById === currentUserId;
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [mode, setMode] = useState<"" | "close" | "restriction" | "erase">("");
  const open = r.status === "open" || r.status === "in_progress";
  const due = DUE[r.dueState];
  const patch = async (body: Record<string, unknown>, msg: string) => {
    setBusy(true);
    setErr("");
    const res = await patchJson<{ request: RequestView }>("/api/privacy/requests", { id: r.id, version: r.version, ...body });
    setBusy(false);
    if (!res.ok) return setErr(res.message);
    onChanged(msg);
  };
  const report = async () => {
    setBusy(true);
    setErr("");
    const res = await download("/api/privacy/report", { requestId: r.id });
    setBusy(false);
    if (!res.ok) return setErr(res.message);
    onChanged(`Az adatkivonat letöltve (${res.value.filename}). Biztonságos csatornán add át az érintettnek, és ne tárold a saját gépeden.`);
  };
  return (
    <li className="rounded-lg bg-surface p-4 text-sm ring-1 ring-line" data-testid="privacy-request">
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-semibold text-ink">{PRIVACY_KIND_LABELS[r.kind]}</span>
        <Badge tone={STATUS_TONE[r.status]}>{PRIVACY_STATUS_LABELS[r.status]}</Badge>
        {due ? <Badge tone={due.tone}>{due.label}</Badge> : null}
        {r.identityVerified ? <Badge tone="ok">Azonosítva</Badge> : open ? <Badge tone="warn">Azonosítás szükséges</Badge> : null}
        <span className="ml-auto text-xs text-ink-subtle">Azonosító: {r.id}</span>
      </div>
      <dl className="mt-3 grid gap-x-6 gap-y-2 sm:grid-cols-2 lg:grid-cols-3">
        <Item label="Érintett" value={r.customerId ? (
          r.customerState === "active" ? <Link className="text-accent underline underline-offset-2" href={`/customers/${r.customerId}`}>{r.customerName}</Link>
            : <>{r.customerName} <span className="text-ink-muted">({r.customerState === "erased" ? "véglegesen törölve" : "eltávolítva az aktív CRM-ből"})</span></>
        ) : r.subjectLabel ?? "—"} />
        <Item label="Beérkezés" value={`${formatDate(r.receivedAt)} · ${PRIVACY_CHANNEL_LABELS[r.channel]}`} />
        <Item label="Határidő" value={`${formatDate(r.dueAt)}${r.extended ? " (meghosszabbítva)" : ""}`} />
        <Item label="Rögzítette" value={`${r.createdBy}, ${formatDateTime(r.createdAt)}`} />
        {r.closedAt ? <Item label="Lezárta" value={`${r.closedBy ?? "—"}, ${formatDateTime(r.closedAt)}`} /> : null}
        {r.outcomeNote ? <Item label="Intézkedés / megjegyzés" value={r.outcomeNote} /> : null}
      </dl>
      {err ? <p role="alert" className="mt-3 rounded-md bg-danger-soft p-3 text-danger">{err}</p> : null}
      {open && ownErasure && r.customerState !== "erased" ? (
        <p className="mt-3 rounded-md bg-info-soft p-3 text-[13px] text-ink" data-testid="four-eyes-note">Négy-szem elv: ezt a törlési kérelmet te rögzítetted, ezért a végleges törlést egy másik, törlési joggal rendelkező kolléga hajthatja végre.</p>
      ) : null}
      {open ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {!r.identityVerified ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void patch({ identityVerified: true }, "Az azonosítás rögzítve.")}>Személyazonosság ellenőrizve</Button> : null}
          {r.status === "open" ? <Button size="sm" variant="secondary" disabled={busy} onClick={() => void patch({ status: "in_progress" }, "A kérelem folyamatban.")}>Folyamatban</Button> : null}
          {(r.kind === "access" || r.kind === "portability") && r.customerId && r.customerState !== "erased" ? <Button size="sm" disabled={busy} onClick={() => void report()}>Adatkivonat letöltése (JSON)</Button> : null}
          {(r.kind === "objection" || r.kind === "restriction") && r.customerId && r.customerState === "active" ? <Button size="sm" disabled={busy} onClick={() => setMode("restriction")}>{r.kind === "objection" ? "Tiltakozás rögzítése" : "Korlátozás rögzítése"}</Button> : null}
          {r.kind === "erasure" && r.customerId && r.customerState !== "erased" && canErase && !ownErasure ? <Button size="sm" variant="danger" disabled={busy} onClick={() => setMode("erase")}>Végleges törlés…</Button> : null}
          {!r.extended ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void patch({ extend: true }, "A határidő meghosszabbítva (12. cikk (3)); az érintettet az első hónapon belül tájékoztatni kell az okáról.")}>Határidő meghosszabbítása</Button> : null}
          <Button size="sm" variant="ghost" disabled={busy} onClick={() => setMode("close")}>{r.kind === "erasure" ? "Elutasítás…" : "Lezárás…"}</Button>
        </div>
      ) : null}
      <CloseModal open={mode === "close"} r={r} onClose={() => setMode("")} onDone={(m) => { setMode(""); onChanged(m); }} />
      <RestrictionModal open={mode === "restriction"} r={r} onClose={() => setMode("")} onDone={(m) => { setMode(""); onChanged(m); }} />
      <EraseModal open={mode === "erase"} r={r} onClose={() => setMode("")} onDone={(m) => { setMode(""); onChanged(m); }} />
    </li>
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

const NO_PII_HINT = "Csak az intézkedést írd le (pl. „kivonat átadva titkosított e-mailben”); személyes adatot, egészségügyi vagy pénzügyi részletet ne.";

function NewRequestModal({ open, onClose, onCreated }: { open: boolean; onClose: () => void; onCreated: () => void }) {
  const { data } = useCrmData();
  const [f, setF] = useState({ kind: "access", channel: "email", customerId: "", subjectLabel: "", receivedOn: dayKey(new Date()), identityVerified: false, outcomeNote: "" });
  const [query, setQuery] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!data || q.length < 2) return [];
    return data.customers.filter((c) => customerName(c).toLowerCase().includes(q) || (c.email ?? "").toLowerCase().includes(q) || (c.phone ?? "").replace(/\D/g, "").includes(q.replace(/\D/g, "") || "\u0000")).slice(0, 8);
  }, [data, query]);
  const chosen = data?.customers.find((c) => c.id === f.customerId);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setErr("");
    const r = await postJson("/api/privacy/requests", {
      kind: f.kind, channel: f.channel, receivedOn: f.receivedOn, identityVerified: f.identityVerified,
      ...(f.customerId ? { customerId: f.customerId } : {}), ...(f.subjectLabel.trim() ? { subjectLabel: f.subjectLabel.trim() } : {}), ...(f.outcomeNote.trim() ? { outcomeNote: f.outcomeNote.trim() } : {}),
    });
    setBusy(false);
    if (!r.ok) return setErr(r.message);
    setF((s) => ({ ...s, customerId: "", subjectLabel: "", outcomeNote: "", identityVerified: false }));
    setQuery("");
    onCreated();
  };
  return (
    <Modal open={open} onClose={onClose} title="Új érintetti kérelem">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <SelectInput label="Kérelem típusa" required value={f.kind} onChange={(e) => setF({ ...f, kind: e.target.value })}>
          {PRIVACY_REQUEST_KINDS.map((k) => <option key={k} value={k}>{PRIVACY_KIND_LABELS[k]}</option>)}
        </SelectInput>
        <div className="grid gap-4 sm:grid-cols-2">
          <TextInput label="Beérkezés napja" type="date" required value={f.receivedOn} max={dayKey(new Date())} onChange={(e) => setF({ ...f, receivedOn: e.target.value })} hint="A határidő ettől számított 1 hónap." />
          <SelectInput label="Beérkezés módja" value={f.channel} onChange={(e) => setF({ ...f, channel: e.target.value })}>
            {PRIVACY_CHANNELS.map((c) => <option key={c} value={c}>{PRIVACY_CHANNEL_LABELS[c]}</option>)}
          </SelectInput>
        </div>
        {chosen ? (
          <p className="flex flex-wrap items-center gap-2 rounded-md bg-surface-muted p-3 text-sm">Ügyfél: <strong>{customerName(chosen)}</strong>
            <Button size="sm" variant="ghost" onClick={() => setF({ ...f, customerId: "" })}>Másik ügyfél</Button></p>
        ) : (
          <div className="space-y-2">
            <TextInput label="Ügyfél keresése (név, e-mail, telefonszám)" value={query} onChange={(e) => setQuery(e.target.value)} autoComplete="off" hint="Ha az érintett nem szerepel a CRM-ben, hagyd üresen, és add meg lent a rövid megnevezését." />
            {matches.length ? (
              <ul className="space-y-1" aria-label="Találatok">
                {matches.map((c) => (
                  <li key={c.id}><button type="button" className="min-h-11 w-full rounded-md px-3 text-left text-sm ring-1 ring-line hover:bg-surface-muted" onClick={() => setF({ ...f, customerId: c.id })}>{customerName(c)}</button></li>
                ))}
              </ul>
            ) : null}
            <TextInput label="Érintett rövid megnevezése (ha nincs ügyfél)" value={f.subjectLabel} maxLength={200} onChange={(e) => setF({ ...f, subjectLabel: e.target.value })} hint="Pl. monogram és a beérkezés módja. Csak annyi adat, amennyi a kérelem azonosításához szükséges." />
          </div>
        )}
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-1" checked={f.identityVerified} onChange={(e) => setF({ ...f, identityVerified: e.target.checked })} />
          <span>Az érintett személyazonossága ellenőrzött (pl. a nyilvántartott e-mail-címről vagy telefonszámról érkezett, visszahívással megerősítve).</span>
        </label>
        <TextArea label="Megjegyzés (opcionális)" rows={2} maxLength={1000} value={f.outcomeNote} onChange={(e) => setF({ ...f, outcomeNote: e.target.value })} hint={NO_PII_HINT} />
        {err ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{err}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Mégse</Button>
          <Button type="submit" disabled={busy} aria-busy={busy}>Kérelem rögzítése</Button>
        </div>
      </form>
    </Modal>
  );
}

function CloseModal({ open, r, onClose, onDone }: { open: boolean; r: RequestView; onClose: () => void; onDone: (m: string) => void }) {
  const [status, setStatus] = useState<"completed" | "rejected">(r.kind === "erasure" ? "rejected" : "completed");
  const [note, setNote] = useState(r.outcomeNote ?? "");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await patchJson("/api/privacy/requests", { id: r.id, version: r.version, status, outcomeNote: note.trim() });
    setBusy(false);
    if (!res.ok) return setErr(res.message);
    onDone(status === "completed" ? "A kérelem teljesítettként lezárva." : "A kérelem elutasítva.");
  };
  return (
    <Modal open={open} onClose={onClose} title="Kérelem lezárása">
      <form onSubmit={submit} className="space-y-4" noValidate>
        {r.kind !== "erasure" ? (
          <SelectInput label="Eredmény" value={status} onChange={(e) => setStatus(e.target.value as "completed" | "rejected")}>
            <option value="completed">Teljesítve</option>
            <option value="rejected">Elutasítva</option>
          </SelectInput>
        ) : <p className="text-sm text-ink-muted">A törlési kérelem a „Végleges törlés” művelettel teljesíthető; itt csak elutasítható (pl. jogszabályi megőrzési kötelezettség miatt).</p>}
        <TextArea label={status === "completed" ? "Intézkedés" : "Az elutasítás oka"} required rows={3} maxLength={1000} value={note} onChange={(e) => setNote(e.target.value)} hint={NO_PII_HINT} />
        <p className="text-[13px] text-ink-muted">A lezárt kérelem nem nyitható újra és nem módosítható. Az érintettet a döntésről és - elutasításnál - a jogorvoslati lehetőségekről (NAIH, bíróság) tájékoztatni kell.</p>
        {err ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{err}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Mégse</Button>
          <Button type="submit" disabled={busy || !note.trim()} aria-busy={busy}>Lezárás</Button>
        </div>
      </form>
    </Modal>
  );
}

function RestrictionModal({ open, r, onClose, onDone }: { open: boolean; r: RequestView; onClose: () => void; onDone: (m: string) => void }) {
  const [note, setNote] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const kind = r.kind === "objection" ? "objection" : "restriction";
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await postJson("/api/privacy/restriction", { customerId: r.customerId, kind, note: note.trim(), requestId: r.id });
    setBusy(false);
    if (!res.ok) return setErr(res.message);
    onDone(kind === "objection" ? "A tiltakozás rögzítve: kimenő megkeresés tiltva, az elérhetőségek tiltólistára kerültek." : "A megkeresési korlátozás rögzítve.");
  };
  return (
    <Modal open={open} onClose={onClose} title={kind === "objection" ? "Tiltakozás rögzítése" : "Megkeresési korlátozás rögzítése"}>
      <form onSubmit={submit} className="space-y-4" noValidate>
        <p className="text-sm">Ügyfél: <strong>{r.customerName}</strong></p>
        <TextArea label="Rövid leírás" required rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} hint="Pl. „telefonon kérte, hogy ne keressük többé”. A rögzítés nem írható felül és nem törölhető a felületről." />
        {kind === "objection" ? <p className="text-[13px] text-ink-muted">Tiltakozásnál az ügyfél és kapcsolattartói elérhetősége a tiltólistára kerül: későbbi import nem hozhatja vissza, kézi felvitelt csak adatvédelmi jog mellett, tudatos megerősítéssel enged a rendszer.</p> : null}
        {err ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{err}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Mégse</Button>
          <Button type="submit" disabled={busy || !note.trim()} aria-busy={busy}>Rögzítés</Button>
        </div>
      </form>
    </Modal>
  );
}

function EraseModal({ open, r, onClose, onDone }: { open: boolean; r: RequestView; onClose: () => void; onDone: (m: string) => void }) {
  const [word, setWord] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    const res = await postJson("/api/privacy/erase", { requestId: r.id, confirmation: word });
    setBusy(false);
    if (!res.ok) return setErr(res.message);
    setWord("");
    onDone("Az ügyfél adatai véglegesen anonimizálva; a kérelem teljesítve. A mentésekből a törlés a mentési megőrzési rend szerint fut ki (lásd törlési napló).");
  };
  return (
    <Modal open={open} onClose={onClose} title="Végleges törlés (anonimizálás)">
      <form onSubmit={submit} className="space-y-4" noValidate>
        <div role="note" className="space-y-2 rounded-md bg-danger-soft p-3 text-sm text-danger">
          <p className="font-semibold">Ez a művelet nem vonható vissza.</p>
          <p>{r.customerName} ügyfél neve, elérhetőségei, kapcsolattartói, jegyzetei, előzményei, feladatai és Outputjai helyére „Törölt tartalom” kerül; az ügyfél kikerül a CRM-ből. Megmarad: az azonosító, az időpontok és a személyes adat nélküli naplók (elszámoltathatóság); az elérhetőségek lenyomata tiltólistára kerül.</p>
        </div>
        {!r.identityVerified ? <p role="alert" className="rounded-md bg-warn-soft p-3 text-sm text-warn">Előbb rögzítsd, hogy az érintett személyazonossága ellenőrzött.</p> : null}
        <p className="text-[13px] text-ink-muted">Törlés előtt ellenőrizd, hogy nincs-e jogszabályi megőrzési kötelezettség (pl. pénzmosás elleni törvény szerinti ügyfél-átvilágítás, számviteli bizonylat); ilyenkor a kérelmet indokolással el kell utasítani.</p>
        <TextInput label={`A megerősítéshez írd be: ${ERASE_CONFIRMATION_WORD}`} value={word} onChange={(e) => setWord(e.target.value)} autoComplete="off" />
        {err ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{err}</p> : null}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Mégse</Button>
          <Button type="submit" variant="danger" disabled={busy || word.trim() !== ERASE_CONFIRMATION_WORD || !r.identityVerified} aria-busy={busy}>Végleges törlés</Button>
        </div>
      </form>
    </Modal>
  );
}

// ------------------------------------------------------------------ Megőrzés

function Retention() {
  const [data, setData] = useState<{ settings: { inactiveMonths: number; lostMonths: number; removedMonths: number }; candidates: Candidate[] } | null>(null);
  const [error, setError] = useState("");
  useEffect(() => {
    const t = setTimeout(() => void (async () => {
      const r = await getJson<{ settings: { inactiveMonths: number; lostMonths: number; removedMonths: number }; candidates: Candidate[] }>("/api/privacy/retention");
      if (r.ok) setData(r.value); else setError(r.message);
    })(), 0);
    return () => clearTimeout(t);
  }, []);
  if (error) return <ErrorState message={error} />;
  if (!data) return <LoadingState />;
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader title="Felülvizsgálandó ügyfelek" count={data.candidates.length} />
        <div className="space-y-2 p-4 text-sm text-ink-muted">
          <p>A jóváhagyott megőrzési rend szerint felülvizsgálandó: {data.settings.inactiveMonths} hónapja tevékenység nélküli érdeklődő / leendő ügyfél; {data.settings.lostMonths} hónapja „Elvesztett” státuszú ügyfél; {data.settings.removedMonths} hónapnál régebben eltávolított, de még nem anonimizált ügyfél (GDPR 5. cikk (1) e)). A szerződéses ügyfelek (Számlanyitás, Tőke elhelyezve) nem szerepelnek: rájuk a szerződéses viszony és az irányadó megőrzési idő vonatkozik.</p>
          <p>A rendszer nem töröl automatikusan. Döntsd el ügyfelenként: megtartás (indokolt üzleti kapcsolat), vagy törlés - ehhez rögzíts „Törlés” kérelmet (érintetti kérés nélkül is, belső felülvizsgálat alapján), majd hajtsd végre a végleges törlést.</p>
        </div>
      </Card>
      {data.candidates.length === 0 ? <Card><EmptyState title="Nincs felülvizsgálandó ügyfél." /></Card> : (
        <ul className="space-y-2" aria-label="Felülvizsgálandó ügyfelek">
          {data.candidates.map((c) => (
            <li key={c.customerId} className="flex flex-wrap items-center gap-2 rounded-lg bg-surface p-3 text-sm ring-1 ring-line" data-testid="retention-candidate">
              <span className="font-medium text-ink">{c.name}</span>
              <Badge tone={c.reason === "removed" ? "warn" : "neutral"}>{c.reason === "removed" ? `Eltávolítva: ${formatDate(c.removedAt ?? undefined)}` : c.reason === "lost" ? "Elvesztett" : "Inaktív"}</Badge>
              {c.restricted ? <Badge tone="danger">Tiltakozás / korlátozás</Badge> : null}
              {c.openRequest ? <Badge tone="info">Nyitott kérelem</Badge> : null}
              <span className="ml-auto text-xs text-ink-subtle">Utolsó tevékenység: {formatDate(c.lastActivityAt)} · {c.customerId}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ------------------------------------------------------------------ Tájékoztató

function ProcessingInfo() {
  const rows: [string, React.ReactNode][] = [
    ["Adatkezelő", PROCESSING_INFO.controller],
    ["Az adatkezelés célja", <List key="p" items={PROCESSING_INFO.purposes} />],
    ["Jogalap", PROCESSING_INFO.legalBasis],
    ["Kezelt adatok köre", <List key="c" items={PROCESSING_INFO.categories} />],
    ["Címzettek, adatfeldolgozók", <List key="r" items={PROCESSING_INFO.recipients} />],
    ["Megőrzés", PROCESSING_INFO.retention],
    ["Az adat forrása", PROCESSING_INFO.source],
    ["Automatizált döntéshozatal", PROCESSING_INFO.automatedDecisions],
    ["Az érintett jogai", PROCESSING_INFO.rights],
  ];
  return (
    <Card>
      <CardHeader title="Adatkezelési tájékoztató (a CRM-re vonatkozó rész)" />
      <div className="space-y-3 p-4 text-sm">
        <p className="text-ink-muted">Ez a blokk minden adatkivonatba bekerül. A jogalap és a megőrzési rend jóváhagyva (2026-11-25); az érdekmérlegelés: docs/V1.3-LIA-JOGOS-ERDEK.md.</p>
        <dl className="grid gap-3 sm:grid-cols-[14rem_minmax(0,1fr)]">
          {rows.map(([k, v]) => (
            <div key={k} className="contents">
              <dt className="font-medium text-ink">{k}</dt>
              <dd className="break-words text-ink-muted">{v}</dd>
            </div>
          ))}
        </dl>
      </div>
    </Card>
  );
}
const List = ({ items }: { items: readonly string[] }) => <ul className="list-disc space-y-1 pl-5">{items.map((i) => <li key={i}>{i}</li>)}</ul>;
