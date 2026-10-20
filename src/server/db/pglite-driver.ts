import { mkdirSync } from "node:fs";
import { APP_ROLE, type Db, type Tx } from "./types";

interface PgliteTx {
  query<R>(sql: string, params?: unknown[]): Promise<{ rows: R[] }>;
  exec(sql: string): Promise<unknown>;
}
interface PgliteInstance {
  transaction<T>(fn: (tx: PgliteTx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
  waitReady: Promise<void>;
}

/**
 * Helyi/teszt meghajtó: PGlite (valódi PostgreSQL, WASM), fájlrendszerben tartós (`dataDir`) vagy memóriában (`undefined`).
 * Kizárólag fejlesztéshez, tesztekhez és az E2E-hez; éles környezetben tiltott (lásd config.ts). Egyetlen folyamat nyithatja meg
 * ugyanazt a könyvtárat. A csomagot dinamikusan töltjük be, hogy az éles csomag ne tartalmazza.
 */
export async function createPgliteDb(dataDir?: string): Promise<Db> {
  const name = "@electric-sql/pglite";
  const mod = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ name)) as { PGlite: new (dir?: string) => PgliteInstance };
  if (dataDir) mkdirSync(dataDir, { recursive: true });
  const pg = new mod.PGlite(dataDir);
  await pg.waitReady;

  const wrap = (tx: PgliteTx): Tx => ({
    query: async <R,>(sql: string, params?: unknown[]) => (await tx.query<R>(sql, params)).rows,
    exec: async (sql) => void (await tx.exec(sql)),
  });

  return {
    kind: "pglite",
    system: (fn) => pg.transaction((tx) => fn(wrap(tx))),
    asUser: (userId, fn) =>
      pg.transaction(async (tx) => {
        const t = wrap(tx);
        await t.exec(`SET LOCAL ROLE ${APP_ROLE}`);
        await t.query("SELECT set_config('app.user_id', $1, true)", [userId]);
        return fn(t);
      }),
    close: () => pg.close(),
  };
}
