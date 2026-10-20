"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import type { DataSnapshot } from "@/domain/types";
import { loadSnapshot } from "./persistence";
import { RemoteRepository } from "./remote";

/**
 * CRM adat-store (v0.6): az adat az adatbázisban él, a böngésző csak megjeleníti. A munkamenetet a szerver kezeli (HttpOnly süti);
 * a kliens sehol nem tárol üzleti adatot (sem localStorage, sem sessionStorage) - a régi böngészős demóadatot csak felismeri és
 * exportálhatóvá teszi, automatikusan nem importálja és nem törli.
 */
export interface PublicUser { id: string; name: string }
export interface SessionUser extends PublicUser { email: string }
/** `loading`: induló lekérdezés; `ready`: bejelentkezve; `unauthenticated`: belépés szükséges; `unavailable`: az adatbázis/konfiguráció nem rendelkezésre álló. */
export type Phase = "loading" | "ready" | "unauthenticated" | "unavailable";

/** Régi, csak böngészőben tárolt demóadat (v0.1 / v0.2-v0.5.x). */
const LEGACY_KEYS = ["jg-os-demo-v0.2", "jg-os-demo-v0.1"] as const;
export interface LegacyBrowserData { key: string; customers: number; raw: string }

const REFRESH_MS = 30_000;

interface Ctx {
  phase: Phase;
  /** Az `unavailable` állapot oka (szerver által jelzett kód), pl. not_configured. */
  problem: string | null;
  /** null = még nem töltődött be. */
  data: DataSnapshot | null;
  repo: RemoteRepository;
  user: SessionUser | null;
  users: PublicUser[];
  environmentLabel: string;
  authMode: "password" | "google";
  googleConfigured: boolean;
  /** Szerveroldali funkciókapcsolók (csak tájékoztató; a szerver minden műveletnél újra ellenőriz). */
  features: { testCustomerDelete: boolean; customerImport: boolean };
  /** v1.0: a bejelentkezett felhasználó adatmozgatási jogai (csak a navigációhoz; a szerver minden kérésnél frissen ellenőriz). */
  permissions: string[];
  /** A bejelentkezett felhasználó azonosítója (a naplózott műveletek rögzítője - a szerver állítja be). */
  currentUserId: string;
  login: (email: string, password: string) => Promise<{ ok: true } | { ok: false; error: string }>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
  legacy: { items: LegacyBrowserData[]; discard: () => void };
}
const StoreContext = createContext<Ctx | null>(null);

const MSG = {
  invalid: "Hibás e-mail-cím vagy jelszó.",
  locked: "Túl sok sikertelen próba. Várj 15 percet, majd próbáld újra.",
  network: "Nincs kapcsolat a szerverrel. Próbáld újra.",
  unavailable: "A rendszer jelenleg nem érhető el.",
  generic: "A belépés nem sikerült. Próbáld újra.",
} as const;

async function getJson(url: string): Promise<{ status: number; body: Record<string, unknown> }> {
  const res = await fetch(url, { credentials: "same-origin", cache: "no-store" });
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* nem JSON válasz */
  }
  return { status: res.status, body };
}

