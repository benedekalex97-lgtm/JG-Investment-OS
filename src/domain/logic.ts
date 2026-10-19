import { CRM_STATUSES, CRM_STATUS_LABELS, DEFAULT_CRM_STATUS, TASK_INPUT_LABELS, TASK_OUTCOME_LABELS, TASK_OUTPUT_LABELS } from "./constants";
import type {
  Activity, CompanyContact, Contactability, ContactChannel, ContactPurpose, CrmStatus, Customer, CustomerProcess, DataSnapshot, Task, TaskOutput,
} from "./types";
import { isActive } from "./workflow";

export function customerName(c: Customer): string {
  return c.type === "individual" ? c.displayName : c.companyName;
}
export const contactName = (c: CompanyContact) => `${c.lastName} ${c.firstName}`.trim();
export const buildDisplayName = (firstName: string, lastName: string) => `${lastName} ${firstName}`.trim();

/**
 * Egyetlen szabadszöveges névből vezeték- és keresztnév (a rekordmodell szétválasztott mezőit tölti):
 * az első szó a vezetéknév, a többi a keresztnév (magyar névsorrend). Egy szavas névnél a keresztnév üres.
 * Az összefűzés (`buildDisplayName`) visszaadja az eredeti, tisztított nevet.
 */
export function splitName(name: string): { lastName: string; firstName: string } {
  const tokens = name.trim().split(/\s+/).filter(Boolean);
  return { lastName: tokens[0] ?? "", firstName: tokens.slice(1).join(" ") };
}

/** Normalizálás kereséshez: kisbetű + ékezetek eltávolítása. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

/**
 * Az ügyfél aktuális kapcsolati státusza. A régebbi rekordokról hiányzó érték alapértelmezettnek számít (olvasáskor),
 * a tárolt adat ettől nem módosul, és a régi folyamatstátuszokra nincs kitalált megfeleltetés.
 */
export const statusOf = (c: Customer): CrmStatus => c.crmStatus ?? DEFAULT_CRM_STATUS;

// --------------------------------------------------------------- Lekérdezések
export const processesOf = (snap: DataSnapshot, customerId: string) => snap.processes.filter((p) => p.customerId === customerId);
export const activeProcessesOf = (snap: DataSnapshot, customerId: string): CustomerProcess[] => processesOf(snap, customerId).filter(isActive);

export interface Scope { customerId?: string; processId?: string }

export function lastActivity(snap: DataSnapshot, scope: Scope): Activity | undefined {
  return snap.activities
    .filter((a) => (scope.processId ? a.processId === scope.processId : a.customerId === scope.customerId))
    .reduce<Activity | undefined>((best, a) => (!best || Date.parse(a.occurredAt) > Date.parse(best.occurredAt) ? a : best), undefined);
}

export const isDone = (t: Task) => t.status === "done";
/** A feladat aktuális (legutolsó) Output-ja; a régi, Output nélkül elvégzett feladatnál undefined. */
export const latestOutput = (t: Task) => t.outputs?.[t.outputs.length - 1];

/** A lezárás minősítésének címkéje (Sikeres / Sikertelen); a régi, minősítés nélküli lezárásnál undefined (nincs kitalált érték). */
export const outcomeLabel = (o?: Pick<TaskOutput, "outcome">): string | undefined => (o?.outcome ? TASK_OUTCOME_LABELS[o.outcome] : undefined);

/**
 * Megjelenítendő Output-szöveg: v0.9-től a beírt szabad szöveg; a régi legördülős lezárásnál a választott érték címkéje (+ az „Egyéb” megjegyzése); a régi, szabad szöveges lezárás
 * változatlanul a rögzített szöveg. A listából később kivezetett kulcs magát a kulcsot mutatja (nincs adatvesztés).
 */
export function outputText(o: Pick<TaskOutput, "key" | "text">): string {
  if (!o.key) return o.text;
  const label = (TASK_OUTPUT_LABELS as Record<string, string>)[o.key] ?? o.key;
  return o.text ? `${label} — ${o.text}` : label;
}
/** Megjelenítendő Input: a választott érték (+ megjegyzés), különben a régi szabad szöveges leírás; egyébként üres szöveg. */
export function inputText(t: Pick<Task, "inputKey" | "inputNote" | "description">): string {
  if (!t.inputKey) return t.description ?? "";
  const label = (TASK_INPUT_LABELS as Record<string, string>)[t.inputKey] ?? t.inputKey;
  return t.inputNote ? `${label} — ${t.inputNote}` : label;
}
export const isOpenTask = (t: Task) => !isDone(t);
const dueTime = (t: Task) => (t.dueAt ? Date.parse(t.dueAt) : Number.POSITIVE_INFINITY);

