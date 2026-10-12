import { emptySnapshot, type DataSnapshot } from "@/domain/types";
import type { Tx } from "../db/types";
import {
  activityFromRow, activityToRow, contactabilityFromRow, contactabilityToRow, contactFromRow, contactToRow, customerFromRow, customerToRow,
  processFromRow, processToRow, resultToRow, taskFromRow, taskToRow, type Row,
} from "./rows";

/** A teljes snapshot (customerId nélkül) vagy egyetlen ügyfél szelete. Mindig a hívó (RLS-es) tranzakciójában fut. */
export async function loadSnapshot(tx: Tx, customerId?: string): Promise<DataSnapshot> {
  const all = customerId === undefined;
  const p: unknown[] = all ? [] : [customerId];
  const where = (col: string) => (all ? "" : `where ${col} = $1`);
  // Sorban futtatjuk (egy tranzakció egy kapcsolaton); a szelet kicsi, a teljes snapshot a pilot méretében is gyors.
  const customers = await tx.query<Row>(`select * from customers ${where("id")} order by created_at desc, id desc`, p);
  const restrictions = await tx.query<Row>(`select * from customer_restrictions ${where("customer_id")}`, p);
  const contacts = await tx.query<Row>(`select * from company_contacts ${where("company_id")} order by created_at, id`, p);
  const processes = await tx.query<Row>(`select * from processes ${where("customer_id")} order by created_at desc, id desc`, p);
  const activities = await tx.query<Row>(`select * from activities ${where("customer_id")} order by occurred_at desc, id desc`, p);
  const tasks = await tx.query<Row>(`select * from tasks ${where("customer_id")} order by created_at desc, id desc`, p);
  const results = await tx.query<Row>(`select * from task_results ${all ? "" : "where task_id in (select id from tasks where customer_id = $1)"} order by task_id, seq`, p);
  const contactability = await tx.query<Row>(
    `select * from contactability ${all ? "" : "where customer_id = $1 or company_contact_id in (select id from company_contacts where company_id = $1)"} order by id`, p,
  );
  const restrictionOf = new Map(restrictions.map((r) => [String(r.customer_id), r]));
  const resultsOf = new Map<string, Row[]>();
  for (const r of results) {
    const k = String(r.task_id);
    resultsOf.set(k, [...(resultsOf.get(k) ?? []), r]);
  }
  return {
    ...emptySnapshot(),
    customers: customers.map((r) => customerFromRow(r, restrictionOf.get(String(r.id)))),
    contacts: contacts.map(contactFromRow),
    processes: processes.map(processFromRow),
    activities: activities.map(activityFromRow),
    tasks: tasks.map((r) => taskFromRow(r, resultsOf.get(String(r.id)))),
    contactability: contactability.map(contactabilityFromRow),
  };
}

export class InvariantError extends Error {}

const canon = (v: unknown): string =>
  JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x as object).sort(([a], [b]) => (a < b ? -1 : 1))) : x));

const JSONB = new Set(["meta"]);

/** Egy sor beszúrása vagy frissítése (a kulcsok kizárólag a rows.ts leképezéseiből jönnek, nem kliensből). */
async function upsert(tx: Tx, table: string, pk: string[], row: Row) {
  const cols = Object.keys(row);
  const vals = cols.map((c) => row[c]);
  const ph = cols.map((c, i) => (JSONB.has(c) ? `$${i + 1}::jsonb` : `$${i + 1}`)).join(", ");
  const upd = cols.filter((c) => !pk.includes(c)).map((c) => `${c} = excluded.${c}`).join(", ");
  await tx.query(`insert into ${table} (${cols.join(", ")}) values (${ph}) on conflict (${pk.join(", ")}) ${upd ? `do update set ${upd}` : "do nothing"}`, vals);
}

function changed<T extends { id: string }>(before: T[], after: T[]): { added: T[]; updated: T[] } {
  const prev = new Map(before.map((x) => [x.id, canon(x)]));
  const added: T[] = [];
  const updated: T[] = [];
  const next = new Set<string>();
  for (const x of after) {
    next.add(x.id);
    const old = prev.get(x.id);
    if (old === undefined) added.push(x);
    else if (old !== canon(x)) updated.push(x);
  }
  for (const id of prev.keys()) if (!next.has(id)) throw new InvariantError(`Rekord törlése nem engedett (${id}).`);
  return { added, updated };
}

/**
 * A művelet előtti és utáni szelet különbségének mentése. Csak beszúrás és frissítés: törlés soha (az invariáns hibát dob),
 * a naplók (aktivitás, feladat-eredmények) kizárólag hozzáfűzhetők, a tiltakozás/korlátozás nem módosítható és nem tűnhet el.
 */
export async function saveDiff(tx: Tx, before: DataSnapshot, after: DataSnapshot): Promise<{ customerIds: string[] }> {
  const customers = changed(before.customers, after.customers);
  const touched = new Set<string>();
  for (const c of [...customers.added, ...customers.updated]) {
    await upsert(tx, "customers", ["id"], customerToRow(c));
    touched.add(c.id);
  }
  // Tiltakozás/korlátozás: csak az első rögzítés engedett; meglévő nem változhat és nem tűnhet el.
  for (const c of after.customers) {
    const old = before.customers.find((x) => x.id === c.id);
    if (old?.restriction && canon(old.restriction) !== canon(c.restriction)) throw new InvariantError("A rögzített tiltakozás/korlátozás nem módosítható és nem törölhető a CRM felületről.");
    if (c.restriction && !old?.restriction) {
      await tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ($1,$2,$3,$4,$5)", [c.id, c.restriction.kind, c.restriction.note, c.restriction.recordedAt, c.restriction.recordedBy]);
    }
  }
  const contacts = changed(before.contacts, after.contacts);
  // Az elsődleges jelölés átkerülésekor előbb a nem elsődleges sorok íródnak (egyedi részleges index).
  for (const k of [...contacts.added, ...contacts.updated].sort((a, b) => Number(a.isPrimaryContact) - Number(b.isPrimaryContact))) {
    await upsert(tx, "company_contacts", ["id"], contactToRow(k));
    touched.add(k.companyId);
  }
  for (const pr of [...changed(before.processes, after.processes).added, ...changed(before.processes, after.processes).updated]) {
    await upsert(tx, "processes", ["id"], processToRow(pr));
    touched.add(pr.customerId);
  }
  const tasks = changed(before.tasks, after.tasks);
  for (const t of [...tasks.added, ...tasks.updated]) {
    await upsert(tx, "tasks", ["id"], taskToRow(t));
    touched.add(t.customerId);
    const old = before.tasks.find((x) => x.id === t.id)?.outputs ?? [];
    const now = t.outputs ?? [];
    if (now.length < old.length || old.some((o, i) => canon(o) !== canon(now[i]))) throw new InvariantError("A korábbi feladat-eredmények nem módosíthatók és nem törölhetők.");
    for (let i = old.length; i < now.length; i++) await upsert(tx, "task_results", ["task_id", "seq"], resultToRow(t.id, i, now[i]));
  }
  const acts = changed(before.activities, after.activities);
  if (acts.updated.length) throw new InvariantError("Az aktivitásnapló bejegyzései nem módosíthatók.");
  for (const a of acts.added) {
    await upsert(tx, "activities", ["id"], activityToRow(a));
    touched.add(a.customerId);
  }
  const cont = changed(before.contactability, after.contactability);
  for (const c of [...cont.added, ...cont.updated]) await upsert(tx, "contactability", ["id"], contactabilityToRow(c));
  return { customerIds: [...touched] };
}
