"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import { SNAPSHOT_VERSION, type DataSnapshot } from "@/domain/types";
import { DEMO_USERS } from "@/domain/constants";
import { DemoRepository, type DataRepository } from "./repository";
import { createSeedData } from "./seed";

/**
 * DEMÓ adat-store. A módosítások a böngészőfül sessionStorage-ában élnek:
 * oldalfrissítést túlélnek, de a fül bezárásakor elvesznek. Ez NEM éles
 * adatmegőrzés, nincs szerveroldali mentés vagy jogosultság-érvényesítés.
 */
const STORAGE_KEY = "jg-os-demo-v0.2";
/** A v0.1 adatmodell tárolókulcsa: a v0.2 NEM írja felül és NEM törli automatikusan (nincs csendes adatvesztés). */
const LEGACY_KEY = "jg-os-demo-v0.1";
const USER_KEY = "jg-os-demo-user";

type Listener = () => void;

class DemoStore {
  private repo: DataRepository | null = null;
  private listeners = new Set<Listener>();

  private ensure(): DataRepository {
    if (!this.repo) {
      let initial: DataSnapshot | null = null;
      try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (raw) {
          const parsed = JSON.parse(raw) as DataSnapshot;
          if (parsed.version === SNAPSHOT_VERSION) initial = parsed;
        }
      } catch {
        initial = null;
      }
      this.repo = new DemoRepository(initial ?? createSeedData());
    }
    return this.repo;
  }

  subscribe = (l: Listener) => {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  };
  getSnapshot = (): DataSnapshot | null => (typeof window === "undefined" ? null : this.ensure().getSnapshot());
  getServerSnapshot = (): DataSnapshot | null => null;

  repository(): DataRepository {
    return this.ensure();
  }
  /** Mutáció után hívandó: perzisztál (munkamenet) és értesít. */
  notify() {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(this.ensure().getSnapshot()));
    } catch {
      /* a sessionStorage nem elérhető - a demó memóriában tovább működik */
    }
    this.listeners.forEach((l) => l());
  }
  getLegacySnapshot = (): boolean => {
    try {
      return window.sessionStorage.getItem(LEGACY_KEY) !== null;
    } catch {
      return false;
    }
  };
  exportLegacy(): string | null {
    try {
      return window.sessionStorage.getItem(LEGACY_KEY);
    } catch {
      return null;
    }
  }
  /** Csak kifejezett felhasználói döntésre hívandó. */
  discardLegacy() {
    try {
      window.sessionStorage.removeItem(LEGACY_KEY);
    } catch {
      /* ignore */
    }
    this.listeners.forEach((l) => l());
  }
  currentUser(): string {
    try {
      const id = window.sessionStorage.getItem(USER_KEY);
      if (id && DEMO_USERS.some((u) => u.id === id)) return id;
    } catch {
      /* ignore */
    }
    return DEMO_USERS[0].id;
  }
  setCurrentUser(id: string) {
    try {
      window.sessionStorage.setItem(USER_KEY, id);
    } catch {
      /* ignore */
    }
    this.listeners.forEach((l) => l());
  }
  reset() {
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch {
      /* ignore */
    }
    this.repo = null;
    this.listeners.forEach((l) => l());
  }
}

const store = new DemoStore();

interface Ctx {
  /** null = még nem töltődött be (betöltési állapot). */
  data: DataSnapshot | null;
  /** Írási műveletek után a store automatikusan értesít és perzisztál (munkamenet). */
  repo: DataRepository;
  reset: () => void;
  /** Az aktuális (fiktív) felhasználó: a naplózott műveletek rögzítője. */
  currentUserId: string;
  setCurrentUserId: (id: string) => void;
  legacy: { present: boolean; exportJson: () => string | null; discard: () => void };
}
const StoreContext = createContext<Ctx | null>(null);

/** A repository műveleteit becsomagolja: minden hívás után perzisztál és értesít. */
function notifying(raw: DataRepository): DataRepository {
  return new Proxy(raw, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== "function") return v;
      if (prop === "getSnapshot") return v.bind(target);
      return (...args: unknown[]) => {
        const res = (v as (...a: unknown[]) => unknown).apply(target, args);
        store.notify();
        return res;
      };
    },
  });
}

export function DemoDataProvider({ children }: { children: ReactNode }) {
  const data = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getServerSnapshot);
  const legacyPresent = useSyncExternalStore(store.subscribe, store.getLegacySnapshot, () => false);
  const currentUserId = useSyncExternalStore(store.subscribe, () => (typeof window === "undefined" ? DEMO_USERS[0].id : store.currentUser()), () => DEMO_USERS[0].id);
  const value = useMemo<Ctx>(
    () => ({
      data,
      repo: notifying(data ? store.repository() : ({} as DataRepository)),
      reset: () => store.reset(),
      currentUserId,
      setCurrentUserId: (id) => store.setCurrentUser(id),
      legacy: { present: legacyPresent, exportJson: () => store.exportLegacy(), discard: () => store.discardLegacy() },
    }),
    [data, currentUserId, legacyPresent],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useDemoData(): Ctx {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useDemoData csak DemoDataProvideren belül használható");
  return ctx;
}
