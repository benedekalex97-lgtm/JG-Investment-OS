import { FOLLOW_UP_STALE_DAYS } from "./constants";
import type {
  Activity, Case, CompanyContact, Contactability, ContactChannel, ContactPurpose, Customer,
  DataSnapshot, LifecycleStatus, Task, TaskStatus,
} from "./types";

export function customerName(c: Customer): string {
  return c.type === "person" ? c.displayName : c.companyName;
}

export function contactName(c: CompanyContact): string {
  return `${c.lastName} ${c.firstName}`;
}

export function buildDisplayName(firstName: string, lastName: string): string {
  return `${lastName} ${firstName}`.trim();
}

/** Normalizálás kereséshez: kisbetű + ékezetek eltávolítása. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

export interface CustomerFilter {
  query?: string;
  type?: "person" | "company" | "";
  status?: LifecycleStatus | "";
  ownerId?: string;
}

/**
 * Ügyfélkeresés: név, cégnév ÉS a céges kapcsolattartók neve alapján is.
 * A kapcsolattartó találata a kapcsolódó CÉGET adja vissza (nem külön ügyfelet).
 */
export function searchCustomers(snap: DataSnapshot, f: CustomerFilter = {}): Customer[] {
  const q = fold((f.query ?? "").trim());
  return snap.customers.filter((c) => {
    if (f.type && c.type !== f.type) return false;
    if (f.status && c.lifecycleStatus !== f.status) return false;
    if (f.ownerId && c.ownerId !== f.ownerId) return false;
    if (!q) return true;
    if (fold(customerName(c)).includes(q)) return true;
    if (c.type === "person" && fold(`${c.firstName} ${c.lastName}`).includes(q)) return true;
    if (c.type === "company") {
      return snap.contacts.some(
        (k) => k.companyId === c.id && (fold(`${k.firstName} ${k.lastName}`).includes(q) || fold(contactName(k)).includes(q)),
      );
    }
    return false;
  });
}

/** Mely kapcsolattartó(k) neve találta meg a céget (a lista jelzéséhez). */
export function matchingContacts(snap: DataSnapshot, companyId: string, query: string): CompanyContact[] {
  const q = fold(query.trim());
  if (!q) return [];
  return snap.contacts.filter(
    (k) => k.companyId === companyId && (fold(`${k.firstName} ${k.lastName}`).includes(q) || fold(contactName(k)).includes(q)),
  );
}

export interface RelationRefs {
  customerId: string;
  caseId?: string;
  companyContactId?: string;
}

/**
 * Kapcsolati konzisztencia (ügy / tevékenység / feladat):
 * - az ügyfélnek léteznie kell;
 * - kapcsolattartó csak CÉGES ügyfélnél adható meg, és ugyanahhoz a céghez kell tartoznia;
 * - az ügynek ugyanahhoz az ügyfélhez kell tartoznia.
 * Hibaüzenetet ad vissza, vagy null-t, ha érvényes.
 */
export function validateRelations(snap: DataSnapshot, refs: RelationRefs): string | null {
  const customer = snap.customers.find((c) => c.id === refs.customerId);
  if (!customer) return "A megadott ügyfél nem létezik.";
  if (refs.companyContactId) {
    if (customer.type === "person") return "Magánszemély ügyfélhez nem rendelhető céges kapcsolattartó.";
    const contact = snap.contacts.find((k) => k.id === refs.companyContactId);
    if (!contact) return "A megadott kapcsolattartó nem létezik.";
    if (contact.companyId !== customer.id) return "A kapcsolattartó nem ehhez a céghez tartozik.";
  }
  if (refs.caseId) {
    const c = snap.cases.find((x) => x.id === refs.caseId);
    if (!c) return "A megadott ügy nem létezik.";
    if (c.customerId !== customer.id) return "Az ügy nem ehhez az ügyfélhez tartozik.";
  }
  return null;
}

