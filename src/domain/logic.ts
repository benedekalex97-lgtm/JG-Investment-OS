import { CRM_STATUSES, CRM_STATUS_LABELS, DEFAULT_CRM_STATUS, RESTRICTION_LABELS, TASK_INPUT_LABELS, TASK_OUTCOME_LABELS, TASK_OUTPUT_LABELS } from "./constants";
import type {
  Activity, CompanyContact, Contactability, ContactChannel, ContactPurpose, CrmStatus, Customer, CustomerProcess, DataSnapshot, Task, TaskOutput,
} from "./types";
import { addDays, dayKey } from "./time";
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

// ------------------------------------------------------- Normalizálás (CRM-012 / CRM-013 közös)
/** E-mail összevetéshez: szóközök levágása, kisbetű. */
export const normalizeEmail = (s: string) => s.trim().toLowerCase();

/**
 * Telefonszám-kulcs: csak a számjegyek (szóköz, kötőjel, zárójel, perjel, pont és + nélkül). A magyar belföldi „06” és a nemzetközi
 * „0036” előhívó a „+36”-tal egyenértékű - a „06” csak teljes hosszúságú (10-11 számjegyű) belföldi számnál, hogy rövid vagy más
 * formátumú számok ne váljanak tévesen azonossá.
 */
export function phoneKey(s: string): string {
  const d = s.replace(/\D/g, "");
  if (d.startsWith("0036")) return `36${d.slice(4)}`;
  if (d.startsWith("06") && (d.length === 10 || d.length === 11)) return `36${d.slice(2)}`;
  return d;
}

/** Telefonszám-keresésnek számít, ha a kifejezés csak számjegyből és formázó jelből áll, legalább 4 számjeggyel. */
const phoneQuery = (raw: string): string[] => {
  if (!/^[\d\s()+/.-]+$/.test(raw)) return [];
  const digits = raw.replace(/\D/g, "");
  if (digits.length < 4) return [];
  const out = new Set([digits, phoneKey(raw)]);
  if (digits.startsWith("06")) out.add(`36${digits.slice(2)}`);
  if (digits.startsWith("0036")) out.add(`36${digits.slice(4)}`);
  return [...out];
};
const phoneHit = (stored: string | undefined, candidates: string[]) => {
  if (!stored || !candidates.length) return false;
  const raw = stored.replace(/\D/g, "");
  const key = phoneKey(stored);
  return candidates.some((c) => raw.includes(c) || key.includes(c));
};

export interface SearchMatch { field: "name" | "contact" | "phone" | "email" | "contactPhone" | "contactEmail"; label: string; value: string }
export interface CustomerHit { customer: Customer; matches: SearchMatch[] }

/**
 * Egy ügyfél egyezései a keresőkifejezésre (CRM-012): név / cégnév, a cég kapcsolattartójának neve, az ügyfél és a cég kapcsolattartóinak
 * telefonszáma (formázástól függetlenül) és e-mail-címe (kisbetű-független, részleges is). Üres lista = nincs egyezés.
 */
export function customerMatches(snap: DataSnapshot, c: Customer, query: string): SearchMatch[] {
  const raw = query.trim();
  const q = fold(raw);
  if (!q) return [];
  const phones = phoneQuery(raw);
  // E-mailre legalább 3 karakteres (vagy @-ot tartalmazó) kifejezés keres, hogy egy-két betű ne adjon zajos találatot.
  const email = raw.length >= 3 || raw.includes("@") ? normalizeEmail(raw) : "";
  const emailHit = (v?: string) => Boolean(email && v && normalizeEmail(v).includes(email));
  const out: SearchMatch[] = [];
  const name = customerName(c);
  if (fold(name).includes(q) || (c.type === "individual" && fold(`${c.firstName} ${c.lastName}`).includes(q))) out.push({ field: "name", label: c.type === "company" ? "Cégnév" : "Név", value: name });
  if (phoneHit(c.phone, phones)) out.push({ field: "phone", label: "Telefonszám", value: c.phone as string });
  if (emailHit(c.email)) out.push({ field: "email", label: "E-mail", value: c.email as string });
  if (c.type === "company") {
    for (const k of snap.contacts.filter((x) => x.companyId === c.id)) {
      if (contactMatches(k, q)) out.push({ field: "contact", label: "Kapcsolati személy", value: contactName(k) });
      if (phoneHit(k.phone, phones)) out.push({ field: "contactPhone", label: `Kapcsolattartó telefonszáma (${contactName(k)})`, value: k.phone as string });
      if (emailHit(k.email)) out.push({ field: "contactEmail", label: `Kapcsolattartó e-mail-címe (${contactName(k)})`, value: k.email as string });
    }
  }
  return out;
}

/** Globális kereső találatai: ügyfelenként pontosan egy találat, az egyezések okával, név szerint rendezve. */
export function searchCustomerHits(snap: DataSnapshot, query: string): CustomerHit[] {
  return snap.customers
    .map((customer) => ({ customer, matches: customerMatches(snap, customer, query) }))
    .filter((h) => h.matches.length > 0)
    .sort((a, b) => customerName(a.customer).localeCompare(customerName(b.customer), "hu"));
}

