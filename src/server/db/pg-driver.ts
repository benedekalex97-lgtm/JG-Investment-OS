import { Pool } from "pg";
import { APP_ROLE, type Db, type Tx } from "./types";

/** Éles/előnézeti meghajtó: bármely PostgreSQL (`DATABASE_URL`). Szerver nélküli környezetben kis kapcsolatkészlet. */
export function createPgDb(connectionString: string): Db {
  const pool = new Pool({ connectionString, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 8_000 });
  // Üresjárati kapcsolat hibája ne döntse le a folyamatot; a következő lekérdezés új kapcsolatot kér.
  pool.on("error", () => undefined);

  async function transaction<T>(setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    const tx: Tx = {
      query: async <R,>(sql: string, params?: unknown[]) => (await client.query(sql, params as unknown[] | undefined)).rows as R[],
      exec: async (sql) => void (await client.query(sql)),
    };
    try {
      await client.query("BEGIN");
      await setup(tx);
      const out = await fn(tx);
      await client.query("COMMIT");
      return out;
    } catch (e) {
      try {
        await client.query("ROLLBACK");
      } catch {
        /* a kapcsolat már megszakadt */
      }
      throw e;
    } finally {
      client.release();
    }
  }

  return {
    kind: "pg",
    system: (fn) => transaction(async () => undefined, fn),
    asUser: (userId, fn) =>
      transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      }, fn),
    close: () => pool.end(),
  };
}
