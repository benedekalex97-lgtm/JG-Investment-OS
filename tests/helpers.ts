import { DemoRepository, type Result } from "@/data/repository";
import { createSeedData } from "@/data/seed";
import type { Customer, CustomerProcess, DataSnapshot } from "@/domain/types";
import { customerName } from "@/domain/logic";

export const NOW = new Date(2026, 9, 8, 12, 0, 0);
export const seed = () => createSeedData(NOW);
export const newRepo = (snap: DataSnapshot = seed()) => new DemoRepository(snap, { clock: () => NOW });

export function val<T>(r: Result<T>): T {
  if (!r.ok) throw new Error(JSON.stringify(r.errors));
  return r.value;
}
export const errs = <T,>(r: Result<T>) => (r.ok ? {} : r.errors);

export const byName = (snap: DataSnapshot, name: string): Customer => {
  const c = snap.customers.find((x) => customerName(x).startsWith(name));
  if (!c) throw new Error(`nincs ilyen ügyfél: ${name}`);
  return c;
};
export const processOf = (snap: DataSnapshot, customerId: string, titleStart: string): CustomerProcess => {
  const p = snap.processes.find((x) => x.customerId === customerId && x.title.startsWith(titleStart));
  if (!p) throw new Error(`nincs ilyen folyamat: ${titleStart}`);
  return p;
};

export const U = "user-1";
export const VERIFY = { sourceCategory: "provider_notification", complianceAcknowledged: true } as const;

/** Repository, amelynek órája másodpercenként lép: a létrehozási sorrend mérhető (az azonos ezredmásodperces rekordok sorrendje nem determinisztikus). */
export const tickRepo = (snap: DataSnapshot = seed()) => {
  let n = 0;
  return new DemoRepository(snap, { clock: () => new Date(NOW.getTime() + 1000 * n++) });
};

/** Feladat lezárása a kötelező Output-tal (a `setTaskStatus` már nem zárhat le). */
export const closeIt = (r: DemoRepository, id: string, outputKey = "completed", outputNote?: string) =>
  val(r.closeTask(id, { outputKey, ...(outputNote ? { outputNote } : {}), recordedBy: U }));