/** Ügyfélkeresés (szűrőkkel): név, cégnév, kapcsolati személy, valamint (v0.9) telefonszám és e-mail - az ügyfélé és a cég kapcsolattartóié. */
export function searchCustomers(snap: DataSnapshot, f: CustomerFilter = {}): Customer[] {
  const query = (f.query ?? "").trim();
  return snap.customers.filter((c) => {
    if (f.type && c.type !== f.type) return false;
    if (f.crmStatus && statusOf(c) !== f.crmStatus) return false;
    if (!query) return true;
    return customerMatches(snap, c, query).length > 0;
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
/** Lejárt: nyitott, a határidő napja (budapesti idő) korábbi a mai napnál. */
export const isOverdue = (t: Task, now: Date) => isOpenTask(t) && t.dueAt !== undefined && dayKey(t.dueAt) < dayKey(now);

/** Mai feladatok: nyitott, a budapesti mai napra esedékes határidejű feladatok (a határidő nélküliek nem). */
export function tasksDueToday(snap: DataSnapshot, now: Date): Task[] {
  const today = dayKey(now);
  return snap.tasks.filter((t) => isOpenTask(t) && t.dueAt !== undefined && dayKey(t.dueAt) === today);
}
export function overdueTasks(snap: DataSnapshot, now: Date): Task[] {
  return snap.tasks.filter((t) => isOverdue(t, now));
}

/** A napi feladatlista (CRM-010) szűrői. */
export const DAILY_FILTERS = [
  { key: "overdue", label: "Lejárt" },
  { key: "today", label: "Ma esedékes" },
  { key: "next7", label: "Következő 7 nap" },
  { key: "nodue", label: "Határidő nélkül" },
] as const;
export type DailyFilter = (typeof DAILY_FILTERS)[number]["key"];

/**
 * Napi feladatlista (CRM-010): a nyitott feladatok budapesti nap szerint csoportosítva. `assigneeId` megadásakor csak az adott
 * munkatárs feladatai (a meglévő `assigneeId` alapján; nincs kitalált hozzárendelés). Lezárt feladat egyik csoportba sem kerül.
 * Rendezés: lejárt és közelgő - a legkorábbi határidő elöl; mai - határidő szerint; határidő nélkül - felvételi idő, majd azonosító.
 */
export function dailyTasks(snap: DataSnapshot, now: Date, assigneeId?: string): Record<DailyFilter, Task[]> {
  const today = dayKey(now);
  const week = addDays(today, 7);
  const open = snap.tasks.filter((t) => isOpenTask(t) && (assigneeId === undefined || t.assigneeId === assigneeId));
  const byDue = (a: Task, b: Task) => dueTime(a) - dueTime(b) || Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  const byCreated = (a: Task, b: Task) => Date.parse(a.createdAt) - Date.parse(b.createdAt) || a.id.localeCompare(b.id);
  const key = (t: Task) => dayKey(t.dueAt as string);
  return {
    overdue: open.filter((t) => t.dueAt !== undefined && key(t) < today).sort(byDue),
    today: open.filter((t) => t.dueAt !== undefined && key(t) === today).sort(byDue),
    next7: open.filter((t) => t.dueAt !== undefined && key(t) > today && key(t) <= week).sort(byDue),
    nodue: open.filter((t) => t.dueAt === undefined).sort(byCreated),
  };
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

// ------------------------------------------------------- Gyorsműveletek (CRM-011)
export interface QuickChannel {
  /** A megjelenített érték (ügyfél saját adata, cégnél az elsődleges kapcsolattartóé, ha az ügyfélnél nincs). */
  value?: string;
  /** Szabványos hivatkozás (tel: / mailto:), csak ha van adat és nincs korlátozás. */
  href?: string;
  /** Ha a művelet nem indítható: érthető magyar indok. */
  blockedReason?: string;
}

/** tel: hivatkozás: csak a vezető + jel és a számjegyek maradnak (a formázás nem része az URI-nak). */
export const telHref = (phone: string) => `tel:${phone.trim().startsWith("+") ? "+" : ""}${phone.replace(/\D/g, "")}`;
/** mailto: hivatkozás: a cím URI-biztosan kódolva (a ?, & és # nem válhat fejléc-paraméterré). */
export const mailtoHref = (email: string) => `mailto:${encodeURI(email.trim()).replace(/\?/g, "%3F").replace(/&/g, "%26").replace(/#/g, "%23")}`;

/**
 * A „Hívás” és „E-mail” gyorsművelet állapota. A meglévő szabályokat nem kerüli meg: rögzített tiltakozás/korlátozás mellett kimenő
 * megkeresés nem indítható, és a csatornára rögzített „Tiltott” megkereshetőség (bármely célra) is blokkol. A hivatkozás csak a külső
 * alkalmazást nyitja meg; a CRM ebből nem naplóz kapcsolatfelvételt.
 */
export function quickActions(snap: DataSnapshot, c: Customer): { call: QuickChannel; email: QuickChannel } {
  const primary = c.type === "company" ? primaryContactOf(snap, c.id) : undefined;
  const restriction = c.restriction ? `${RESTRICTION_LABELS[c.restriction.kind]} van rögzítve: kimenő megkeresés nem indítható.` : undefined;
  const prohibited = (channel: ContactChannel) =>
    snap.contactability.some((r) => r.channel === channel && r.status === "prohibited" && (r.customerId === c.id || (primary && r.companyContactId === primary.id)));
  const build = (value: string | undefined, channel: ContactChannel, missing: string, href: (v: string) => string): QuickChannel => {
    if (!value) return { blockedReason: missing };
    if (restriction) return { value, blockedReason: restriction };
    if (prohibited(channel)) return { value, blockedReason: `A(z) ${channel === "phone" ? "telefonos" : "e-mailes"} megkeresés tiltottként van rögzítve.` };
    return { value, href: href(value) };
  };
  return {
    call: build(c.phone ?? primary?.phone, "phone", "Nincs megadva telefonszám.", telHref),
    email: build(c.email ?? primary?.email, "email", "Nincs megadva e-mail-cím.", mailtoHref),
  };
}
