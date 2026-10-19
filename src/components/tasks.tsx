"use client";

import Link from "next/link";
import { createContext, useCallback, useContext, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { CRM_STATUS_LABELS, TASK_OUTCOME_LABELS, TASK_OUTPUT_REQUIRED, TASK_TEXT_MAX } from "@/domain/constants";
import { customerName, inputText, isDone, isOverdue, latestOutput, outcomeLabel, outputText } from "@/domain/logic";
import type { DataSnapshot, Task, TaskOutcome, TaskOutput } from "@/domain/types";
import { formatDate, formatDateTime, fromDateInputValue, toDateInputValue } from "@/lib/format";
import { CustomerLink, useUserName } from "./common";
import { NewTaskForm } from "./forms";
import { TextArea } from "./ui/form";
import { Modal } from "./ui/modal";
import { Badge, Button } from "./ui/primitives";

/**
 * Feladatkezelés (v0.9, CRM-007/009): minden feladatsor ugyanazt az egyetlen, alkalmazásszintű modált nyitja (Áttekintés, napi lista,
 * ügyféladatlap, korábbi státuszok). A modál a feladatot azonosító alapján a friss snapshotból olvassa, így akkor is nyitva marad, ha
 * a lezárt feladat közben kikerül a listából - ez kell a lezárás utáni, opcionális „következő feladat” lépéshez.
 */

const FIELD_LABEL = "text-xs font-medium text-ink-muted";
const errorOf = (r: { ok: boolean; errors?: Record<string, string> }, fallback: string) => r.errors?._form ?? Object.values(r.errors ?? {})[0] ?? fallback;

/** A feladat állapotjelzése: nyitottnál a lejárt határidő, lezártnál a lezárás minősítése (a régi lezárás minősítés nélkül). */
export function TaskStateBadge({ task, now = new Date() }: { task: Task; now?: Date }) {
  if (!isDone(task)) return isOverdue(task, now) ? <Badge tone="danger">Lejárt</Badge> : null;
  const outcome = latestOutput(task)?.outcome;
  if (outcome === "success") return <Badge tone="ok">Lezárva — {TASK_OUTCOME_LABELS.success}</Badge>;
  if (outcome === "failure") return <Badge tone="danger">Lezárva — {TASK_OUTCOME_LABELS.failure}</Badge>;
  return <Badge>Lezárva</Badge>;
}

/**
 * Átidőzítés: az új határidő a „Határidő mentése” gombbal mentődik (a meglévő `task.setDue` műveleten át). A feladat nyitott
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
      <label htmlFor={id} className={FIELD_LABEL}>Határidő módosítása</label>
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
 * Lezárás: kötelező, szabad szöveges Output és két lezáró gomb (Sikeres / Sikertelen); nincs harmadik, általános gomb.
 * Üres vagy csak szóközt tartalmazó Output mellett egyik gomb sem zár le (kliens- és szerveroldalon is). A mentés alatt a gombok
 * zárolva vannak (dupla kattintás ellen), sikertelen mentésnél a beírt szöveg megmarad. A lezárás nem módosítja az ügyfél státuszát.
 */
function CloseTaskForm({ task, onClosed }: { task: Task; onClosed: (outcome: TaskOutcome) => void }) {
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
        return;
      }
      onClosed(outcome);
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
      <div><p className={FIELD_LABEL}>Lezárás időpontja</p><p>{task.completedAt ? formatDateTime(task.completedAt) : "—"}</p></div>
      <section aria-label="Lezárás eredménye" className="space-y-1 rounded-md bg-canvas p-3 ring-1 ring-line">
        <p className={FIELD_LABEL}>Output</p>
        {out ? <OutputEntry output={out} /> : <p><em>Korábbi feladat — eredmény nincs rögzítve</em></p>}
      </section>
      <Button variant="secondary" size="sm" disabled={busy} aria-busy={busy} onClick={() => void reopen()}>Feladat újranyitása</Button>
      {error ? <p role="alert" className="text-[13px] text-danger">{error}</p> : null}
    </div>
  );
}

// --------------------------------------------------------------------- Modál
type Step = { kind: "details" } | { kind: "next"; outcome: TaskOutcome } | { kind: "new"; outcome: TaskOutcome } | { kind: "created"; task: Task };
const STEP_TITLES: Record<Step["kind"], string> = { details: "Feladat részletei", next: "Következő lépés", new: "Következő feladat", created: "Következő feladat létrehozva" };

