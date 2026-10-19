"use client";

import Link from "next/link";
import { useId, useRef, useState, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { CRM_STATUS_LABELS, RESTRICTION_LABELS, TASK_OUTCOME_LABELS, TASK_OUTPUT_REQUIRED, TASK_TEXT_MAX } from "@/domain/constants";
import { customerName, inputText, isDone, latestOutput, outcomeLabel, outputText, statusOf } from "@/domain/logic";
import type { CrmStatus, Customer, DataSnapshot, Task, TaskOutcome, TaskOutput } from "@/domain/types";
import { formatDate, formatDateTime, fromDateInputValue, toDateInputValue } from "@/lib/format";
import { TextArea } from "./ui/form";
import { Badge, Button, LoadingState, type Tone } from "./ui/primitives";

/** Betöltési állapot kezelése: amíg nincs snapshot, skeletont mutat. */
export function DataGate({ children }: { children: (data: DataSnapshot) => ReactNode }) {
  const { data } = useCrmData();
  if (!data) return <LoadingState />;
  return <>{children(data)}</>;
}

/** A rögzítő neve az azonosítóból (a felhasználólista a szerverről jön; ismeretlen azonosító esetén az azonosító látszik). */
export function useUserName(): (id: string) => string {
  const { users } = useCrmData();
  return (id) => users.find((u) => u.id === id)?.name ?? id;
}

const CRM_TONE: Record<CrmStatus, Tone> = {
  waiting_for_contact: "neutral", contact: "info", relationship: "info", meeting: "accent", account_opening: "accent", capital_placed: "ok", lost: "danger",
};
export const CrmStatusBadge = ({ status }: { status: CrmStatus }) => <Badge tone={CRM_TONE[status]}>{CRM_STATUS_LABELS[status]}</Badge>;
export const TypeBadge = ({ type }: { type: Customer["type"] }) => <Badge tone="accent">{type === "company" ? "Cég" : "Magánszemély"}</Badge>;

/** Rövid, csak olvasható jelzés az aktív tiltakozásról/korlátozásról (nem compliance-panel). */
export const RestrictedBadge = ({ customer }: { customer: Customer }) => (customer.restriction ? <Badge tone="danger" className="shrink-0"><span title={`${RESTRICTION_LABELS[customer.restriction.kind]}: ${customer.restriction.note}`}>Megkeresés korlátozva</span></Badge> : null);
export { statusOf };

export function CustomerLink({ customer, id, data }: { customer?: Customer; id?: string; data?: DataSnapshot }) {
  const c = customer ?? data?.customers.find((x) => x.id === id);
  if (!c) return <span className="text-ink-muted">Ismeretlen ügyfél</span>;
  return <Link href={`/customers/${c.id}`} className="break-words font-medium text-accent underline-offset-2 hover:underline">{customerName(c)}</Link>;
}

/** A feladat állapotjelzése: nyitottnál a lejárt határidő, lezártnál a lezárás minősítése (a régi lezárás minősítés nélkül). */
function TaskStateBadge({ task, overdue }: { task: Task; overdue: boolean }) {
  if (!isDone(task)) return overdue ? <Badge tone="danger">Lejárt</Badge> : null;
  const outcome = latestOutput(task)?.outcome;
  if (outcome === "success") return <Badge tone="ok">Lezárva — {TASK_OUTCOME_LABELS.success}</Badge>;
  if (outcome === "failure") return <Badge tone="danger">Lezárva — {TASK_OUTCOME_LABELS.failure}</Badge>;
  return <Badge>Lezárva</Badge>;
}

const FIELD_LABEL = "text-xs font-medium text-ink-muted";
const errorOf = (r: { ok: boolean; errors?: Record<string, string> }, fallback: string) => r.errors?._form ?? Object.values(r.errors ?? {})[0] ?? fallback;

/**
 * Átidőzítés (v0.9): az új határidő a „Határidő mentése” gombbal mentődik (a meglévő `task.setDue` műveleten át). A feladat nyitott
 * marad, a módosítás az előzményekbe kerül. Sikertelen mentésnél hibaüzenet látszik, a beírt dátum megmarad.
 */
function DueEditor({ task }: { task: Task }) {
  const { repo } = useCrmData();
  const id = useId();
  const [draft, setDraft] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [saved, setSaved] = useState("");
  const lock = useRef(false);
  const stored = toDateInputValue(task.dueAt);
  const value = draft ?? stored;
  const dirty = draft !== null && draft !== stored;
  const save = async (next: string | null, message: string) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    setSaved("");
    try {
      const r = await repo.setTaskDue(task.id, next);
      if (!r.ok) return setError(errorOf(r, "A határidő mentése nem sikerült."));
      setDraft(null);
      setSaved(message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <label htmlFor={id} className={FIELD_LABEL}>Határidő</label>
      <div className="flex flex-wrap items-center gap-2">
        <input id={id} type="date" value={value} disabled={busy} aria-invalid={Boolean(error)} aria-describedby={`${id}-msg`}
          onChange={(e) => { setDraft(e.target.value); setSaved(""); setError(""); }}
          className="block min-h-11 rounded-md bg-surface px-3 text-sm text-ink ring-1 ring-control focus-visible:outline-2 focus-visible:outline-accent aria-[invalid=true]:ring-danger" />
        <Button variant="secondary" disabled={busy || !dirty || !value} aria-busy={busy} onClick={() => void save(fromDateInputValue(value), "Az új határidő elmentve.")}>Határidő mentése</Button>
        {task.dueAt ? <Button variant="ghost" size="sm" disabled={busy} onClick={() => void save(null, "A határidő törölve.")}>Határidő törlése</Button> : null}
      </div>
      <p id={`${id}-msg`} className={error ? "text-[13px] text-danger" : "text-[13px] text-ink-muted"} role={error ? "alert" : undefined}>
        {error || "Átidőzítés: válaszd ki az új dátumot, majd mentsd. A feladat nyitott marad."}
      </p>
      {saved ? <p role="status" className="text-[13px] text-ok">{saved}</p> : null}
    </div>
  );
}

const OUTCOME_BUTTON = "inline-flex min-h-11 items-center justify-center gap-2 rounded-md bg-surface px-4 text-sm font-semibold ring-1 transition-colors disabled:cursor-not-allowed disabled:opacity-55";

/**
 * Lezárás (v0.9): kötelező, szabad szöveges Output és két lezáró gomb (Sikeres / Sikertelen); nincs harmadik, általános gomb.
 * Üres vagy csak szóközt tartalmazó Output mellett egyik gomb sem zár le (kliens- és szerveroldalon is). A mentés alatt a gombok
 * zárolva vannak (dupla kattintás ellen), sikertelen mentésnél a beírt szöveg megmarad. A lezárás nem módosítja az ügyfél státuszát.
 */
function CloseTaskForm({ task }: { task: Task }) {
  const { repo } = useCrmData();
  const [output, setOutput] = useState("");
  const [error, setError] = useState("");
  const [formError, setFormError] = useState("");
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const box = useRef<HTMLDivElement>(null);
  const legendId = useId();
  const close = async (outcome: TaskOutcome) => {
    if (lock.current) return;
    if (!output.trim()) {
      setError(TASK_OUTPUT_REQUIRED);
      box.current?.querySelector("textarea")?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    setError("");
    setFormError("");
    try {
      const r = await repo.closeTask(task.id, { outcome, output });
      if (!r.ok) {
        if (r.errors.output) setError(r.errors.output);
        else setFormError(errorOf(r, "A feladat lezárása nem sikerült."));
      }
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <div ref={box}>
        <TextArea label="Output" required rows={4} maxLength={TASK_TEXT_MAX} value={output} error={error} disabled={busy}
          placeholder="Mi történt? Pl. az egyeztetés eredménye, a következő lépés."
          hint={`Kötelező. ${output.length} / ${TASK_TEXT_MAX} karakter`}
          onChange={(e) => { setOutput(e.target.value); if (error) setError(""); }} />
      </div>
      <fieldset aria-labelledby={legendId} className="space-y-2">
        <legend id={legendId} className={FIELD_LABEL}>Feladat lezárása</legend>
        <div className="flex flex-wrap gap-2">
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void close("success")} className={`${OUTCOME_BUTTON} text-ok ring-ok/50 hover:bg-ok-soft`}>
            {TASK_OUTCOME_LABELS.success}<span className="sr-only"> lezárás</span>
          </button>
          <button type="button" disabled={busy} aria-busy={busy} onClick={() => void close("failure")} className={`${OUTCOME_BUTTON} text-danger ring-danger/50 hover:bg-danger-soft`}>
            {TASK_OUTCOME_LABELS.failure}<span className="sr-only"> lezárás</span>
          </button>
        </div>
        <p className="text-[13px] text-ink-muted">A lezárás az ügyfél kapcsolati (Pipeline) státuszát nem módosítja.</p>
      </fieldset>
      {formError ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-[13px] text-danger">{formError}</p> : null}
    </div>
  );
}

/** Egy lezárás (Output) megjelenítése: minősítés, szöveg (sortörésekkel), rögzítő és időpont. */
function OutputEntry({ output }: { output: TaskOutput }) {
  const userName = useUserName();
  return (
    <>
      <p className="font-medium">{outcomeLabel(output) ? `Lezárva — ${outcomeLabel(output)}` : "Lezárva"}</p>
      <p className="whitespace-pre-wrap break-words">{outputText(output) || <em className="text-ink-muted">Output nincs rögzítve</em>}</p>
      <p className="text-[13px] text-ink-muted">Rögzítette: {userName(output.closedBy)} · {formatDateTime(output.closedAt)}</p>
    </>
  );
}

/** Lezárt feladat: a minősítés, a rögzített Output visszaolvasható; újranyitás (az előzmény megmarad). */
function ClosedTask({ task }: { task: Task }) {
  const { repo } = useCrmData();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const lock = useRef(false);
  const out = latestOutput(task);
  const reopen = async () => {
    if (lock.current) return;
    lock.current = true;
    setBusy(true);
    setError("");
    try {
      const r = await repo.reopenTask(task.id);
      if (!r.ok) setError(errorOf(r, "Az újranyitás nem sikerült."));
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <div className="space-y-3">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div><dt className={FIELD_LABEL}>Határidő</dt><dd>{task.dueAt ? formatDate(task.dueAt) : "Nincs"}</dd></div>
        <div><dt className={FIELD_LABEL}>Lezárás időpontja</dt><dd>{task.completedAt ? formatDateTime(task.completedAt) : "—"}</dd></div>
      </dl>
      <section aria-label="Lezárás eredménye" className="space-y-1 rounded-md bg-surface p-3 ring-1 ring-line">
        <p className={FIELD_LABEL}>Output</p>
        {out ? <OutputEntry output={out} /> : <p><em>Korábbi feladat — eredmény nincs rögzítve</em></p>}
      </section>
      <Button variant="secondary" size="sm" disabled={busy} aria-busy={busy} onClick={() => void reopen()}>Feladat újranyitása</Button>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}

/**
 * Feladatsor (v0.9): kompakt - feladat neve, az Input első sora, határidő. A feladatra vagy a „Részletek” gombra kattintva nyílnak a
 * részletek, ebben a sorrendben: feladat neve, Input, határidő és átidőzítés, Output, majd a Sikeres / Sikertelen lezáró gombok.
 * Lezárásra szolgáló checkbox nincs. Lezárt feladatnál a minősítés és az Output visszaolvasható, a feladat újranyitható.
 * Minden módosítás az adatbázisba mentődik; sikertelen mentésnél hibaüzenet látszik és a beírt adat megmarad.
 */
export function TaskRow({ task, data, showCustomer = false, showStatus = false }: { task: Task; data: DataSnapshot; showCustomer?: boolean; showStatus?: boolean }) {
  const [open, setOpen] = useState(false);
  const detailsId = useId();
  const done = isDone(task);
  const overdue = !done && task.dueAt !== undefined && Date.parse(task.dueAt) < new Date().setHours(0, 0, 0, 0);
  const input = inputText(task);
  // Korábbi lezárások: lezárt feladatnál az utolsó előttiek, újranyitott (nyitott) feladatnál mind.
  const earlier = done ? (task.outputs ?? []).slice(0, -1) : (task.outputs ?? []);
  const toggle = () => setOpen((v) => !v);
  return (
    <li className="px-4 py-3" data-task-id={task.id}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={toggle} className="min-h-11 min-w-0 flex-1 rounded-md py-1 text-left hover:bg-canvas">
          <span className={done ? "block break-words text-sm text-ink-muted" : "block break-words text-sm font-medium"}>{task.title}</span>
          {input ? <span className="block max-w-full truncate text-[13px] text-ink-muted">{input.split("\n")[0]}</span> : null}
        </button>
        <TaskStateBadge task={task} overdue={overdue} />
        {showStatus && task.crmStatus ? <Badge>{CRM_STATUS_LABELS[task.crmStatus]}</Badge> : null}
        <button type="button" aria-expanded={open} aria-controls={detailsId} onClick={toggle} className="min-h-11 rounded-md px-2 text-[13px] font-medium text-accent underline underline-offset-2">
          {open ? "Bezárás" : "Részletek"}<span className="sr-only">: {task.title}</span>
        </button>
      </div>
      <p className="text-[13px] text-ink-muted">
        {task.dueAt ? `Határidő: ${formatDate(task.dueAt)}` : "Nincs határidő"}
        {showCustomer ? <> · <CustomerLink id={task.customerId} data={data} /></> : null}
        {done && task.completedAt ? ` · Lezárva: ${formatDate(task.completedAt)}` : ""}
      </p>
      {open ? (
        <div id={detailsId} className="mt-2 space-y-4 rounded-md bg-canvas p-3 text-sm">
          <dl className="grid gap-3 sm:grid-cols-2">
            <div><dt className={FIELD_LABEL}>Feladat</dt><dd className="break-words font-medium">{task.title}</dd></div>
            <div><dt className={FIELD_LABEL}>Státusz, amelyhez tartozik</dt><dd>{task.crmStatus ? CRM_STATUS_LABELS[task.crmStatus] : "Régi feladat (státusz nélkül)"}</dd></div>
            <div className="sm:col-span-2"><dt className={FIELD_LABEL}>Input</dt><dd className="whitespace-pre-wrap break-words">{input || "— nincs megadva —"}</dd></div>
          </dl>
          {done ? <ClosedTask task={task} /> : (
            <>
              <DueEditor task={task} />
              <CloseTaskForm task={task} />
            </>
          )}
          {earlier.length ? (
            <section aria-label={`Korábbi lezárások (${earlier.length})`}>
              <h4 className={FIELD_LABEL}>Korábbi lezárások ({earlier.length})</h4>
              <ul className="mt-1 space-y-2">
                {[...earlier].reverse().map((o, i) => <li key={`${o.closedAt}-${i}`} className="space-y-0.5 border-l-2 border-line pl-3 text-[13px]"><OutputEntry output={o} /></li>)}
              </ul>
            </section>
          ) : null}
        </div>
      ) : null}
    </li>
  );
}
