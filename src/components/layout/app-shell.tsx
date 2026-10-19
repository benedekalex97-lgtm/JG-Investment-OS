"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { TextInput } from "@/components/ui/form";
import { Button, LoadingState } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";

export const NAV = [
  { href: "/", label: "Áttekintés" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/customers", label: "Ügyfelek" },
] as const;

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

function NavLinks({ path, orientation }: { path: string; orientation: "vertical" | "horizontal" }) {
  return (
    <ul className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : "flex-row")}>
      {NAV.map((n) => {
        const active = isActive(path, n.href);
        return (
          <li key={n.href} className={orientation === "horizontal" ? "flex-1" : undefined}>
            <Link
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors",
                orientation === "horizontal" && "justify-center",
                active ? "bg-on-carbon/10 text-on-carbon" : "text-on-carbon-muted hover:bg-on-carbon/5 hover:text-on-carbon",
              )}
            >
              {n.label}
            </Link>
          </li>
        );
      })}
    </ul>
  );
}

function Brand() {
  return (
    <Link href="/" className="block rounded-md px-3 py-1 text-on-carbon">
      <span className="block text-[15px] font-semibold tracking-tight">JG Investment OS</span>
      <span className="block text-xs text-on-carbon-muted">v0.6 · pilot</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { phase, user, logout, environmentLabel, legacy } = useCrmData();
  const current = NAV.find((n) => isActive(path, n.href))?.label ?? "";
  const ready = phase === "ready";

  return (
    <div className="min-h-screen lg:grid lg:grid-cols-[15rem_1fr]">
      <a href="#main" className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-surface focus:px-3 focus:py-2">
        Ugrás a tartalomhoz
      </a>

      {/* Desktop oldalsáv */}
      <aside className="hidden bg-carbon p-3 lg:block">
        <div className="sticky top-3 flex h-[calc(100vh-1.5rem)] flex-col justify-between">
          <div className="space-y-6">
            <Brand />
            {ready ? <nav aria-label="Fő navigáció"><NavLinks path={path} orientation="vertical" /></nav> : null}
          </div>
          <p className="px-3 text-xs leading-relaxed text-on-carbon-muted">Belső pilot. Valós ügyféladat rögzítése csak külön jóváhagyás után, éles környezetben történhet.</p>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobil fejléc: három elemű navigáció, mindig látható */}
        <div className="sticky top-0 z-30 bg-carbon lg:hidden">
          <div className="flex min-h-14 items-center px-3"><Brand /></div>
          {ready ? (
            <nav aria-label="Fő navigáció (mobil)" className="border-t border-on-carbon/10 p-2">
              <NavLinks path={path} orientation="horizontal" />
            </nav>
          ) : null}
        </div>

        {/* Fejléc: oldaljelző + környezet + felhasználó */}
        <div className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
            <p className="text-sm text-ink-muted">{ready ? <>Aktuális oldal: <span className="font-medium text-ink">{current}</span></> : "JG Investment OS"}</p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              {environmentLabel ? <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn" data-testid="environment-label">{environmentLabel}</span> : null}
              {ready && user ? (
                <>
                  <span>Bejelentkezve: <span className="font-medium text-ink" data-testid="current-user">{user.name}</span></span>
                  <button type="button" onClick={() => void logout()} className="min-h-9 rounded-md px-2 font-medium text-accent underline underline-offset-2 hover:bg-accent-soft">
                    Kijelentkezés
                  </button>
                </>
              ) : null}
            </p>
          </div>
        </div>

        {legacy.items.length ? <LegacyNotice /> : null}

        <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">
          <Gate>{children}</Gate>
        </main>
      </div>
    </div>
  );
}

/** Állapotkapu: betöltés, belépés, vagy a tartós infrastruktúra hiánya - az oldalak csak bejelentkezve és elérhető adatbázisnál töltődnek be. */
function Gate({ children }: { children: ReactNode }) {
  const { phase, problem } = useCrmData();
  if (phase === "loading") return <LoadingState />;
  if (phase === "unauthenticated") return <LoginForm />;
  if (phase === "unavailable") return <InfraNotice problem={problem} />;
  if (problem) return (<><InfraBanner /> {children}</>);
  return <>{children}</>;
}

const PROBLEMS: Record<string, { title: string; body: string }> = {
  not_configured: {
    title: "Tartós infrastruktúra összekötésre vár",
    body: "Nincs adatbázis megadva ehhez a környezethez (DATABASE_URL). A rendszer szándékosan nem tárol adatot böngészőben vagy memóriában. A beállítás lépései: docs/V0.6-PERSISTENCE.md.",
  },
  invalid_config: { title: "Hibás konfiguráció", body: "A környezeti beállítások nem érvényesek (JG_ENV / adatbázis). Az üzemeltetőnek kell javítania; adat nem érhető el." },
  environment_mismatch: { title: "Környezeti eltérés", body: "Az adatbázis környezete nem egyezik az alkalmazás környezetével (pl. előnézet és éles). A védelem miatt az adat nem érhető el." },
  schema_missing: { title: "Az adatbázis séma még nincs létrehozva", body: "Az üzemeltetőnek le kell futtatnia a migrációt (npm run db -- migrate). Az alkalmazás nem migrál automatikusan." },
  schema_outdated: { title: "Az adatbázis séma elavult", body: "Az üzemeltetőnek le kell futtatnia a migrációt (npm run db -- migrate). Az alkalmazás nem migrál automatikusan." },
  unreachable: { title: "Az adatbázis jelenleg nem érhető el", body: "Próbáld újra egy perc múlva. A korábban mentett adat nem veszett el." },
};
function InfraNotice({ problem }: { problem: string | null }) {
  const { refresh } = useCrmData();
  const [retrying, setRetrying] = useState(false);
  const retry = async () => {
    setRetrying(true);
    try { await refresh(); } finally { setRetrying(false); }
  };
  const p = PROBLEMS[problem ?? "unreachable"] ?? PROBLEMS.unreachable;
  return (
    <div role="alert" className="mx-auto max-w-xl rounded-lg bg-warn-soft p-5 text-sm text-ink ring-1 ring-warn/25" data-testid="infra-notice">
      <h1 className="text-lg font-semibold text-warn">{p.title}</h1>
      <p className="mt-2">{p.body}</p>
      <Button variant="secondary" className="mt-4" onClick={() => void retry()} disabled={retrying} aria-busy={retrying}>Újrapróbálás</Button>
    </div>
  );
}
function InfraBanner() {
  return <p role="alert" className="mb-4 rounded-md bg-warn-soft p-3 text-sm text-warn">Az adatbázis átmenetileg nem érhető el; a látható adat az utolsó sikeres frissítés állapota. A módosítások nem mentődnek, amíg a kapcsolat helyre nem áll.</p>;
}

function LoginForm() {
  const { login } = useCrmData();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError("");
    const r = await login(email, password);
    setBusy(false);
    if (!r.ok) {
      setError(r.error);
      setPassword("");
    }
  };
  return (
    <div className="mx-auto max-w-sm">
      <h1 className="text-2xl font-semibold tracking-tight">Bejelentkezés</h1>
      <p className="mt-1 text-sm text-ink-muted">A JG Investment OS csak engedélyezett felhasználóknak érhető el.</p>
      <form onSubmit={submit} noValidate className="mt-5 space-y-4">
        {error ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{error}</p> : null}
        <TextInput label="E-mail-cím" type="email" required autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} />
        <TextInput label="Jelszó" type="password" required autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} />
        <Button type="submit" disabled={busy} aria-busy={busy} className="w-full">Belépés</Button>
      </form>
    </div>
  );
}