interface ModalState { taskId: string; nonce: number; step: Step }
const TaskModalContext = createContext<{ openTask: (taskId: string) => void } | null>(null);

export function useTaskModal() {
  const ctx = useContext(TaskModalContext);
  if (!ctx) throw new Error("useTaskModal csak TaskModalProvideren belül használható");
  return ctx;
}

/** Az egyetlen feladatmodál szolgáltatója: az alkalmazás gyökerében, a CRM adat-store-on belül. */
export function TaskModalProvider({ children }: { children: ReactNode }) {
  const { data, phase } = useCrmData();
  const [state, setState] = useState<ModalState | null>(null);
  const openTask = useCallback((taskId: string) => setState((s) => ({ taskId, nonce: (s?.nonce ?? 0) + 1, step: { kind: "details" } })), []);
  const close = useCallback(() => setState(null), []);
  const setStep = useCallback((step: Step) => setState((s) => (s ? { ...s, step } : s)), []);
  const value = useMemo(() => ({ openTask }), [openTask]);
  const open = state !== null && phase === "ready" && data !== null;
  return (
    <TaskModalContext.Provider value={value}>
      {children}
      <Modal open={open} onClose={close} title={state ? STEP_TITLES[state.step.kind] : STEP_TITLES.details} fallbackFocus={() => document.getElementById("main")}>
        {open ? <TaskDialog key={state.nonce} data={data} taskId={state.taskId} step={state.step} setStep={setStep} onClose={close} openTask={openTask} /> : null}
      </Modal>
    </TaskModalContext.Provider>
  );
}

function TaskDialog({ data, taskId, step, setStep, onClose, openTask }: { data: DataSnapshot; taskId: string; step: Step; setStep: (s: Step) => void; onClose: () => void; openTask: (id: string) => void }) {
  const task = data.tasks.find((t) => t.id === taskId);
  if (!task) return <p role="alert" className="text-sm text-danger">A feladat nem található (lehet, hogy az ügyfél már nem aktív).</p>;
  const customer = data.customers.find((c) => c.id === task.customerId);

  if (step.kind === "next") {
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-md bg-canvas p-3 text-sm ring-1 ring-line">
          <span className="font-semibold">Feladat lezárva — {TASK_OUTCOME_LABELS[step.outcome]}.</span> A minősítés és az Output elmentve.
        </p>
        <div className="space-y-1">
          <p className="text-sm font-semibold">Szeretnél következő feladatot létrehozni?</p>
          <p className="text-[13px] text-ink-muted">Ugyanehhez az ügyfélhez: {customer ? customerName(customer) : "—"}. A feladat csak a jóváhagyásoddal jön létre, az ügyfél státusza nem változik.</p>
        </div>
        <div className="flex flex-wrap gap-2">
          <Button autoFocus onClick={() => setStep({ kind: "new", outcome: step.outcome })}>Új feladat létrehozása</Button>
          <Button variant="secondary" onClick={onClose}>Most nem</Button>
        </div>
      </div>
    );
  }
  if (step.kind === "new") {
    return (
      <div className="space-y-3">
        <p className="text-[13px] text-ink-muted">Az előző feladat lezárása ({TASK_OUTCOME_LABELS[step.outcome]}) már elmentve; ez külön művelet.</p>
        <NewTaskForm customerId={task.customerId} cancelLabel="Most nem" onCancel={onClose} onCreated={(created) => setStep({ kind: "created", task: created })} />
      </div>
    );
  }
  if (step.kind === "created") {
    const t = step.task;
    return (
      <div className="space-y-4">
        <p role="status" className="rounded-md bg-ok-soft p-3 text-sm text-ok">
          Az új feladat létrehozva: <span className="font-semibold">{t.title}</span> · {t.dueAt ? `Határidő: ${formatDate(t.dueAt)}` : "Nincs határidő"}.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button autoFocus onClick={onClose}>Vissza a listához</Button>
          <Button variant="secondary" onClick={() => openTask(t.id)}>Az új feladat megnyitása</Button>
        </div>
      </div>
    );
  }

  const done = isDone(task);
  const input = inputText(task);
  // Korábbi lezárások: lezárt feladatnál az utolsó előttiek, újranyitott (nyitott) feladatnál mind.
  const earlier = done ? (task.outputs ?? []).slice(0, -1) : (task.outputs ?? []);
  return (
    <div className="space-y-4 text-sm">
      <dl className="grid gap-3 sm:grid-cols-2">
        <div className="min-w-0 sm:col-span-2"><dt className={FIELD_LABEL}>Feladat</dt><dd className="break-words text-base font-semibold">{task.title}</dd></div>
        <div className="min-w-0"><dt className={FIELD_LABEL}>Ügyfél</dt><dd className="break-words">{customer ? <Link href={`/customers/${customer.id}`} onClick={onClose} className="font-medium text-accent underline-offset-2 hover:underline">{customerName(customer)}</Link> : "Ismeretlen ügyfél"}</dd></div>
        <div className="min-w-0"><dt className={FIELD_LABEL}>Állapot</dt><dd className="flex flex-wrap items-center gap-2">{done ? <TaskStateBadge task={task} /> : <>Nyitott <TaskStateBadge task={task} /></>}</dd></div>
        <div className="min-w-0"><dt className={FIELD_LABEL}>Státusz, amelyhez tartozik</dt><dd>{task.crmStatus ? CRM_STATUS_LABELS[task.crmStatus] : "Régi feladat (státusz nélkül)"}</dd></div>
        <div className="min-w-0"><dt className={FIELD_LABEL}>Határidő</dt><dd>{task.dueAt ? formatDate(task.dueAt) : "Nincs"}</dd></div>
        <div className="min-w-0 sm:col-span-2"><dt className={FIELD_LABEL}>Input</dt><dd className="whitespace-pre-wrap break-words">{input || "— nincs megadva —"}</dd></div>
      </dl>
      {done ? <ClosedTask task={task} /> : (
        <>
          <DueEditor task={task} />
          <CloseTaskForm task={task} onClosed={(outcome) => setStep({ kind: "next", outcome })} />
        </>
      )}
      {earlier.length ? (
        <section aria-label={`Korábbi lezárások (${earlier.length})`}>
          <h3 className={FIELD_LABEL}>Korábbi lezárások ({earlier.length})</h3>
          <ul className="mt-1 space-y-2">
            {[...earlier].reverse().map((o, i) => <li key={`${o.closedAt}-${i}`} className="space-y-0.5 border-l-2 border-line pl-3 text-[13px]"><OutputEntry output={o} /></li>)}
          </ul>
        </section>
      ) : null}
    </div>
  );
}

