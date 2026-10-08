"use client";

import Link from "next/link";
import { ActivityLine, CustomerLink, DataGate, TaskLine, userName } from "@/components/common";
import { Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { customersNeedingFollowUp, isOpenCase, overdueTasks, recentActivities, tasksDueToday, upcomingDeadlines } from "@/domain/logic";
import { CASE_STAGE_LABELS } from "@/domain/constants";
import { formatDateTime } from "@/lib/format";

export default function DashboardPage() {
  return (
    <>
      <PageHeader title="Áttekintés" description="A közös csapatnézet összefoglalója fiktív demóadatokból." />
      <DataGate>
        {(data) => {
          const now = new Date();
          const today = tasksDueToday(data, now);
          const overdue = overdueTasks(data, now);
          const followUp = customersNeedingFollowUp(data, now);
          const openCases = data.cases.filter(isOpenCase);
          const upcoming = upcomingDeadlines(data, now);
          const recent = recentActivities(data);
          const stats = [
            { label: "Mai feladatok", value: today.length, href: "/tasks?view=today" },
            { label: "Lejárt feladatok", value: overdue.length, href: "/tasks?view=overdue" },
            { label: "Utánkövetést igénylő ügyfelek", value: followUp.length, href: "#utankovetes" },
            { label: "Nyitott ügyek", value: openCases.length, href: "/cases?closure=open" },
          ];
          return (
            <div className="space-y-6">
              <ul className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {stats.map((s) => (
                  <li key={s.label}>
                    <Link href={s.href} className="block rounded-lg bg-surface p-4 ring-1 ring-line transition-colors hover:bg-accent-soft">
                      <span className="block text-3xl font-semibold tabular-nums">{s.value}</span>
                      <span className="mt-1 block text-[13px] text-ink-muted">{s.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>

              <div className="grid gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Mai feladatok" count={today.length} action={<Link className="text-sm text-accent underline" href="/tasks?view=today">Összes</Link>} />
                  {today.length ? <ul className="divide-y divide-line">{today.map((t) => <TaskLine key={t.id} task={t} data={data} />)}</ul> : <EmptyState title="Ma nincs esedékes feladat" />}
                </Card>
                <Card>
                  <CardHeader title="Lejárt feladatok" count={overdue.length} action={<Link className="text-sm text-accent underline" href="/tasks?view=overdue">Összes</Link>} />
                  {overdue.length ? <ul className="divide-y divide-line">{overdue.map((t) => <TaskLine key={t.id} task={t} data={data} />)}</ul> : <EmptyState title="Nincs lejárt feladat" />}
                </Card>
                <Card id="utankovetes">
                  <CardHeader title="Utánkövetést igénylő ügyfelek" count={followUp.length} />
                  <p className="px-4 pt-3 text-[13px] text-ink-muted">Nyitott üggyel rendelkező ügyfelek, akiknek nincs nyitott feladata és az utolsó tevékenység régi vagy hiányzik.</p>
                  {followUp.length ? (
                    <ul className="divide-y divide-line">
                      {followUp.map((c) => (
                        <li key={c.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-sm">
                          <CustomerLink customer={c} />
                          <span className="text-[13px] text-ink-muted">Felelős: {userName(c.ownerId)}</span>
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState title="Nincs utánkövetést igénylő ügyfél" />}
                </Card>
                <Card>
                  <CardHeader title="Nyitott ügyek" count={openCases.length} action={<Link className="text-sm text-accent underline" href="/cases?closure=open">Összes</Link>} />
                  {openCases.length ? (
                    <ul className="divide-y divide-line">
                      {openCases.slice(0, 6).map((c) => (
                        <li key={c.id} className="px-4 py-3 text-sm">
                          <Link href={`/cases/${c.id}`} className="break-words font-medium text-accent hover:underline">{c.title}</Link>
                          <p className="text-[13px] text-ink-muted">{CASE_STAGE_LABELS[c.stage]} · <CustomerLink id={c.customerId} data={data} /></p>
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState title="Nincs nyitott ügy" />}
                </Card>
                <Card>
                  <CardHeader title="Közelgő határidők (7 nap)" count={upcoming.length} />
                  {upcoming.length ? (
                    <ul className="divide-y divide-line">
                      {upcoming.map((u) => (
                        <li key={`${u.kind}-${u.id}`} className="px-4 py-3 text-sm">
                          <Link href={u.kind === "task" ? "/tasks" : `/cases/${u.id}`} className="break-words font-medium text-accent hover:underline">{u.label}</Link>
                          <p className="text-[13px] text-ink-muted">{u.kind === "task" ? "Feladat" : "Ügy következő lépése"} · {formatDateTime(u.at)} · <CustomerLink id={u.customerId} data={data} /></p>
                        </li>
                      ))}
                    </ul>
                  ) : <EmptyState title="Nincs közelgő határidő" />}
                </Card>
                <Card>
                  <CardHeader title="Közös csapattevékenységek" action={<Link className="text-sm text-accent underline" href="/activities">Összes</Link>} />
                  {recent.length ? <ul className="divide-y divide-line">{recent.map((a) => <ActivityLine key={a.id} activity={a} data={data} />)}</ul> : <EmptyState title="Még nincs rögzített tevékenység" />}
                </Card>
              </div>
            </div>
          );
        }}
      </DataGate>
    </>
  );
}
