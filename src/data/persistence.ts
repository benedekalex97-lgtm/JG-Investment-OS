import { emptySnapshot, SNAPSHOT_VERSION, type Customer, type DataSnapshot } from "@/domain/types";

/**
 * A sessionStorage-ból visszatöltött adat értelmezése (tiszta függvény, tesztelhető).
 * Új vagy olvashatatlan munkamenet ÜRES CRM-et ad - fiktív seed nem töltődik be automatikusan.
 * Más adatmodell-verziójú tartalmat nem írunk felül és nem alakítunk át: üres snapshotot adunk vissza,
 * a tárolt nyers érték a store szintjén érintetlen marad, amíg a felhasználó nem ír új adatot.
 */
export function loadSnapshot(raw: string | null): DataSnapshot {
  if (!raw) return emptySnapshot();
  try {
    const parsed = JSON.parse(raw) as Partial<DataSnapshot> | null;
    if (parsed && parsed.version === SNAPSHOT_VERSION && Array.isArray(parsed.customers)) return { ...emptySnapshot(), ...parsed } as DataSnapshot;
  } catch {
    /* hibás JSON -> üres */
  }
  return emptySnapshot();
}

/**
 * A fejlesztői seed determinisztikus, rövid numerikus azonosítókat használ (pl. `cust-12`);
 * a felhasználó által létrehozott rekordok véletlen azonosítót kapnak (`cust-k3j9x0ab`).
 * Ez az egyetlen jel, amellyel a korábbi böngészőmunkamenetekben maradt demóadat felismerhető.
 */
export const isSeedId = (id: string) => /^[a-z]+-\d{1,3}$/.test(id);

export interface DemoRemovalPlan {
  /** Törölhető demó ügyfelek (és minden hozzájuk tartozó, szintén demó rekord). */
  removable: Customer[];
  /** Demó azonosítójú ügyfelek, amelyekhez kézzel létrehozott rekord kapcsolódik: ezek megmaradnak. */
  kept: Customer[];
}

function relatedIds(snap: DataSnapshot, customerId: string): string[] {
  const contactIds = snap.contacts.filter((k) => k.companyId === customerId).map((k) => k.id);
  return [
    ...contactIds,
    ...snap.processes.filter((p) => p.customerId === customerId).map((p) => p.id),
    ...snap.tasks.filter((t) => t.customerId === customerId).map((t) => t.id),
    ...snap.activities.filter((a) => a.customerId === customerId).map((a) => a.id),
    ...snap.contactability.filter((c) => c.customerId === customerId || (c.companyContactId && contactIds.includes(c.companyContactId))).map((c) => c.id),
  ];
}

/** Mit törölne az explicit demóadat-eltávolítás? Csak ismert demó rekordokat; a kézzel létrehozottat sosem. */
export function planDemoRemoval(snap: DataSnapshot): DemoRemovalPlan {
  const demo = snap.customers.filter((c) => isSeedId(c.id));
  const removable: Customer[] = [];
  const kept: Customer[] = [];
  for (const c of demo) (relatedIds(snap, c.id).every(isSeedId) ? removable : kept).push(c);
  return { removable, kept };
}

export interface DemoRemovalResult {
  snapshot: DataSnapshot;
  removedCustomers: number;
  removedRecords: number;
  keptCustomers: number;
}

export function removeDemoRecords(snap: DataSnapshot): DemoRemovalResult {
  const { removable, kept } = planDemoRemoval(snap);
  const gone = new Set(removable.map((c) => c.id));
  const goneContacts = new Set(snap.contacts.filter((k) => gone.has(k.companyId)).map((k) => k.id));
  const next: DataSnapshot = {
    ...snap,
    customers: snap.customers.filter((c) => !gone.has(c.id)),
    contacts: snap.contacts.filter((k) => !gone.has(k.companyId)),
    processes: snap.processes.filter((p) => !gone.has(p.customerId)),
    tasks: snap.tasks.filter((t) => !gone.has(t.customerId)),
    activities: snap.activities.filter((a) => !gone.has(a.customerId)),
    contactability: snap.contactability.filter((c) => !(c.customerId && gone.has(c.customerId)) && !(c.companyContactId && goneContacts.has(c.companyContactId))),
  };
  const count = (s: DataSnapshot) => s.contacts.length + s.processes.length + s.tasks.length + s.activities.length + s.contactability.length;
  return { snapshot: next, removedCustomers: removable.length, removedRecords: count(snap) - count(next), keptCustomers: kept.length };
}