/** Feladatállapot-váltás; a completedAt csak „elvégzett” állapotban van beállítva. */
export function applyTaskStatus(task: Task, status: TaskStatus, now: Date): Task {
  return {
    ...task,
    status,
    completedAt: status === "done" ? (task.completedAt ?? now.toISOString()) : undefined,
  };
}

/** Megkereshetőség lekérdezése; ha nincs rekord, az alapértelmezés: unknown. */
export function getContactability(
  snap: DataSnapshot,
  target: { customerId?: string; companyContactId?: string },
  purpose: ContactPurpose,
  channel: ContactChannel,
): Contactability {
  const found = snap.contactability.find(
    (r) =>
      r.purpose === purpose && r.channel === channel &&
      (target.customerId ? r.customerId === target.customerId : r.companyContactId === target.companyContactId),
  );
  return (
    found ?? {
      id: "",
      customerId: target.customerId,
      companyContactId: target.companyContactId,
      purpose, channel, status: "unknown", evidenceStatus: "none",
    }
  );
}

// ---------------------------------------------------------------- Dashboard

export function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}
export function endOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
}

export const isOpenTask = (t: Task) => t.status !== "done";
export const isOpenCase = (c: Case) => c.closureStatus === "open";

export function tasksDueToday(snap: DataSnapshot, now: Date): Task[] {
  const s = startOfDay(now).getTime(), e = endOfDay(now).getTime();
  return snap.tasks.filter((t) => isOpenTask(t) && Date.parse(t.dueAt) >= s && Date.parse(t.dueAt) < e);
}

export function overdueTasks(snap: DataSnapshot, now: Date): Task[] {
  const s = startOfDay(now).getTime();
  return snap.tasks.filter((t) => isOpenTask(t) && Date.parse(t.dueAt) < s);
}

/** Közelgő határidők: nyitott feladatok és ügyek következő lépései a következő `days` napban (a mai nap után). */
export function upcomingDeadlines(snap: DataSnapshot, now: Date, days = 7) {
  const from = endOfDay(now).getTime();
  const to = from + days * 86_400_000;
  const items: { kind: "task" | "case"; id: string; customerId: string; label: string; at: string }[] = [];
  for (const t of snap.tasks) {
    const at = Date.parse(t.dueAt);
    if (isOpenTask(t) && at >= from && at < to) items.push({ kind: "task", id: t.id, customerId: t.customerId, label: t.title, at: t.dueAt });
  }
  for (const c of snap.cases) {
    if (!isOpenCase(c) || !c.nextActionDueAt) continue;
    const at = Date.parse(c.nextActionDueAt);
    if (at >= from && at < to) items.push({ kind: "case", id: c.id, customerId: c.customerId, label: c.nextAction ?? c.title, at: c.nextActionDueAt });
  }
  return items.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/**
 * Utánkövetést igénylő ügyfelek: nem archivált ügyfél, akinek van nyitott ügye,
 * de az utolsó tevékenysége FOLLOW_UP_STALE_DAYS napnál régebbi (vagy nincs), és nincs nyitott feladata.
 */
export function customersNeedingFollowUp(snap: DataSnapshot, now: Date): Customer[] {
  const limit = now.getTime() - FOLLOW_UP_STALE_DAYS * 86_400_000;
  return snap.customers.filter((c) => {
    if (c.lifecycleStatus === "archived") return false;
    if (!snap.cases.some((k) => k.customerId === c.id && isOpenCase(k))) return false;
    if (snap.tasks.some((t) => t.customerId === c.id && isOpenTask(t))) return false;
    const last = Math.max(0, ...snap.activities.filter((a) => a.customerId === c.id).map((a) => Date.parse(a.occurredAt)));
    return last < limit;
  });
}

export function recentActivities(snap: DataSnapshot, limit = 8): Activity[] {
  return [...snap.activities].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt)).slice(0, limit);
}
