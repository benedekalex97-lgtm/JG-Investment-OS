"use client";

import { useCallback, useEffect, useRef, useState, type DragEvent, type FormEvent } from "react";
import { getJson, patchJson, postJson } from "@/data/data-client";
import { useCrmData } from "@/data/store";
import { STATUS_COLOR_LABELS, STATUS_COLORS, STATUS_SEMANTIC_LABELS, type StatusColor, type StatusSemantic } from "@/domain/config";
import { cn } from "@/lib/cn";
import { Modal } from "../ui/modal";
import { TextArea, TextInput } from "../ui/form";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, TONE_DOT } from "../ui/primitives";

/**
 * Egységes katalógus-szerkesztő (v1.1, SET-004-006): Pipeline-státuszok, feladattípusok és Input-opciók. Minden módosítás a szerveren
 * ellenőrzött és naplózott; a felület csak a szabályokat jeleníti meg előre (pl. rendszerelem nem archiválható). Párhuzamos módosításnál
 * a szerver 409-et ad: a felület ezt kiírja, és frissítést kér - nincs csendes felülírás. Rendezés: húzással ÉS billentyűzettel
 * használható Feljebb/Lejjebb gombokkal; a sorrend csak a „Sorrend mentése” után tárolódik.
 */
export type Kind = "pipeline" | "task-types" | "task-inputs";

export interface Item {
  key: string; label: string; sortOrder: number; isActive: boolean; isSystem: boolean; version: number;
  description?: string | null; color?: StatusColor; semantic?: StatusSemantic; requiresVerification?: boolean; labelLocked?: boolean; allowsNote?: boolean;
  usage: { customers?: number; tasks: number; openTasks: number };
}

const TEXT: Record<Kind, { noun: string; add: string; empty: string; usage: (u: Item["usage"]) => string }> = {
  pipeline: {
    noun: "státusz", add: "Új státusz hozzáadása", empty: "Nincs státusz.",
    usage: (u) => `${u.customers ?? 0} ügyfél · ${u.tasks} feladat`,
  },
  "task-types": { noun: "feladattípus", add: "Új feladattípus hozzáadása", empty: "Nincs feladattípus.", usage: (u) => `${u.tasks} feladat (${u.openTasks} nyitott)` },
  "task-inputs": { noun: "Input-opció", add: "Új Input-opció hozzáadása", empty: "Nincs Input-opció.", usage: (u) => `${u.tasks} feladat (${u.openTasks} nyitott)` },
};

const SAVED = "A beállítás mentve.";
const FAILED = "A módosítás nem sikerült.";

type Notice = { tone: "ok" | "error" | "conflict"; text: string } | null;

