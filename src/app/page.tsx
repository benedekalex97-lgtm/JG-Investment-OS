"use client";

import Link from "next/link";
import { useState } from "react";
import { DataGate, TaskRow } from "@/components/common";
import { TaskFormModal } from "@/components/forms";
import { ProcessLine } from "@/components/process-line";
import { Button, Card, CardHeader, EmptyState, PageHeader } from "@/components/ui/primitives";
import { accountOpeningQueue, activeProcessList, newInquiries, nextOutreach, overdueTasks, tasksDueToday, unfundedAccounts } from "@/domain/logic";

export default function OverviewPage() {
  const [taskOpen, setTaskOpen] = useState(false);
  return (
    <>
      <PageHeader
        title="Áttekintés"
        description="Munkapult a közös csapatnézetben, fiktív demóadatokból. A folyamatok és feladatok részletei az ügyféladatlapokon érhetők el."
        actions={<Button onClick={() => setTaskOpen(true)}>Új feladat</Button>}
      />
      <DataGate>
        {(data) => {
          const now = new Date();
          const today = tasksDueToday(data, now);
          const overdue = overdueTasks(data, now);
          const inquiries = newInquiries(data);
          const outreach = nextOutreach(data);
          const active = activeProcessList(data);
          const opening = accountOpeningQueue(data);
          const unfunded = unfundedAccounts(data);
          const stats = [
            { label: "Mai feladatok", value: today.length, href: "#feladatok" },
            { label: "Lejárt feladatok", value: overdue.length, href: "#feladatok" },
            { label: "Új érdeklődések", value: inquiries.length, href: "#uj-erdeklodesek" },
            { label: "Aktív folyamatok", value: active.length, href: "#aktiv-folyamatok" },
            { label: "Számlanyitásra váró / folyamatban", value: opening.length, href: "#szamlanyitas" },
            { label: "Megnyitott, nem finanszírozott számla (szimulált)", value: unfunded.length, href: "#nem-finanszirozott" },
          ];
          const processCard = (id: string, title: string, list: typeof active, empty: string, hint?: string) => (
            <Card id={id}>
              <CardHeader title={title} count={list.length} />
              {hint ? <p className="px-4 pt-3 text-[13px] text-ink-muted">{hint}</p> : null}
              {list.length ? <ul className="divide-y divide-line">{list.map((p) => <ProcessLine key={p.id} process={p} data={data} />)}</ul> : <EmptyState title={empty} />}
            </Card>
          );
          return (
            <div className="space-y-6">
              <ul className="grid grid-cols-2 gap-3 lg:grid-cols-3">
                {stats.map((s) => (
                  <li key={s.label}>
                    <Link href={s.href} className="block h-full rounded-lg bg-surface p-4 ring-1 ring-line transition-colors hover:bg-accent-soft">
                      <span className="block text-3xl font-semibold tabular-nums">{s.value}</span>
                      <span className="mt-1 block text-[13px] text-ink-muted">{s.label}</span>
                    </Link>
                  </li>
                ))}
              </ul>

              <div id="feladatok" className="grid scroll-mt-4 gap-6 lg:grid-cols-2">
                <Card>
                  <CardHeader title="Mai feladatok" count={today.length} />
                  {today.length ? <ul className="divide-y divide-line">{today.map((t) => <TaskRow key={t.id} task={t} data={data} />)}</ul> : <EmptyState title="Ma nincs esedékes feladat" />}
                </Card>
                <Card>
                  <CardHeader title="Lejárt feladatok" count={overdue.length} />
                  {overdue.length ? <ul className="divide-y divide-line">{overdue.map((t) => <TaskRow key={t.id} task={t} data={data} />)}</ul> : <EmptyState title="Nincs lejárt feladat" />}
                </Card>
              </div>

              <div className="grid gap-6 lg:grid-cols-2">
                {processCard("uj-erdeklodesek", "Új érdeklődések", inquiries, "Nincs új, még nem kezelt érdeklődés", "Bejövő érdeklődések, amelyeknél a kapcsolatfelvétel még nem kezdődött meg.")}
                {processCard("kovetkezo-kapcsolatfelvetelek", "Következő kapcsolatfelvételek", outreach, "Nincs esedékes kapcsolatfelvétel", "Kimenő kapcsolatépítés: megkeresésre váró vagy folyamatban lévő folyamatok. Megkeresés előtt ellenőrizendő az adatforrás és a megkeresési jogalap.")}
                {processCard("aktiv-folyamatok", "Aktív folyamatok", active, "Nincs aktív folyamat")}
                {processCard("szamlanyitas", "Számlanyitásra váró vagy folyamatban lévő", opening, "Nincs ilyen folyamat", "A számlanyitás szolgáltatói folyamat; a CRM csak követi, nem végzi.")}
                {processCard("nem-finanszirozott", "Megnyitott, de még nem finanszírozott számlák (szimulált)", unfunded, "Nincs ilyen folyamat", "Szimulált számláló: nem valós egyenleg- vagy pénzmozgási adat.")}
              </div>
            </div>
          );
        }}
      </DataGate>
      <TaskFormModal open={taskOpen} onClose={() => setTaskOpen(false)} />
    </>
  );
}
