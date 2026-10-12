"use client";

import Link from "next/link";
import { DataGate, TaskRow } from "@/components/common";
import { Card, CardHeader, EmptyState, LinkButton, PageHeader } from "@/components/ui/primitives";
import { overdueTasks, tasksDueToday } from "@/domain/logic";

/** Minimális áttekintés (v0.5): mai feladatok, lejárt feladatok, ügyfelek száma. Nincs részletes riport. */
export default function OverviewPage() {
  return (
    <>
      <PageHeader title="Áttekintés" description="A mai teendők és az ügyfelek száma. A részletek az ügyféladatlapokon érhetők el." />
      <DataGate>
        {(data) => {
          if (data.customers.length === 0) {
            return (
              <Card>
                <EmptyState title="Még nincs rögzített ügyfél." hint="Az áttekintés az első ügyfél és feladat rögzítése után jelenik meg." action={<LinkButton href="/customers/new">+ Első ügyfél hozzáadása</LinkButton>} />
              </Card>
            );
          }
          const now = new Date();
          const today = tasksDueToday(data, now);
          const overdue = overdueTasks(data, now);
          return (
            <div className="space-y-6">
              <ul className="grid grid-cols-3 gap-3">
                {[
                  { label: "Mai feladatok", value: today.length, href: "#mai-feladatok" },
                  { label: "Lejárt feladatok", value: overdue.length, href: "#lejart-feladatok" },
                  { label: "Ügyfelek", value: data.customers.length, href: "/customers" },
                ].map((s) => (
                  <li key={s.label}>
                    <Link href={s.href} className="block h-full rounded-lg bg-surface p-4 ring-1 ring-line transition-colors hover:bg-accent-soft">
                      <span className="block text-3xl font-semibold tabular-nums">{s.value}</span>
                      <span className="mt-1 block text-[13px] text-ink-muted">{s.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>
              <div className="grid gap-6 lg:grid-cols-2">
                <Card id="mai-feladatok">
                  <CardHeader title="Mai feladatok" count={today.length} />
                  {today.length ? <ul className="divide-y divide-line">{today.map((t) => <TaskRow key={t.id} task={t} data={data} showCustomer showStatus />)}</ul> : <EmptyState title="Ma nincs esedékes feladat" />}
                </Card>
                <Card id="lejart-feladatok">
                  <CardHeader title="Lejárt feladatok" count={overdue.length} />
                  {overdue.length ? <ul className="divide-y divide-line">{overdue.map((t) => <TaskRow key={t.id} task={t} data={data} showCustomer showStatus />)}</ul> : <EmptyState title="Nincs lejárt feladat" />}
                </Card>
              </div>
            </div>
          );
        }}
      </DataGate>
    </>
  );
}
