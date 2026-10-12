"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";
import { useDemoData } from "@/data/store";
import { DEMO_USERS } from "@/domain/constants";
import { Modal } from "@/components/ui/modal";
import { Button } from "@/components/ui/primitives";
import { useState } from "react";
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
      <span className="block text-xs text-on-carbon-muted">v0.5 · demó</span>
    </Link>
  );
}

export function AppShell({ children }: { children: ReactNode }) {
  const path = usePathname();
  const { reset, currentUserId, setCurrentUserId, legacy } = useDemoData();
  const current = NAV.find((n) => isActive(path, n.href))?.label ?? "";

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
            <nav aria-label="Fő navigáció"><NavLinks path={path} orientation="vertical" /></nav>
          </div>
          <p className="px-3 text-xs leading-relaxed text-on-carbon-muted">Csak demó. Nincs éles jogosultságkezelés, nem alkalmas valós ügyféladatok tárolására.</p>
        </div>
      </aside>

      <div className="min-w-0">
        {/* Mobil fejléc: két elemű navigáció, mindig látható */}
        <div className="sticky top-0 z-30 bg-carbon lg:hidden">
          <div className="flex min-h-14 items-center px-3"><Brand /></div>
          <nav aria-label="Fő navigáció (mobil)" className="border-t border-on-carbon/10 p-2">
            <NavLinks path={path} orientation="horizontal" />
          </nav>
        </div>

        {/* Fejléc: oldaljelző + demó figyelmeztetés */}
        <div className="border-b border-line bg-surface">
          <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2 sm:px-6">
            <p className="text-sm text-ink-muted">Aktuális oldal: <span className="font-medium text-ink">{current}</span></p>
            <p className="flex flex-wrap items-center gap-2 text-xs text-ink-muted">
              <span className="rounded-full bg-warn-soft px-2 py-0.5 font-medium text-warn">DEMÓ</span>
              <span>Ne rögzíts valós ügyféladatot · a módosítások csak a böngészőfül munkamenetéig élnek</span>
              <label className="flex items-center gap-1">
                Demófelhasználó:
                <select value={currentUserId} onChange={(e) => setCurrentUserId(e.target.value)} className="min-h-9 rounded-md bg-surface px-1 ring-1 ring-control">
                  {DEMO_USERS.map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
              <button type="button" onClick={() => { if (window.confirm("Az ÖSSZES ebben a böngészőfülben rögzített adat törlődik (a kézzel létrehozottak is), és üres CRM marad. A művelet nem vonható vissza. Folytatod?")) reset(); }} className="min-h-9 rounded-md px-2 font-medium text-accent underline underline-offset-2 hover:bg-accent-soft">
                Munkamenet törlése
              </button>
            </p>
          </div>
        </div>

        {legacy.present ? <LegacyNotice /> : null}
        <DemoDataNotice />

        <main id="main" className="mx-auto max-w-6xl px-4 py-6 sm:px-6">{children}</main>
      </div>
    </div>
  );
}

/** A v0.1 demóadat felismerve: nincs csendes adatvesztés, a felhasználó dönt. */
function LegacyNotice() {
  const { legacy } = useDemoData();
  const download = () => {
    const json = legacy.exportJson();
    if (!json) return;
    const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = "jg-os-demo-v0.1-export.json";
    a.click();
    URL.revokeObjectURL(url);
  };
  return (
    <div role="status" className="border-b border-line bg-info-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 text-sm text-info sm:px-6">
        <p className="min-w-0 flex-1">
          Ebben a böngészőfülben v0.1-es demóadat van. A v0.2 új adatmodellt használ, ezért új demóadattal indult; a régi adat érintetlen maradt.
        </p>
        <button type="button" onClick={download} className="min-h-9 rounded-md px-2 font-medium underline underline-offset-2">v0.1 adat exportja (JSON)</button>
        <button type="button" onClick={() => { if (window.confirm("Véglegesen törlöd a v0.1 demóadatot ebből a böngészőfülből?")) legacy.discard(); }} className="min-h-9 rounded-md px-2 font-medium underline underline-offset-2">Régi adat törlése</button>
      </div>
    </div>
  );
}

function download(filename: string, json: string) {
  const url = URL.createObjectURL(new Blob([json], { type: "application/json" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.click();
  URL.revokeObjectURL(url);
}

/**
 * Korábbi böngészőmunkamenetben maradt fiktív demóadat felismerve. Az eltávolítás kizárólag explicit,
 * megerősítést kérő művelet; csak ismert demó rekordokat érint, a kézzel létrehozottat soha.
 */
function DemoDataNotice() {
  const { demo } = useDemoData();
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState<string | null>(null);
  const removable = demo.plan.removable.length;
  const kept = demo.plan.kept.length;
  if (removable + kept === 0 && !report) return null;
  return (
    <div role="status" className="border-b border-line bg-warn-soft">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-4 py-3 text-sm text-ink sm:px-6">
        {report ? (
          <p className="min-w-0 flex-1">{report}</p>
        ) : (
          <p className="min-w-0 flex-1">
            Ebben a böngészőfülben korábbi, fiktív demóadat maradt ({removable + kept} ügyfél). Az új CRM üres indulású; a demóadat eltávolítása külön, megerősítést kérő művelet.
          </p>
        )}
        {removable + kept > 0 ? <Button size="sm" variant="secondary" onClick={() => setOpen(true)}>Demóadat eltávolítása…</Button> : null}
        {report ? <Button size="sm" variant="ghost" onClick={() => setReport(null)}>Bezár</Button> : null}
      </div>
      <Modal open={open} onClose={() => setOpen(false)} title="Demóadat eltávolítása">
        <div className="space-y-3 text-sm">
          <p><strong>Demó-tárolás korlátai:</strong> az adatok csak ebben a böngészőfülben élnek (sessionStorage), a fül bezárásakor elvesznek, nincs mentés vagy szerveroldali tárolás. A rendszer nem alkalmas valós ügyféladatok tárolására.</p>
          <p>Eltávolításra kerül: <strong>{removable}</strong> felismert fiktív demó ügyfél a hozzájuk tartozó kapcsolattartókkal, folyamatokkal, feladatokkal és aktivitásokkal.</p>
          {kept ? <p>Megmarad: <strong>{kept}</strong> demó azonosítójú ügyfél, mert kézzel létrehozott rekord (pl. folyamat, feladat, aktivitás) kapcsolódik hozzájuk.</p> : null}
          <p>A kézzel létrehozott, valamint az ismeretlen eredetű rekordok nem törlődnek. A törlés nem vonható vissza; előtte exportálhatod az adatokat.</p>
          <div className="flex flex-wrap justify-end gap-2 pt-2">
            <Button variant="secondary" onClick={() => download("jg-os-demo-v0.3-export.json", demo.exportJson())}>Exportálás (JSON)</Button>
            <Button variant="secondary" onClick={() => setOpen(false)}>Mégse</Button>
            <Button
              variant="danger"
              onClick={() => {
                const r = demo.remove();
                setOpen(false);
                setReport(`Demóadat eltávolítva: ${r.removedCustomers} ügyfél és ${r.removedRecords} kapcsolódó rekord. Megmaradt demó azonosítójú ügyfél (kézzel létrehozott rekorddal): ${r.keptCustomers}.`);
              }}
            >
              Demóadat eltávolítása
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