export function CrmDataProvider({ children }: { children: ReactNode }) {
  const [phase, setPhase] = useState<Phase>("loading");
  const [problem, setProblem] = useState<string | null>(null);
  const [data, setData] = useState<DataSnapshot | null>(null);
  const [user, setUser] = useState<SessionUser | null>(null);
  const [users, setUsers] = useState<PublicUser[]>([]);
  const [environmentLabel, setEnvironmentLabel] = useState("");
  const [authMode, setAuthMode] = useState<"password" | "google">("password");
  const [googleConfigured, setGoogleConfigured] = useState(false);
  const [features, setFeatures] = useState({ testCustomerDelete: false, customerImport: false });
  const [permissions, setPermissions] = useState<string[]>([]);
  const [legacyItems, setLegacyItems] = useState<LegacyBrowserData[]>([]);

  const [repo] = useState(
    () =>
      new RemoteRepository({
        onSnapshot: (s) => setData(s),
        onSession: (e) => {
          if (e === "unauthenticated") {
            setData(null);
            setUser(null);
            setPermissions([]);
            setPhase("unauthenticated");
          } else {
            setProblem("unreachable");
          }
        },
      }),
  );

  const loadSnapshotFromServer = useCallback(async (): Promise<boolean> => {
    try {
      const { status, body } = await getJson("/api/crm/snapshot");
      if (status === 200) {
        setData(body.snapshot as DataSnapshot);
        setUsers(body.users as PublicUser[]);
        setPhase("ready");
        setProblem(null);
        return true;
      }
      if (status === 401) {
        setData(null);
        setUser(null);
        setPermissions([]);
        setPhase("unauthenticated");
      } else {
        setProblem(String(body.state ?? "unreachable"));
        setPhase((current) => current === "ready" ? "ready" : "unavailable");
      }
    } catch {
      setProblem("unreachable");
      setPhase((current) => current === "ready" ? "ready" : "unavailable");
    }
    return false;
  }, []);

  const bootstrap = useCallback(async () => {
    try {
      const { status, body } = await getJson("/api/auth/me");
      if (status === 200) {
        setUser(body.user as SessionUser);
        setEnvironmentLabel(String(body.environmentLabel ?? ""));
        const auth = body.auth as { mode?: string; configured?: boolean } | undefined;
        setAuthMode(auth?.mode === "google" ? "google" : "password");
        setGoogleConfigured(auth?.configured === true);
        const f = body.features as { testCustomerDelete?: boolean; customerImport?: boolean } | undefined;
        setFeatures({ testCustomerDelete: f?.testCustomerDelete === true, customerImport: f?.customerImport === true });
        setPermissions(Array.isArray(body.permissions) ? (body.permissions as unknown[]).filter((x): x is string => typeof x === "string") : []);
        await loadSnapshotFromServer();
      } else if (status === 401) {
        const s = await getJson("/api/status");
        if (s.status !== 200) {
          setProblem(String(s.body.state ?? "unreachable"));
          setPhase("unavailable");
          return;
        }
        setEnvironmentLabel(String(s.body.environmentLabel ?? ""));
        const auth = s.body.auth as { mode?: string; configured?: boolean } | undefined;
        setAuthMode(auth?.mode === "google" ? "google" : "password");
        setGoogleConfigured(auth?.configured === true);
        setPhase("unauthenticated");
      } else {
        setProblem(String(body.state ?? "unreachable"));
        setPhase("unavailable");
      }
    } catch {
      setProblem("unreachable");
      setPhase("unavailable");
    }
  }, [loadSnapshotFromServer]);

  useEffect(() => {
    // Induló lekérdezés + a régi böngészős demóadat felismerése (csak olvasás).
    const t = setTimeout(() => {
      void bootstrap();
      const found: LegacyBrowserData[] = [];
      for (const key of LEGACY_KEYS) {
        try {
          const raw = window.sessionStorage.getItem(key);
          if (raw) found.push({ key, raw, customers: loadSnapshot(raw).customers.length });
        } catch {
          /* a sessionStorage nem elérhető */
        }
      }
      setLegacyItems(found);
    }, 0);
    return () => clearTimeout(t);
  }, [bootstrap]);

  // A két pilot felhasználó közös nézete: frissítés fókuszra és időközönként (nincs helyi gyorsítótár).
  useEffect(() => {
    if (phase !== "ready") return;
    const tick = () => {
      if (document.visibilityState === "visible") void loadSnapshotFromServer();
    };
    const id = setInterval(tick, REFRESH_MS);
    document.addEventListener("visibilitychange", tick);
    return () => {
      clearInterval(id);
      document.removeEventListener("visibilitychange", tick);
    };
  }, [phase, loadSnapshotFromServer]);

  const login = useCallback<Ctx["login"]>(async (email, password) => {
    try {
      const res = await fetch("/api/auth/login", {
        method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: JSON.stringify({ email, password }),
      });
      if (res.status === 401) return { ok: false, error: MSG.invalid };
      if (res.status === 429) return { ok: false, error: MSG.locked };
      if (res.status === 503) return { ok: false, error: MSG.unavailable };
      if (!res.ok) return { ok: false, error: MSG.generic };
      const body = (await res.json()) as { user: SessionUser; environmentLabel?: string };
      setUser(body.user);
      setEnvironmentLabel(body.environmentLabel ?? "");
      // A munkamenet adatai (funkciókapcsolók is) és a snapshot ugyanazon az úton töltődnek, mint oldalbetöltéskor.
      await bootstrap();
      return { ok: true };
    } catch {
      return { ok: false, error: MSG.network };
    }
  }, [bootstrap]);

  const logout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST", headers: { "content-type": "application/json" }, credentials: "same-origin", cache: "no-store", body: "{}" });
    } catch {
      /* a süti a szerveren lejár; a nézetet mindenképp lezárjuk */
    }
    setData(null);
    setUser(null);
    setFeatures({ testCustomerDelete: false, customerImport: false });
    setPermissions([]);
    setPhase("unauthenticated");
  }, []);

  const value: Ctx = {
    phase, problem, data, repo, user, users, environmentLabel, authMode, googleConfigured, features, permissions, currentUserId: user?.id ?? "", login, logout, refresh: bootstrap,
    legacy: {
      items: legacyItems,
      /** Csak kifejezett felhasználói döntésre hívandó: a régi, csak böngészőben tárolt adat törlése. */
      discard: () => {
        for (const k of LEGACY_KEYS) {
          try {
            window.sessionStorage.removeItem(k);
          } catch {
            /* ignore */
          }
        }
        setLegacyItems([]);
      },
    },
  };
  return <StoreContext.Provider value={value}>{children}</StoreContext.Provider>;
}

export function useCrmData(): Ctx {
  const ctx = useContext(StoreContext);
  if (!ctx) throw new Error("useCrmData csak CrmDataProvideren belül használható");
  return ctx;
}

