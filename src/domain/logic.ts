import type {
  Activity, CompanyContact, Contactability, ContactChannel, ContactPurpose, ContactStatus, Customer, CustomerProcess, DataSnapshot,
  ProcessStatus, ProcessType, Task,
} from "./types";
import { isActive } from "./workflow";

export function customerName(c: Customer): string {
  return c.type === "individual" ? c.displayName : c.companyName;
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

export const contactName = (c: CompanyContact) => `${c.lastName} ${c.firstName}`;
export const buildDisplayName = (firstName: string, lastName: string) => `${lastName} ${firstName}`.trim();

/** Normalizálás kereséshez: kisbetű + ékezetek eltávolítása. */
export function fold(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
}

// --------------------------------------------------------------- Lekérdezések
export const processesOf = (snap: DataSnapshot, customerId: string) => snap.processes.filter((p) => p.customerId === customerId);
export const activeProcessesOf = (snap: DataSnapshot, customerId: string) => processesOf(snap, customerId).filter(isActive);

export interface Scope { customerId?: string; processId?: string }

export function lastActivity(snap: DataSnapshot, scope: Scope): Activity | undefined {
  return snap.activities
    .filter((a) => (scope.processId ? a.processId === scope.processId : a.customerId === scope.customerId))
    .reduce<Activity | undefined>((best, a) => (!best || Date.parse(a.occurredAt) > Date.parse(best.occurredAt) ? a : best), undefined);
}

/** Következő teendő = a legkorábbi határidejű, nyitott feladat. */
export function nextTask(snap: DataSnapshot, scope: Scope): Task | undefined {
  return snap.tasks
    .filter((t) => t.status !== "done" && (scope.processId ? t.processId === scope.processId : t.customerId === scope.customerId))
    .reduce<Task | undefined>((best, t) => (!best || Date.parse(t.dueAt) < Date.parse(best.dueAt) ? t : best), undefined);
}

export interface CustomerFilter {
  query?: string;
  type?: "individual" | "company" | "";
  contactStatus?: ContactStatus | "";
  ownerId?: string;
  processType?: ProcessType | "";
  processStatus?: ProcessStatus | "";
}

const contactMatches = (k: CompanyContact, q: string) => fold(`${k.firstName} ${k.lastName}`).includes(q) || fold(contactName(k)).includes(q);

/**
 * Ügyfélkeresés: név, cégnév ÉS a céges kapcsolattartók neve alapján is (a céget adja vissza).
 * A folyamat-szűrők az ügyfél AKTÍV folyamataira vonatkoznak.
 */
export function searchCustomers(snap: DataSnapshot, f: CustomerFilter = {}): Customer[] {
  const q = fold((f.query ?? "").trim());
  return snap.customers.filter((c) => {
    if (f.type && c.type !== f.type) return false;
    if (f.contactStatus && c.contactStatus !== f.contactStatus) return false;
    if (f.ownerId && c.ownerId !== f.ownerId) return false;
    if (f.processType || f.processStatus) {
      const ok = activeProcessesOf(snap, c.id).some((p) => (!f.processType || p.type === f.processType) && (!f.processStatus || p.status === f.processStatus));
      if (!ok) return false;
    }
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

// ------------------------------------------------------------ Munkapult (Áttekintés)
export const startOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate());
export const endOfDay = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1);
export const isOpenTask = (t: Task) => t.status !== "done";

export function tasksDueToday(snap: DataSnapshot, now: Date): Task[] {
  const s = startOfDay(now).getTime(), e = endOfDay(now).getTime();
  return snap.tasks.filter((t) => isOpenTask(t) && Date.parse(t.dueAt) >= s && Date.parse(t.dueAt) < e);
}
export function overdueTasks(snap: DataSnapshot, now: Date): Task[] {
  const s = startOfDay(now).getTime();
  return snap.tasks.filter((t) => isOpenTask(t) && Date.parse(t.dueAt) < s);
}

const activeWith = (snap: DataSnapshot, pred: (p: CustomerProcess) => boolean) => snap.processes.filter((p) => isActive(p) && pred(p));

/** Új érdeklődések: aktív bejövő folyamatok, még meg nem kezdett kapcsolatfelvétellel. */
export const newInquiries = (snap: DataSnapshot) => activeWith(snap, (p) => p.status === "new_inquiry");
/** Következő kapcsolatfelvételek: aktív kimenő folyamatok, amelyek megkeresésre vagy kapcsolatfelvételre várnak. */
export const nextOutreach = (snap: DataSnapshot) => activeWith(snap, (p) => p.type === "outbound_outreach" && (p.status === "pending_outreach" || p.status === "contact_in_progress"));
export const activeProcessList = (snap: DataSnapshot) => activeWith(snap, () => true);
/** Számlanyitásra váró vagy folyamatban lévő folyamatok (szolgáltatói mérföldkő szimulált). */
export const accountOpeningQueue = (snap: DataSnapshot) => activeWith(snap, (p) => p.status === "account_prep" || p.status === "account_opening");
/** Megnyitott, de még nem finanszírozott számlák (szimulált számláló). */
export const unfundedAccounts = (snap: DataSnapshot) => activeWith(snap, (p) => p.status === "account_opened" || p.status === "awaiting_first_deposit");
