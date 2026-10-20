"use client";

import Link from "next/link";
import { useState } from "react";
import { DataGate } from "@/components/common";
import { TaskRow } from "@/components/tasks";
import { Card, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { useCrmData } from "@/data/store";
import { DAILY_FILTERS, dailyTasks, type DailyFilter } from "@/domain/logic";
import type { DataSnapshot } from "@/domain/types";
import { cn } from "@/lib/cn";

type Scope = "mine" | "team";

const EMPTY: Record<DailyFilter, string> = {
  overdue: "Nincs lejárt feladat.",
  today: "Mára nincs esedékes feladat.",
  next7: "A következő 7 napra nincs esedékes feladat.",
  nodue: "Nincs határidő nélküli nyitott feladat.",
};

const TOGGLE = "inline-flex min-h-11 items-center gap-2 rounded-md px-3 text-sm font-medium ring-1 transition-colors";

/**
 * Áttekintés (v0.9, CRM-010): a központi „Mai feladataim” lista - alapértelmezetten a bejelentkezett munkatárs nyitott feladatai
 * (assigneeId = user.id), budapesti nap szerint: Lejárt / Ma esedékes / Következő 7 nap / Határidő nélkül. A feladat a közös
 * feladatmodálban kezelhető (Output, Sikeres/Sikertelen, következő feladat), ügyféloldalra navigálás nélkül; mentés után a lista a friss
 * adatból újraszámolódik. A csapat összes feladata külön nézetként érhető el.
 */
function Overview({ data }: { data: DataSnapshot }) {
  const { currentUserId } = useCrmData();
  const [scope, setScope] = useState<Scope>("mine");
  const [picked, setPicked] = useState<DailyFilter | null>(null);
  const lists = dailyTasks(data, new Date(), scope === "mine" ? currentUserId : undefined);
  // Alapértelmezés: ha van lejárt feladat, azzal kezdünk, különben a maiakkal; a kézi választás ezt felülírja.
  const active: DailyFilter = picked ?? (lists.overdue.length ? "overdue" : "today");
  const shown = lists[active];
  const select = (f: DailyFilter) => {
    setPicked(f);
    document.getElementById("mai-feladataim")?.scrollIntoView({ block: "start", behavior: "smooth" });
  };

  return (
    <div className="space-y-6">
      <ul className="grid grid-cols-3 gap-3">
        {[
          { label: scope === "mine" ? "Lejárt feladataim" : "Lejárt (csapat)", value: lists.overdue.length, filter: "overdue" as const },
          { label: scope === "mine" ? "Mai feladataim" : "Mai (csapat)", value: lists.today.length, filter: "today" as const },
        ].map((s) => (
          <li key={s.filter}>
            <button type="button" onClick={() => select(s.filter)} className="block h-full w-full rounded-lg bg-surface p-4 text-left ring-1 ring-line transition-colors hover:bg-accent-soft">
              <span className="block text-3xl font-semibold tabular-nums">{s.value}</span>
              <span className="mt-1 block text-[13px] text-ink-muted">{s.label}</span>
            </button>
          </li>
        ))}
        <li>
          <Link href="/customers" className="block h-full rounded-lg bg-surface p-4 ring-1 ring-line transition-colors hover:bg-accent-soft">
            <span className="block text-3xl font-semibold tabular-nums">{data.customers.length}</span>
            <span className="mt-1 block text-[13px] text-ink-muted">Ügyfelek</span>
          </Link>
        </li>
      </ul>

      <Card id="mai-feladataim">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-line px-4 py-3">
          <h2 className="text-sm font-semibold text-ink">{scope === "mine" ? "Mai feladataim" : "A csapat feladatai"}</h2>
          <div role="group" aria-label="Kinek a feladatai" className="flex flex-wrap gap-2">
            {(["mine", "team"] as const).map((s) => (
              <button key={s} type="button" aria-pressed={scope === s} onClick={() => setScope(s)}
                className={cn(TOGGLE, "min-h-9 px-2.5 text-[13px]", scope === s ? "bg-accent text-on-accent ring-accent" : "bg-surface text-ink ring-line-strong hover:bg-surface-muted")}>
                {s === "mine" ? "Saját feladataim" : "Csapat összes feladata"}
              </button>
            ))}
          </div>
        </div>
        <div role="group" aria-label="Szűrés határidő szerint" className="flex flex-wrap gap-2 border-b border-line p-3">
          {DAILY_FILTERS.map((f) => (
            <button key={f.key} type="button" aria-pressed={active === f.key} onClick={() => setPicked(f.key)}
              className={cn(TOGGLE, active === f.key ? "bg-accent-soft text-accent ring-accent/40" : "bg-surface text-ink ring-line-strong hover:bg-surface-muted")}>
              {f.label}
              <span className={cn("rounded-full px-2 text-xs tabular-nums", f.key === "overdue" && lists.overdue.length ? "bg-danger-soft text-danger" : "bg-surface-muted text-ink-muted")}>{lists[f.key].length}</span>
            </button>
          ))}
        </div>
        <p className="sr-only" role="status" aria-live="polite">{`${DAILY_FILTERS.find((f) => f.key === active)?.label}: ${shown.length} feladat`}</p>
        {shown.length ? (
          <ul className="divide-y divide-line" aria-label={`${DAILY_FILTERS.find((f) => f.key === active)?.label} feladatok`}>
            {shown.map((t) => <TaskRow key={t.id} task={t} data={data} showCustomer showStatus />)}
          </ul>
        ) : (
          <EmptyState title={EMPTY[active]} hint={scope === "mine" ? "Csak a hozzád rendelt nyitott feladatok jelennek meg." : undefined} />
        )}
      </Card>
    </div>
  );
}

export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Áttekintés" description="A napi munka: a hozzád rendelt lejárt, mai és közelgő feladatok. A feladat innen megnyitható és lezárható." />
      <DataGate>
        {(data) =>
          data.customers.length === 0 ? (
            <Card>
              <EmptyState title="Még nincs rögzített ügyfél." hint="Az áttekintés az első ügyfél és feladat rögzítése után jelenik meg." action={<LinkButton href="/customers/new">+ Első ügyfél hozzáadása</LinkButton>} />
            </Card>
          ) : (
            <Overview data={data} />
          )
        }
      </DataGate>
    </>
  );
}
