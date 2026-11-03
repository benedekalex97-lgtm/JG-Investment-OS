"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionGate } from "@/components/settings/nav";
import { Modal } from "@/components/ui/modal";
import { Badge, Button, Card, ErrorState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { getJson, patchJson } from "@/data/data-client";
import { useCrmData } from "@/data/store";
import { formatDateTime } from "@/lib/format";
import { cn } from "@/lib/cn";

interface AdminUser { id: string; name: string; email: string; active: boolean; createdAt: string; lastLoginAt: string | null; permissions: string[] }
interface Perm { key: string; label: string; admin: boolean }
interface UsersResponse { users: AdminUser[]; currentUserId: string; permissions: Perm[] }

/**
 * Beállítások > Felhasználók és jogosultságok (SET-003). A meglévő fiókok és a kiosztott CRM-jogok kezelése: megnyitás, jelenlegi jogok,
 * módosítás, a változások előnézete, megerősítés. A szerver friss jogellenőrzéssel, egy tranzakcióban, a szűk adatbázis-függvényen át
 * hajtja végre és naplózza. A saját jogosultság nem módosítható; rendszerüzemeltetői jog itt nem osztható ki.
 */
export default function UsersPage() {
  return (
    <>
      <PageHeader title="Felhasználók és jogosultságok" description="A meglévő felhasználók és a kiosztott CRM-jogosultságok. Új fiók létrehozása, meghívás és jelszókezelés nem része ennek a felületnek." />
      <SectionGate permissions={["crm.users.manage"]}><Users /></SectionGate>
    </>
  );
}

function Users() {
  const { user: me } = useCrmData();
  const [data, setData] = useState<UsersResponse | null>(null);
  const [error, setError] = useState("");
  const [editing, setEditing] = useState<AdminUser | null>(null);
  const [notice, setNotice] = useState<{ ok: boolean; text: string } | null>(null);
  const load = useCallback(async () => {
    const r = await getJson<UsersResponse>("/api/settings/users");
    if (r.ok) setData(r.value); else setError(r.message);
  }, []);
  // Az első betöltés a render után, időzítve (a meglévő oldalak mintája szerint).
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  if (error) return <ErrorState title="A módosítás nem sikerült." message={error} />;
  if (!data) return <LoadingState />;
  const label = (k: string) => data.permissions.find((p) => p.key === k)?.label ?? k;
  return (
    <div className="space-y-4">
      {notice ? <p role={notice.ok ? "status" : "alert"} className={cn("rounded-md p-3 text-sm", notice.ok ? "bg-ok-soft text-ok" : "bg-danger-soft text-danger")} data-testid="settings-notice">{notice.text}</p> : null}
      <Card>
        <ul className="divide-y divide-line" aria-label="Felhasználók">
          {data.users.map((u) => {
            const self = u.id === (me?.id ?? data.currentUserId);
            return (
              <li key={u.id} className="flex flex-col gap-3 p-4 sm:flex-row sm:items-start" data-testid="user-row">
                <div className="min-w-0 flex-1">
                  <p className="flex flex-wrap items-center gap-2">
                    <span className="break-words font-medium text-ink">{u.name}</span>
                    {u.active ? <Badge tone="ok">Aktív</Badge> : <Badge tone="danger">Letiltott</Badge>}
                    {self ? <Badge>Te</Badge> : null}
                  </p>
                  <p className="break-all text-[13px] text-ink-muted">{u.email}</p>
                  <p className="text-xs text-ink-muted">Utolsó belépés: {u.lastLoginAt ? formatDateTime(u.lastLoginAt) : "nem ismert"}</p>
                  <ul className="mt-2 flex flex-wrap gap-1.5" aria-label={`${u.name} jogosultságai`}>
                    {u.permissions.length ? u.permissions.map((p) => <li key={p}><Badge tone={data.permissions.find((x) => x.key === p)?.admin ? "accent" : "info"}>{label(p)}</Badge></li>)
                      : <li className="text-xs text-ink-muted">Nincs kiosztott CRM-jogosultság (napi CRM-használat)</li>}
                  </ul>
                </div>
                <div className="sm:text-right">
                  {self ? <p className="max-w-56 text-xs text-ink-muted">A saját jogosultságaidat nem módosíthatod.</p>
                    : <Button size="sm" variant="secondary" onClick={() => { setNotice(null); setEditing(u); }} aria-label={`${u.name} jogosultságainak szerkesztése`}>Jogosultságok szerkesztése</Button>}
                </div>
              </li>
            );
          })}
        </ul>
      </Card>
      <p className="text-[13px] text-ink-muted">Rendszerüzemeltetői jogok (adatbázis-mentés, -visszaállítás, migráció, infrastruktúra, titkok) a CRM felületén nem oszthatók ki.</p>
      <Modal open={editing !== null} onClose={() => setEditing(null)} title={editing ? `Jogosultságok: ${editing.name}` : "Jogosultságok"}>
        {editing ? (
          <PermissionForm user={editing} perms={data.permissions} onCancel={() => setEditing(null)}
            onDone={async (ok, text) => { setEditing(null); setNotice({ ok, text }); await load(); }} />
        ) : null}
      </Modal>
    </div>
  );
}

function PermissionForm({ user, perms, onCancel, onDone }: { user: AdminUser; perms: Perm[]; onCancel: () => void; onDone: (ok: boolean, text: string) => Promise<void> }) {
  const [selected, setSelected] = useState<string[]>(user.permissions);
  const [step, setStep] = useState<"edit" | "preview">("edit");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const grant = selected.filter((p) => !user.permissions.includes(p));
  const revoke = user.permissions.filter((p) => !selected.includes(p));
  const label = (k: string) => perms.find((p) => p.key === k)?.label ?? k;
  const toggle = (k: string) => setSelected((s) => (s.includes(k) ? s.filter((x) => x !== k) : [...s, k]));
  const confirm = async () => {
    setBusy(true);
    setError("");
    const r = await patchJson("/api/settings/users/permissions", { userId: user.id, expected: user.permissions, grant, revoke });
    setBusy(false);
    if (r.ok) return onDone(true, "A beállítás mentve.");
    if (r.status === 409 && /időközben/.test(r.message)) return onDone(false, r.message);
    setError(r.message);
  };
  if (step === "preview") {
    return (
      <div className="space-y-4 text-sm">
        <h3 className="font-semibold">Változások előnézete</h3>
        {error ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-danger">A módosítás nem sikerült. {error}</p> : null}
        <ul className="space-y-1" aria-label="Változások">
          {grant.map((p) => <li key={p} className="rounded-md bg-ok-soft p-2 text-ok">+ Kiosztás: {label(p)}</li>)}
          {revoke.map((p) => <li key={p} className="rounded-md bg-danger-soft p-2 text-danger">− Visszavonás: {label(p)}</li>)}
        </ul>
        <p className="text-[13px] text-ink-muted">A változás a megerősítés után azonnal érvényes (a felhasználó következő kérésénél), és bekerül a változásnaplóba.</p>
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" onClick={() => setStep("edit")} disabled={busy}>Vissza</Button>
          <Button onClick={() => void confirm()} disabled={busy} aria-busy={busy}>Megerősítés</Button>
        </div>
      </div>
    );
  }
  const groups: [string, Perm[]][] = [["Adatkezelés", perms.filter((p) => !p.admin)], ["Adminisztráció", perms.filter((p) => p.admin)]];
  return (
    <form onSubmit={(e) => { e.preventDefault(); if (grant.length || revoke.length) setStep("preview"); }} className="space-y-4">
      {!user.active ? <p className="rounded-md bg-warn-soft p-3 text-sm text-warn">Letiltott felhasználó: új jogosultság nem osztható ki, a meglévő visszavonható.</p> : null}
      {groups.map(([title, list]) => (
        <fieldset key={title} className="space-y-2">
          <legend className="text-sm font-semibold">{title}</legend>
          {list.map((p) => (
            <label key={p.key} className="flex min-h-11 items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5 h-5 w-5 accent-accent" checked={selected.includes(p.key)} onChange={() => toggle(p.key)}
                disabled={!user.active && !user.permissions.includes(p.key)} />
              <span>{p.label}<span className="block font-mono text-xs text-ink-muted">{p.key}</span></span>
            </label>
          ))}
        </fieldset>
      ))}
      <p className="text-[13px] text-ink-muted" role="status" aria-live="polite">{grant.length + revoke.length ? `${grant.length} kiosztás, ${revoke.length} visszavonás` : "Nincs módosítás."}</p>
      <div className="flex flex-wrap justify-end gap-2">
        <Button variant="secondary" onClick={onCancel}>Mégse</Button>
        <Button type="submit" disabled={!grant.length && !revoke.length}>Változások előnézete</Button>
      </div>
    </form>
  );
}