/** Következő nyitott feladat: a legkorábbi határidejű; a határidő nélküliek a határidősök után, felvételi sorrendben. */
export function nextTask(snap: DataSnapshot, scope: Scope): Task | undefined {
  return snap.tasks
    .filter((t) => isOpenTask(t) && (scope.processId ? t.processId === scope.processId : t.customerId === scope.customerId))
    .sort((a, b) => dueTime(a) - dueTime(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id))[0];
}

export interface CustomerFilter {
  query?: string;
  type?: "individual" | "company" | "";
  crmStatus?: CrmStatus | "";
}

const contactMatches = (k: CompanyContact, q: string) => fold(`${k.firstName} ${k.lastName}`).includes(q) || fold(contactName(k)).includes(q);

/** Ügyfélkeresés: név, cégnév ÉS a cég kapcsolati személyének neve alapján is (a céget adja vissza). */
export function searchCustomers(snap: DataSnapshot, f: CustomerFilter = {}): Customer[] {
  const q = fold((f.query ?? "").trim());
  return snap.customers.filter((c) => {
    if (f.type && c.type !== f.type) return false;
    if (f.crmStatus && statusOf(c) !== f.crmStatus) return false;
    if (!q) return true;
    if (fold(customerName(c)).includes(q)) return true;
    if (c.type === "individual" && fold(`${c.firstName} ${c.lastName}`).includes(q)) return true;
    return c.type === "company" && snap.contacts.some((k) => k.companyId === c.id && contactMatches(k, q));
  });
}

export function matchingContacts(snap: DataSnapshot, companyId: string, query: string): CompanyContact[] {
  const q = fold(query.trim());
  return q ? snap.contacts.filter((k) => k.companyId === companyId && contactMatches(k, q)) : [];
}

/**
 * Az elsődleges kapcsolati személy - DETERMINISZTIKUSAN: az `isPrimaryContact` jelölésű (több jelölt esetén a legkorábban
 * felvett, azonos időnél az azonosító szerinti első); ha nincs jelölt, a legkorábban felvett kapcsolattartó; ha nincs, undefined.
 */
export function primaryContactOf(snap: DataSnapshot, companyId: string): CompanyContact | undefined {
  const list = snap.contacts.filter((k) => k.companyId === companyId);
  const order = (a: CompanyContact, b: CompanyContact) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  const flagged = list.filter((k) => k.isPrimaryContact).sort(order);
  return flagged[0] ?? [...list].sort(order)[0];
}
/** A cég további (nem elsődleges) kapcsolattartói - az adatok megőrzéséhez és megtekintéséhez. */
export function otherContactsOf(snap: DataSnapshot, companyId: string): CompanyContact[] {
  const primary = primaryContactOf(snap, companyId);
  return snap.contacts.filter((k) => k.companyId === companyId && k.id !== primary?.id).sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id));
}

export interface RelationRefs { customerId: string; processId?: string; companyContactId?: string }

/**
 * Kapcsolati konzisztencia (folyamat / aktivitás / feladat):
 * kapcsolattartó csak CÉGES ügyfélnél, ugyanahhoz a céghez; a folyamat ugyanahhoz az ügyfélhez tartozzon.
 */
export function validateRelations(snap: DataSnapshot, refs: RelationRefs): string | null {
  const customer = snap.customers.find((c) => c.id === refs.customerId);
  if (!customer) return "A megadott ügyfél nem létezik.";
  if (refs.companyContactId) {
    if (customer.type === "individual") return "Magánszemély ügyfélhez nem rendelhető céges kapcsolattartó.";
    const contact = snap.contacts.find((k) => k.id === refs.companyContactId);
    if (!contact) return "A megadott kapcsolattartó nem létezik.";
    if (contact.companyId !== customer.id) return "A kapcsolattartó nem ehhez a céghez tartozik.";
  }
  if (refs.processId) {
    const p = snap.processes.find((x) => x.id === refs.processId);
    if (!p) return "A megadott folyamat nem létezik.";
    if (p.customerId !== customer.id) return "A folyamat nem ehhez az ügyfélhez tartozik.";
  }
  return null;
}

