import { randomUUID } from "node:crypto";
import { Pool } from "pg";
import { createUser } from "@/server/auth/service";
import { createApi } from "@/server/http/api";
import { migrate } from "@/server/db/migrate";
import { createPgDb } from "@/server/db/pg-driver";
import { createPgliteDb } from "@/server/db/pglite-driver";
import type { Db } from "@/server/db/types";
import type { Runtime } from "@/server/db";

/**
 * Integrációs tesztek: alapértelmezésben PGlite (valódi PostgreSQL, memóriában / ideiglenes könyvtárban); ha a
 * JG_TEST_DATABASE_URL meg van adva (admin jogú kapcsolat egy VALÓDI, külön PostgreSQL szerverhez), ugyanezek a tesztek
 * azon is futnak, egy teszthez létrehozott, eldobható adatbázisban. Fiktív adat; éles adatbázis soha nem érintett.
 */
export const DRIVERS: ("pglite" | "pg")[] = process.env.JG_TEST_DATABASE_URL ? ["pglite", "pg"] : ["pglite"];

export interface TestDb { db: Db; kind: "pglite" | "pg"; cleanup(): Promise<void> }

export async function makeTestDb(kind: "pglite" | "pg", opts: { dir?: string; migrate?: boolean } = {}): Promise<TestDb> {
  if (kind === "pglite") {
    const db = await createPgliteDb(opts.dir);
    if (opts.migrate !== false) await migrate(db, { env: "local" });
    return { db, kind, cleanup: () => db.close() };
  }
  const admin = new Pool({ connectionString: process.env.JG_TEST_DATABASE_URL, max: 1 });
  const name = `jgt_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
  await admin.query(`create database ${name}`);
  const url = new URL(process.env.JG_TEST_DATABASE_URL as string);
  url.pathname = `/${name}`;
  const db = createPgDb(url.toString());
  if (opts.migrate !== false) await migrate(db, { env: "local" });
  return {
    db, kind,
    cleanup: async () => {
      await db.close();
      await admin.query(`drop database if exists ${name} with (force)`);
      await admin.end();
    },
  };
}

export const PASSWORD_A = "fiktiv-jelszo-A-12345";
export const PASSWORD_B = "fiktiv-jelszo-B-67890";

export async function addPilotUsers(db: Db) {
  const a = await createUser(db, { email: "pilot.egy@example.test", name: "Teszt Pilot Egy", password: PASSWORD_A });
  const b = await createUser(db, { email: "pilot.ketto@example.test", name: "Teszt Pilot Kettő", password: PASSWORD_B });
  return { a, b };
}

export function makeApi(db: Db, env: "local" | "preview" | "production" = "local", clock?: () => Date) {
  const rt: Runtime = { state: "ok", db, env };
  return createApi(async () => rt, clock);
}

const ORIGIN = "http://localhost:3000";
export interface Client {
  cookie: string;
  get(path: string): Promise<Response>;
  post(path: string, body?: unknown, headers?: Record<string, string>): Promise<Response>;
  login(email: string, password: string): Promise<Response>;
  op<T = unknown>(op: string, args: unknown, requestId?: string): Promise<{ status: number; body: { result: { ok: boolean; value?: T; errors?: Record<string, string> }; snapshot: import("@/domain/types").DataSnapshot; replayed: boolean } }>;
}
export function client(handle: (r: Request) => Promise<Response>): Client {
  const c: Client = {
    cookie: "",
    get: (path) => handle(new Request(`${ORIGIN}${path}`, { headers: c.cookie ? { cookie: c.cookie } : {} })),
    post: (path, body, headers = {}) =>
      handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "content-type": "application/json", origin: ORIGIN, ...(c.cookie ? { cookie: c.cookie } : {}), ...headers }, body: JSON.stringify(body ?? {}) })),
    async login(email, password) {
      const res = await c.post("/api/auth/login", { email, password });
      const set = res.headers.get("set-cookie");
      if (res.ok && set) c.cookie = set.split(";")[0];
      return res;
    },
    async op(op, args, requestId = randomUUID()) {
      const res = await c.post("/api/crm/op", { requestId, op, args });
      return { status: res.status, body: await res.json() };
    },
  };
  return c;
}
