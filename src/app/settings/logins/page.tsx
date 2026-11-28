"use client";

import { useCallback, useEffect, useState } from "react";
import { SectionGate } from "@/components/settings/nav";
import { FilterSelect } from "@/components/ui/form";
import { Badge, Button, Card, EmptyState, ErrorState, LoadingState, PageHeader } from "@/components/ui/primitives";
import { getJson } from "@/data/data-client";
import { formatDateTime } from "@/lib/format";

interface Entry {
  id: number; at: string; event: "login_success" | "login_failure" | "logout"; method: "google" | "password";
  userId: string | null; userName: string | null; email: string | null; reason: string | null; device: string | null;
}

const EVENT: Record<Entry["event"], { label: string; tone: "ok" | "danger" | "neutral" }> = {
  login_success: { label: "Sikeres belépés", tone: "ok" },
  login_failure: { label: "Sikertelen belépés", tone: "danger" },
  logout: { label: "Kilépés", tone: "neutral" },
};
const METHOD: Record<Entry["method"], string> = { google: "Google", password: "Jelszó" };
const REASON: Record<string, string> = {
  not_allowed: "nem engedélyezett fiók (nincs ilyen aktív felhasználó)",
  cancelled: "a belépést a Google-oldalon megszakították",
  failed: "a Google-belépés technikai hibával megszakadt",
  invalid_credentials: "hibás e-mail-cím vagy jelszó",
  rate_limited: "túl sok sikertelen próbálkozás (ideiglenesen tiltva)",
};

/**
 * Beállítások > Belépési napló (v1.5): ki, mikor, milyen módon és melyik eszközről lépett be vagy ki; a sikertelen belépési kísérletek
 * okkal. Csak olvasható; 12 hónapig őrződik. IP-címet, jelszót, tokent nem tartalmaz.
 */
export default function LoginsPage() {
  return (
    <>
      <PageHeader title="Belépési napló" description="Ki, mikor és melyik eszközről lépett be vagy ki, valamint a sikertelen belépési kísérletek. A napló nem szerkeszthető, 12 hónapig őrződik." />
      <SectionGate permissions={["crm.settings.audit.read"]}><Logins /></SectionGate>
    </>
  );
}

function Logins() {
  const [entries, setEntries] = useState<Entry[] | null>(null);
  const [next, setNext] = useState<number | null>(null);
  const [event, setEvent] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const load = useCallback(async (before?: number) => {
    setBusy(true);
    const q = new URLSearchParams({ limit: "50", ...(before ? { before: String(before) } : {}), ...(event ? { event } : {}) });
    const r = await getJson<{ entries: Entry[]; nextBefore: number | null }>(`/api/settings/logins?${q}`);
    setBusy(false);
    if (!r.ok) return setError(r.message);
    setEntries((cur) => (before && cur ? [...cur, ...r.value.entries] : r.value.entries));
    setNext(r.value.nextBefore);
  }, [event]);
  useEffect(() => { const t = setTimeout(() => void load(), 0); return () => clearTimeout(t); }, [load]);
  if (error) return <ErrorState message={error} />;
  return (
    <div className="space-y-4">
      <FilterSelect label="Szűrés" value={event} onChange={(e) => setEvent(e.target.value)} className="max-w-xs">
        <option value="">Minden esemény</option>
        {Object.entries(EVENT).map(([k, v]) => <option key={k} value={k}>{v.label}</option>)}
      </FilterSelect>
      {!entries ? <LoadingState /> : entries.length === 0 ? <Card><EmptyState title="Még nincs bejegyzés." /></Card> : (
        <ol className="space-y-2" aria-label="Belépési napló bejegyzései">
          {entries.map((e) => (
            <li key={e.id} className="rounded-lg bg-surface p-4 text-sm ring-1 ring-line" data-testid="login-entry">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-semibold text-ink">{e.userName ?? e.email ?? "Ismeretlen"}</span>
                <Badge tone={EVENT[e.event].tone}>{EVENT[e.event].label}</Badge>
                <Badge>{METHOD[e.method]}</Badge>
                <span className="ml-auto text-xs text-ink-subtle"><time dateTime={e.at}>{formatDateTime(e.at)}</time></span>
              </div>
              {e.email && e.userName ? <p className="mt-1 break-all text-xs text-ink-muted">{e.email}</p> : null}
              {e.device ? <p className="text-xs text-ink-muted">Eszköz: {e.device}</p> : null}
              {e.reason ? <p className="text-xs text-danger">Ok: {REASON[e.reason] ?? e.reason}</p> : null}
            </li>
          ))}
        </ol>
      )}
      {next ? <Button variant="secondary" onClick={() => void load(next)} disabled={busy} aria-busy={busy}>Továbbiak betöltése</Button> : null}
    </div>
  );
}