export function getContactability(
  snap: DataSnapshot,
  target: { customerId?: string; companyContactId?: string },
  purpose: ContactPurpose,
  channel: ContactChannel,
): Contactability {
  const found = snap.contactability.find(
    (r) => r.purpose === purpose && r.channel === channel && (target.customerId ? r.customerId === target.customerId : r.companyContactId === target.companyContactId),
  );
  return found ?? { id: "", customerId: target.customerId, companyContactId: target.companyContactId, purpose, channel, status: "unknown", evidenceStatus: "none" };
}

// -------------------------------------------------------------------- Feladatok
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);

/** Mai feladatok: nyitott, mára esedékes határidejű feladatok (a határidő nélküliek nem). */
export function tasksDueToday(snap: DataSnapshot, now: Date): Task[] {
  const s = startOfDay(now).getTime(), e = endOfDay(now).getTime();
  return snap.tasks.filter((t) => isOpenTask(t) && t.dueAt !== undefined && Date.parse(t.dueAt) >= s && Date.parse(t.dueAt) < e);
}
export function overdueTasks(snap: DataSnapshot, now: Date): Task[] {
  const s = startOfDay(now).getTime();
  return snap.tasks.filter((t) => isOpenTask(t) && t.dueAt !== undefined && Date.parse(t.dueAt) < s);
}

const taskOrder = (a: Task, b: Task) =>
  Number(isDone(a)) - Number(isDone(b)) || dueTime(a) - dueTime(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);

export interface CustomerTasks {
  /** Az aktuális státuszhoz tartozó feladatok (nyitottak elöl). */
  current: Task[];
  /** Korábbi státuszok feladatai státusz szerint csoportosítva (a státuszok sorrendjében). */
  earlier: { status: CrmStatus; tasks: Task[] }[];
  /** Státuszhoz nem rendelt (régi) feladatok: nem kapnak kitalált státuszt, de nem vesznek el. */
  unassigned: Task[];
  /** A korábbi és státusz nélküli feladatok közül a még nyitottak száma (a napi munkából ne vesszenek ki). */
  openEarlier: number;
}

/**
 * Egy ügyfél feladatai az aktuális státusz szerint szétválasztva. A státuszváltás nem töröl, nem pipál ki és nem hoz létre feladatot:
 * a feladat a létrehozáskori státuszához tartozik, így váltás után "korábbi" lesz, de megmarad.
 */
export function tasksByStatus(snap: DataSnapshot, customer: Customer): CustomerTasks {
  const mine = snap.tasks.filter((t) => t.customerId === customer.id);
  const now = statusOf(customer);
  const current = mine.filter((t) => t.crmStatus === now).sort(taskOrder);
  const unassigned = mine.filter((t) => t.crmStatus === undefined).sort(taskOrder);
  const earlier = CRM_STATUSES.filter((s) => s !== now)
    .map((status) => ({ status, tasks: mine.filter((t) => t.crmStatus === status).sort(taskOrder) }))
    .filter((g) => g.tasks.length > 0);
  const openEarlier = [...unassigned, ...earlier.flatMap((g) => g.tasks)].filter(isOpenTask).length;
  return { current, earlier, unassigned, openEarlier };
}

// ------------------------------------------------------------------- Pipeline
export interface PipelineFilter { query?: string }

export interface PipelineColumn {
  status: CrmStatus;
  label: string;
  customers: Customer[];
}

/** A hét státusz oszlopai, minden ügyfél pontosan egy oszlopban (egy ügyfél = egy kártya), név szerint rendezve. */
export function crmPipeline(snap: DataSnapshot, f: PipelineFilter = {}): PipelineColumn[] {
  const matching = searchCustomers(snap, { query: f.query });
  return CRM_STATUSES.map((status) => ({
    status,
    label: CRM_STATUS_LABELS[status],
    customers: matching.filter((c) => statusOf(c) === status).sort((a, b) => customerName(a).localeCompare(customerName(b), "hu")),
  }));
}