// --------------------------------------------------------------------- Sor
/**
 * Feladatsor: kompakt - feladat neve, az Input első sora, határidő (és opcionálisan az ügyfél). A feladat nevére vagy a „Részletek”
 * gombra kattintva a közös feladatmodál nyílik; a sor alatt nincs lenyíló panel és nincs lezáró checkbox.
 */
export function TaskRow({ task, data, showCustomer = false, showStatus = false }: { task: Task; data: DataSnapshot; showCustomer?: boolean; showStatus?: boolean }) {
  const { openTask } = useTaskModal();
  const done = isDone(task);
  const input = inputText(task);
  const open = () => openTask(task.id);
  return (
    <li className="px-4 py-3" data-task-id={task.id}>
      <div className="flex flex-wrap items-center gap-2">
        <button type="button" aria-haspopup="dialog" onClick={open} className="min-h-11 min-w-0 flex-1 rounded-md py-1 text-left hover:bg-canvas">
          <span className={done ? "block break-words text-sm text-ink-muted" : "block break-words text-sm font-medium"}>{task.title}</span>
          {input ? <span className="block max-w-full truncate text-[13px] text-ink-muted">{input.split("\n")[0]}</span> : null}
        </button>
        <TaskStateBadge task={task} />
        {showStatus && task.crmStatus ? <Badge>{CRM_STATUS_LABELS[task.crmStatus]}</Badge> : null}
        <button type="button" aria-haspopup="dialog" onClick={open} className="min-h-11 rounded-md px-2 text-[13px] font-medium text-accent underline underline-offset-2">
          Részletek<span className="sr-only">: {task.title}</span>
        </button>
      </div>
      <p className="text-[13px] text-ink-muted">
        {showCustomer ? <><CustomerLink id={task.customerId} data={data} /> · </> : null}
        {task.dueAt ? `Határidő: ${formatDate(task.dueAt)}` : "Nincs határidő"}
        {done && task.completedAt ? ` · Lezárva: ${formatDate(task.completedAt)}` : ""}
      </p>
    </li>
  );
}
