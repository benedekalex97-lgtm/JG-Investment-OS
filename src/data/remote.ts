import type { Result } from "./repository";
import type { Activity, CompanyContact, Customer, DataSnapshot, Task } from "@/domain/types";

/**
 * Kliensoldali repository (v0.6): minden írás a szerver API-ján át, az adatbázisba történik - nincs helyi tárolás és nincs csendes
 * tartalék. A válasz tartalmazza a mentés utáni, friss snapshotot. A kliens soha nem küld rögzítőt/felelőst: azt a szerver a
 * munkamenetből állítja be. A hálózati vagy szerverhiba egyértelmű, érthető hibaüzenettel tér vissza (az adat nem veszett el).
 */
export const MESSAGES = {
  network: "A mentés nem sikerült: nincs kapcsolat a szerverrel. Az adat nem került elmentésre, próbáld újra.",
  server: "A mentés nem sikerült: a szerver hibát jelzett. Az adat nem került elmentésre, próbáld újra; ha ismétlődik, jelezd az üzemeltetőnek.",
  unavailable: "A mentés nem sikerült: az adatbázis jelenleg nem érhető el. Az adat nem került elmentésre.",
  session: "A munkamenet lejárt, jelentkezz be újra. Az adat nem került elmentésre.",
  rejected: "A mentés nem sikerült: a kérés érvénytelen.",
} as const;

export type SessionEvent = "unauthenticated" | "unavailable";
export interface TransportHooks {
  onSnapshot(snapshot: DataSnapshot): void;
  onSession(event: SessionEvent): void;
}

type OpResponse = { result: Result<unknown>; snapshot: DataSnapshot; replayed: boolean };

const fail = <T>(msg: string): Result<T> => ({ ok: false, errors: { _form: msg } });

export class RemoteRepository {
  /** Ismeretlen kimenetelű (hálózati/szerverhiba) kérések azonosítói: ugyanaz a művelet újrapróbálva ugyanazt az azonosítót használja, így nem keletkezik duplikátum. */
  private pending = new Map<string, string>();

  constructor(private hooks: TransportHooks, private fetcher: typeof fetch = (...a) => fetch(...a), private uuid: () => string = () => crypto.randomUUID()) {}

  async call<T>(op: string, args: unknown): Promise<Result<T>> {
    const key = `${op}:${JSON.stringify(args)}`;
    const requestId = this.pending.get(key) ?? this.uuid();
    let res: Response;
    try {
      res = await this.fetcher("/api/crm/op", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store",
        body: JSON.stringify({ requestId, op, args }),
      });
    } catch {
      this.pending.set(key, requestId);
      return fail(MESSAGES.network);
    }
    if (res.status === 401) {
      this.pending.delete(key);
      this.hooks.onSession("unauthenticated");
      return fail(MESSAGES.session);
    }
    if (res.status === 503) {
      this.pending.set(key, requestId);
      this.hooks.onSession("unavailable");
      return fail(MESSAGES.unavailable);
    }
    if (res.status >= 500) {
      this.pending.set(key, requestId);
      return fail(MESSAGES.server);
    }
    this.pending.delete(key);
    if (!res.ok) return fail(MESSAGES.rejected);
    let body: OpResponse;
    try {
      body = (await res.json()) as OpResponse;
    } catch {
      return fail(MESSAGES.server);
    }
    this.hooks.onSnapshot(body.snapshot);
    return body.result as Result<T>;
  }

  createCustomerFromForm(input: unknown) {
    return this.call<{ customer: Customer; contact?: CompanyContact }>("customer.create", { input });
  }
  updateCustomer(id: string, input: unknown) {
    return this.call<Customer>("customer.update", { id, input });
  }
  changeCrmStatus(customerId: string, input: unknown) {
    return this.call<Customer>("customer.changeStatus", { customerId, input });
  }
  createNote(customerId: string, text: string) {
    return this.call<Activity>("note.create", { customerId, text });
  }
  createTask(input: unknown) {
    return this.call<Task>("task.create", { input });
  }
  closeTask(taskId: string, input: unknown) {
    return this.call<Task>("task.close", { taskId, input });
  }
  reopenTask(taskId: string) {
    return this.call<Task>("task.reopen", { taskId });
  }
  setTaskDue(taskId: string, dueAt: string | null) {
    return this.call<Task>("task.setDue", { taskId, dueAt });
  }
}