export function CatalogEditor({ kind }: { kind: Kind }) {
  const { reloadData } = useCrmData();
  const [items, setItems] = useState<Item[] | null>(null);
  const [order, setOrder] = useState<string[] | null>(null);
  const [loadError, setLoadError] = useState("");
  const [notice, setNotice] = useState<Notice>(null);
  const [editing, setEditing] = useState<Item | "new" | null>(null);
  const [archiving, setArchiving] = useState<Item | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const live = useRef<HTMLParagraphElement>(null);
  const t = TEXT[kind];

  const load = useCallback(async () => {
    const r = await getJson<{ items: Item[] }>(`/api/settings/${kind}`);
    if (r.ok) {
      setItems(r.value.items);
      setOrder(null);
      setLoadError("");
    } else setLoadError(r.message);
  }, [kind]);
  // Az első betöltés a render után, időzítve (a meglévő oldalak mintája szerint).
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);

  /** Sikeres mentés után a lista és a teljes CRM-nézet (snapshot-konfiguráció) frissül. */
  const saved = async (text = SAVED) => {
    setNotice({ tone: "ok", text });
    await Promise.all([load(), reloadData()]);
  };
  const failed = (status: number, message: string) => {
    setNotice(status === 409 && /időközben/.test(message) ? { tone: "conflict", text: message } : { tone: "error", text: `${FAILED} ${message === FAILED ? "" : message}`.trim() });
  };

  if (loadError) return <ErrorState title={FAILED} message={loadError} />;
  if (!items) return <LoadingState />;

  const shown = order ? order.map((k) => items.find((i) => i.key === k)!).filter(Boolean) : items;
  const move = (key: string, delta: number) => {
    const keys = shown.map((i) => i.key);
    const from = keys.indexOf(key);
    const to = from + delta;
    if (from < 0 || to < 0 || to >= keys.length) return;
    keys.splice(to, 0, ...keys.splice(from, 1));
    setOrder(keys);
    const label = items.find((i) => i.key === key)?.label ?? key;
    if (live.current) live.current.textContent = `${label}: ${to + 1}. hely a(z) ${keys.length} közül. A sorrend még nincs mentve.`;
  };
  const drop = (target: string) => {
    if (!dragKey || dragKey === target) return;
    const keys = shown.map((i) => i.key);
    keys.splice(keys.indexOf(target), 0, ...keys.splice(keys.indexOf(dragKey), 1));
    setOrder(keys);
    setDragKey(null);
  };
  const saveOrder = async () => {
    if (!order) return;
    setBusy(true);
    const r = await patchJson(`/api/settings/${kind}/order`, { order: order.map((k) => ({ key: k, version: items.find((i) => i.key === k)!.version })) });
    setBusy(false);
    if (r.ok) await saved();
    else failed(r.status, r.message);
  };
  const reactivate = async (it: Item) => {
    setBusy(true);
    const r = await patchJson(`/api/settings/${kind}`, { key: it.key, version: it.version, isActive: true });
    setBusy(false);
    if (r.ok) await saved();
    else failed(r.status, r.message);
  };

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-sm text-ink-muted">{items.filter((i) => i.isActive).length} aktív, {items.filter((i) => !i.isActive).length} archivált</p>
        <Button onClick={() => { setNotice(null); setEditing("new"); }} disabled={busy || order !== null}>+ {t.add}</Button>
      </div>

      {notice ? (
        <div role={notice.tone === "ok" ? "status" : "alert"} className={cn("flex flex-wrap items-center gap-3 rounded-md p-3 text-sm", notice.tone === "ok" ? "bg-ok-soft text-ok" : notice.tone === "conflict" ? "bg-warn-soft text-warn" : "bg-danger-soft text-danger")} data-testid="settings-notice">
          <span className="min-w-0 flex-1 break-words">{notice.text}</span>
          {notice.tone === "conflict" ? <Button size="sm" variant="secondary" onClick={() => { setNotice(null); void load(); }}>Adatok frissítése</Button> : null}
        </div>
      ) : null}

      {order ? (
        <div className="flex flex-wrap items-center gap-2 rounded-md bg-info-soft p-3 text-sm text-info" data-testid="order-bar">
          <span className="min-w-0 flex-1">A sorrend módosult, de még nincs mentve.</span>
          <Button size="sm" onClick={() => void saveOrder()} disabled={busy} aria-busy={busy}>Sorrend mentése</Button>
          <Button size="sm" variant="secondary" onClick={() => setOrder(null)} disabled={busy}>Elvetés</Button>
        </div>
      ) : null}
      <p ref={live} className="sr-only" role="status" aria-live="polite" />

      <Card>
        {shown.length === 0 ? <EmptyState title={t.empty} /> : (
          <ol className="divide-y divide-line" aria-label={`${t.noun} lista (sorrendben)`}>
            {shown.map((it, idx) => (
              <li key={it.key} data-testid="catalog-row" data-key={it.key}
                draggable={!busy}
                onDragStart={(e: DragEvent) => { setDragKey(it.key); e.dataTransfer.effectAllowed = "move"; }}
                onDragOver={(e) => { e.preventDefault(); }}
                onDrop={(e) => { e.preventDefault(); drop(it.key); }}
                onDragEnd={() => setDragKey(null)}
                className={cn("flex flex-col gap-3 p-4 sm:flex-row sm:items-center", !it.isActive && "bg-canvas", dragKey === it.key && "opacity-60")}>
                <div className="flex min-w-0 flex-1 items-start gap-3">
                  <span aria-hidden className="mt-1 hidden cursor-grab select-none text-ink-subtle sm:block" title="Húzd az átrendezéshez">⋮⋮</span>
                  {kind === "pipeline" ? <span aria-hidden className={cn("mt-1.5 size-3 shrink-0 rounded-full", TONE_DOT[it.color ?? "neutral"])} /> : null}
                  <div className="min-w-0 flex-1">
                    <p className="flex flex-wrap items-center gap-2">
                      <span className="break-words font-medium text-ink" data-testid="catalog-label">{it.label}</span>
                      {it.isActive ? null : <Badge tone="warn">Archivált</Badge>}
                      {it.isSystem ? <Badge>Rendszer</Badge> : null}
                      {it.labelLocked ? <Badge tone="info">Név zárolva</Badge> : null}
                      {kind === "task-inputs" && it.allowsNote ? <Badge tone="accent">Megjegyzés engedélyezett</Badge> : null}
                    </p>
                    <p className="mt-0.5 break-words text-xs text-ink-muted">
                      <span className="font-mono">{it.key}</span> · {t.usage(it.usage)}
                      {kind === "pipeline" && it.color ? <> · Szín: {STATUS_COLOR_LABELS[it.color]}</> : null}
                    </p>
                    {kind === "pipeline" && it.semantic && it.semantic !== "workflow" ? <p className="mt-0.5 text-xs text-ink-muted">Védett működés: {STATUS_SEMANTIC_LABELS[it.semantic]}</p> : null}
                    {it.description ? <p className="mt-1 break-words text-[13px] text-ink">{it.description}</p> : null}
                  </div>
                </div>
                <div className="flex flex-wrap items-center gap-2 sm:justify-end">
                  <div role="group" aria-label={`${it.label} sorrendje`} className="flex gap-1">
                    <Button size="sm" variant="secondary" aria-label={`${it.label} feljebb mozgatása`} disabled={busy || idx === 0} onClick={() => move(it.key, -1)}>↑</Button>
                    <Button size="sm" variant="secondary" aria-label={`${it.label} lejjebb mozgatása`} disabled={busy || idx === shown.length - 1} onClick={() => move(it.key, 1)}>↓</Button>
                  </div>
                  <Button size="sm" variant="secondary" disabled={busy || order !== null} onClick={() => { setNotice(null); setEditing(it); }} aria-label={`${it.label} szerkesztése`}>Szerkesztés</Button>
                  {it.isActive ? (
                    it.isSystem
                      ? <span className="text-xs text-ink-muted">Rendszerelem: nem archiválható</span>
                      : <Button size="sm" variant="danger" disabled={busy || order !== null} onClick={() => { setNotice(null); setArchiving(it); }} aria-label={`${it.label} archiválása`}>Archiválás</Button>
                  ) : (
                    <Button size="sm" variant="secondary" disabled={busy || order !== null} onClick={() => void reactivate(it)} aria-label={`${it.label} újraaktiválása`}>Újraaktiválás</Button>
                  )}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>

      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing === "new" ? t.add : `${t.noun.charAt(0).toUpperCase()}${t.noun.slice(1)} szerkesztése`}>
        {editing !== null ? (
          <EditForm kind={kind} item={editing === "new" ? null : editing} onCancel={() => setEditing(null)}
            onDone={async (msg) => { setEditing(null); await saved(msg); }} onConflict={(m) => { setEditing(null); setNotice({ tone: "conflict", text: m }); }} />
        ) : null}
      </Modal>

      <Modal open={archiving !== null} onClose={() => setArchiving(null)} title={`${t.noun.charAt(0).toUpperCase()}${t.noun.slice(1)} archiválása`}>
        {archiving ? <ArchiveForm kind={kind} item={archiving} onCancel={() => setArchiving(null)}
          onDone={async () => { setArchiving(null); await saved(); }} onFail={(s, m) => { setArchiving(null); failed(s, m); }} /> : null}
      </Modal>
    </div>
  );
}

function EditForm({ kind, item, onCancel, onDone, onConflict }: { kind: Kind; item: Item | null; onCancel: () => void; onDone: (msg?: string) => Promise<void>; onConflict: (m: string) => void }) {
  const [label, setLabel] = useState(item?.label ?? "");
  const [description, setDescription] = useState(item?.description ?? "");
  const [color, setColor] = useState<StatusColor>(item?.color ?? "neutral");
  const [allowsNote, setAllowsNote] = useState(item?.allowsNote ?? false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const body: Record<string, unknown> = {};
    if (!item || label.trim() !== item.label) body.label = label;
    if (kind === "pipeline") {
      if (!item || (description || "") !== (item.description ?? "")) body.description = item ? (description.trim() ? description : null) : (description.trim() || undefined);
      if (!item || color !== item.color) body.color = color;
    }
    if (kind === "task-inputs" && (!item || allowsNote !== item.allowsNote)) body.allowsNote = allowsNote;
    if (item && Object.keys(body).length === 0) { setBusy(false); return onCancel(); }
    const r = item ? await patchJson(`/api/settings/${kind}`, { key: item.key, version: item.version, ...body }) : await postJson(`/api/settings/${kind}`, body);
    setBusy(false);
    if (r.ok) return onDone();
    if (r.status === 409 && /időközben/.test(r.message)) return onConflict(r.message);
    setError(r.message || FAILED);
  };
  return (
    <form onSubmit={submit} noValidate className="space-y-4">
      {error ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{FAILED} {error === FAILED ? "" : error}</p> : null}
      {item ? <p className="text-[13px] text-ink-muted">Technikai azonosító (nem módosítható): <span className="font-mono">{item.key}</span></p> : <p className="text-[13px] text-ink-muted">A technikai azonosító a megnevezésből készül, és később nem változik.</p>}
      <TextInput label="Megnevezés" required maxLength={60} value={label} onChange={(e) => setLabel(e.target.value)} disabled={item?.labelLocked}
        hint={item?.labelLocked ? "Compliance-releváns megnevezés: a felületről nem módosítható." : `${label.length} / 60 karakter`} autoFocus={!item?.labelLocked} />
      {kind === "pipeline" ? (
        <>
          <TextArea label="Leírás (opcionális)" maxLength={300} rows={2} value={description} onChange={(e) => setDescription(e.target.value)} hint={`${description.length} / 300 karakter`} />
          <fieldset>
            <legend className="mb-2 text-sm font-medium">Megjelenítési szín</legend>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              {STATUS_COLORS.map((c) => (
                <label key={c} className={cn("flex min-h-11 cursor-pointer items-center gap-2 rounded-md px-3 text-sm ring-1 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-accent", color === c ? "bg-accent-soft ring-accent" : "ring-line-strong")}>
                  <input type="radio" name="color" value={c} checked={color === c} onChange={() => setColor(c)} className="sr-only" />
                  <span aria-hidden className={cn("size-3 rounded-full", TONE_DOT[c])} />{STATUS_COLOR_LABELS[c]}
                </label>
              ))}
            </div>
            <p className="mt-1 text-[13px] text-ink-muted">A szín csak megjelenítés: üzleti szabályt nem változtat.</p>
          </fieldset>
          {item?.semantic && item.semantic !== "workflow" ? <p className="rounded-md bg-info-soft p-3 text-[13px] text-info">Védett működés (nem módosítható): {STATUS_SEMANTIC_LABELS[item.semantic]}</p>
            : !item ? <p className="rounded-md bg-canvas p-3 text-[13px] text-ink-muted">Az új státusz egyszerű, belső munkafolyamat-státusz: nem jelent igazolt tőkeelhelyezést, számlanyitást vagy megkeresési engedélyt.</p> : null}
        </>
      ) : null}
      {kind === "task-inputs" ? (
        <label className="flex items-start gap-2 text-sm">
          <input type="checkbox" className="mt-0.5 h-5 w-5 accent-accent" checked={allowsNote} onChange={(e) => setAllowsNote(e.target.checked)} />
          <span>Rövid megjegyzés adható hozzá (legfeljebb 500 karakter). <span className="block text-[13px] text-ink-muted">Csak akkor engedélyezd, ha valóban szükséges: a megjegyzés személyes adatot tartalmazhat.</span></span>
        </label>
      ) : null}
      <div className="flex flex-wrap justify-end gap-2 pt-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Mégse</Button>
        <Button type="submit" disabled={busy} aria-busy={busy}>Mentés</Button>
      </div>
    </form>
  );
}

function ArchiveForm({ kind, item, onCancel, onDone, onFail }: { kind: Kind; item: Item; onCancel: () => void; onDone: () => Promise<void>; onFail: (status: number, message: string) => void }) {
  const [busy, setBusy] = useState(false);
  const inUse = (item.usage.customers ?? 0) + item.usage.openTasks;
  const submit = async () => {
    setBusy(true);
    const r = await patchJson(`/api/settings/${kind}`, { key: item.key, version: item.version, isActive: false, confirmInUse: true });
    setBusy(false);
    if (r.ok) return onDone();
    onFail(r.status, r.message);
  };
  return (
    <div className="space-y-4 text-sm">
      <p>Biztosan archiválod: <span className="font-semibold">„{item.label}”</span>?</p>
      {inUse > 0 ? (
        <p role="alert" className="rounded-md bg-warn-soft p-3 text-warn">
          Használatban van: {TEXT[kind].usage(item.usage)}. Az archiválás NEM helyezi át az ügyfeleket és a feladatokat - a jelenlegi értéküket
          megtartják, és továbbra is megtekinthetők; csak új hozzárendelésnél nem választható.
        </p>
      ) : <p className="text-ink-muted">Az archivált elem új rekordhoz nem választható, a korábbi rekordokon és az előzményekben megmarad. Később újraaktiválható.</p>}
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>Mégse</Button>
        <Button variant="danger" onClick={() => void submit()} disabled={busy} aria-busy={busy}>Archiválás megerősítése</Button>
      </div>
    </div>
  );
}
