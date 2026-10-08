"use client";

import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from "react";
import type { DataSnapshot } from "@/domain/types";
import { DemoRepository, type DataRepository } from "./repository";
import { createSeedData } from "./seed";

/**
 * DEMÓ adat-store. A módosítások a böngészőfül sessionStorage-ában élnek:
 * oldalfrissítést túlélnek, de a fül bezárásakor elvesznek. Ez NEM éles
 * adatmegőrzés, nincs szerveroldali mentés vagy jogosultság-érvényesítés.
 */
const STORAGE_KEY = "jg-os-demo-v0.1";

type Listener = () => void;

class DemoStore {
  private repo: DataRepository | null = null;
  private listeners = new Set<Listener>();

  private ensure(): DataRepository {
    if (!this.repo) {
      let initial: DataSnapshot | null = null;
      try {
        const raw = window.sessionStorage.getItem(STORAGE_KEY);
        if (raw) initial = JSON.parse(raw) as DataSnapshot;
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
  const value = useMemo<Ctx>(
    () => ({ data, repo: notifying(data ? store.repository() : ({} as DataRepository)), reset: () => store.reset() }),
    [data],
  );
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useDemoData(): Ctx {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useDemoData csak DemoDataProvideren belül használható");
  return ctx;
}