/**
 * Régi, csak böngészőben (sessionStorage) tárolt demóadat felismerve. Automatikusan NEM kerül az adatbázisba és nem is törlődik.
 * Exportálható (JSON); adatbázisba csak külön, jóváhagyott és ellenőrzött művelettel importálható. A törlés explicit, megerősítést kérő döntés.
 */
function LegacyNotice() {
  const { legacy } = useCrmData();
  const [asked, setAsked] = useState(false);
  const download = (key: string, raw: string) => {
    const url = URL.createObjectURL(new Blob([raw], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${key}-export.json`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const total = legacy.items.reduce((n, i) => n + i.customers, 0);
  return (
    <div role="status" className="border-b border-line bg-info-soft" data-testid="legacy-notice">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 text-sm text-info sm:px-6">
        <p className="min-w-0 flex-1">
          Ebben a böngészőben korábbi, csak helyben tárolt demóadat található ({total} ügyfél). Az új rendszer adatbázisban dolgozik; ez az adat nem került át
          automatikusan, és nem is törlődött. Exportálhatod; adatbázisba csak külön, jóváhagyott lépéssel kerülhet.
        </p>
        {legacy.items.map((i) => (
          <button key={i.key} type="button" onClick={() => download(i.key, i.raw)} className="min-h-9 rounded-md px-2 font-medium underline underline-offset-2">Export (JSON): {i.key}</button>
        ))}
        {asked ? (
          <>
            <span>Biztosan törlöd a böngészőből? Előbb exportáld.</span>
            <button type="button" onClick={() => { legacy.discard(); setAsked(false); }} className="min-h-9 rounded-md px-2 font-semibold underline underline-offset-2">Végleges törlés</button>
            <button type="button" onClick={() => setAsked(false)} className="min-h-9 rounded-md px-2 font-medium underline underline-offset-2">Mégse</button>
          </>
        ) : (
          <button type="button" onClick={() => setAsked(true)} className="min-h-9 rounded-md px-2 font-medium underline underline-offset-2">Eltávolítás a böngészőből…</button>
        )}
      </div>
    </div>
  );
}

