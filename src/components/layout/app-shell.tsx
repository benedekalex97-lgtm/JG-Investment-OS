"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useState, type FormEvent, type ReactNode } from "react";
import { useCrmData } from "@/data/store";
import { TextInput } from "@/components/ui/form";
import { Button, LoadingState } from "@/components/ui/primitives";
import { cn } from "@/lib/cn";
import { GlobalSearch } from "./global-search";
import { hasAnySettingsAccess, SlidersIcon } from "@/components/settings/nav";

export const NAV = [
  { href: "/", label: "Áttekintés" },
  { href: "/pipeline", label: "Pipeline" },
  { href: "/customers", label: "Ügyfelek" },
] as const;

/**
 * v1.1: a Beállítások menüpont (benne a v1.0 Adatkezelés) csak valamely CRM-jogosultsággal látszik; a szerver minden kérésnél külön is
 * ellenőriz. A korábbi /data útvonalak a /settings/data alá irányítanak.
 */
export const SETTINGS_NAV = { href: "/settings", label: "Beállítások" } as const;
const useNav = () => {
  const { permissions } = useCrmData();
  return hasAnySettingsAccess(permissions) ? [...NAV, SETTINGS_NAV] : [...NAV];
};

const isActive = (path: string, href: string) => (href === "/" ? path === "/" : path === href || path.startsWith(`${href}/`));

function NavLinks({ path, orientation }: { path: string; orientation: "vertical" | "horizontal" }) {
  const nav = useNav();
  return (
    <ul className={cn("flex gap-1", orientation === "vertical" ? "flex-col" : "flex-row")}>
      {nav.map((n) => {
        const active = isActive(path, n.href);
        return (
          <li key={n.href} className={orientation === "horizontal" ? "flex-1" : undefined}>
            <Link
              href={n.href}
              aria-current={active ? "page" : undefined}
              className={cn(
                "flex min-h-11 items-center rounded-md px-3 text-sm font-medium transition-colors",
                orientation === "horizontal" && "justify-center px-1 text-center text-[13px] sm:px-3 sm:text-sm",
                active ? "bg-on-carbon/10 text-on-carbon" : "text-on-carbon-muted hover:bg-on-carbon/5 hover:text-on-carbon",
              )}
            >
              {n.href === SETTINGS_NAV.href ? <SlidersIcon className="mr-2 hidden shrink-0 sm:block" /> : null}
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
      <span className="block text-xs text-on-carbon-muted">v1.1</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { phase, user, logout, environmentLabel, legacy } = useCrmData();
  const current = [...NAV, SETTINGS_NAV].find((n) => isActive(path, n.href))?.label ?? "";
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
          <p className="px-3 text-xs leading-relaxed text-on-carbon-muted">Belső ügyfélkapcsolati rendszer.</p>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobil fejléc: három elemű navigáció, mindig látható */}
        <div className="sticky top-0 z-30 bg-carbon lg:hidden">
          {/* Mobilon/tableten a globális kereső a ragadós felső sávban: mindig elérhető, nem takarja ki semmi. */}
          <div className="relative flex min-h-14 items-center gap-2 px-3 py-1.5">
            <Brand />
            {ready ? <GlobalSearch compact className="flex-1" /> : null}
          </div>
          {ready ? (
            <nav aria-label="Fő navigáció (mobil)" className="border-t border-on-carbon/10 p-2">
              <NavLinks path={path} orientation="horizontal" />
            </nav>
          ) : null}
        </div>

        {/* Fejléc: oldaljelző + globális ügyfélkereső (csak bejelentkezve) + környezet + felhasználó */}
        <header className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-x-4 gap-y-2 px-4 py-2 sm:px-6">
            <p className="text-sm text-ink-muted">{ready ? <>Aktuális oldal: <span className="font-medium text-ink">{current}</span></> : "JG Investment OS"}</p>
            {ready ? <GlobalSearch className="hidden max-w-md flex-1 lg:block" /> : null}
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
        </header>

        {legacy.items.length ? <LegacyNotice /> : null}

        <main id="main" tabIndex={-1} className="mx-auto max-w-6xl px-4 py-6 focus:outline-none sm:px-6">
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
  auth_not_configured: { title: "A Google-belépés beállítása hiányzik", body: "A Google OAuth-kapcsolat még nincs beállítva. Az ügyféladatokhoz nem lehet hozzáférni." },
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
  const { login, authMode, googleConfigured } = useCrmData();
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
  if (authMode === "google") {
    const code = typeof window === "undefined" ? null : new URLSearchParams(window.location.search).get("login_error");
    const messages: Record<string, string> = {
      not_allowed: "Ez a Google-fiók nem rendelkezik CRM-hozzáféréssel. Válaszd az engedélyezett munkahelyi fiókodat.",
      expired: "A bejelentkezés lejárt. Indítsd újra a Google-belépést.",
      cancelled: "A Google-belépést megszakítottad. Újra próbálkozhatsz.",
      failed: "A Google-belépés nem sikerült. Próbáld újra.",
    };
    return (
      <div className="mx-auto max-w-sm space-y-5">
        <div><h1 className="text-2xl font-semibold tracking-tight">Bejelentkezés</h1>
        <p className="mt-2 text-sm text-ink-muted">Lépj be az engedélyezett Google-fiókoddal a JG Investment CRM-be.</p></div>
        {code && messages[code] ? <p role="alert" className="rounded-md bg-danger-soft p-3 text-sm text-danger">{messages[code]}</p> : null}
        {googleConfigured ? (
          <form action="/api/auth/google" method="get"><button type="submit" className="flex min-h-12 w-full items-center justify-center gap-3 rounded-md border border-line-strong bg-white px-5 py-3 text-sm font-medium text-[#1f1f1f] hover:bg-surface-muted">
            <svg aria-hidden="true" width="20" height="20" viewBox="0 0 48 48"><path fill="#EA4335" d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5Z"/><path fill="#4285F4" d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65Z"/><path fill="#FBBC05" d="M10.53 28.59A14.41 14.41 0 0 1 9.75 24c0-1.59.27-3.13.76-4.59l-7.98-6.19A23.87 23.87 0 0 0 0 24c0 3.87.93 7.53 2.56 10.78l7.97-6.19Z"/><path fill="#34A853" d="M24 48c6.48 0 11.93-2.13 15.91-5.8l-7.73-6c-2.15 1.45-4.92 2.3-8.18 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48Z"/></svg>
            Sign in with Google
          </button></form>
        ) : <p role="alert" className="rounded-md bg-warn-soft p-3 text-sm text-warn">A Google-belépés beállítása még nincs kész. Az üzemeltetőnek be kell állítania a Google OAuth-kapcsolatot.</p>}
        <p className="text-xs text-ink-muted">Csak előzetesen engedélyezett fiókkal érhetők el az ügyféladatok.</p>
      </div>
    );
  }
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

