import { Pool } from "pg";
import { isLocalHost } from "../config";
import { APP_ROLE, type Db, type Tx } from "./types";

/** Éles/előnézeti meghajtó: bármely PostgreSQL (`DATABASE_URL`). Szerver nélküli környezetben kis kapcsolatkészlet. */
export function createPgDb(connectionString: string): Db {
  const { url, ssl } = tlsSettings(connectionString);
  // Neon-szerű, hideg indulású (automatikusan felfüggesztett) számításhoz a kapcsolódási időtúllépés hosszabb; kis készlet a szerver nélküli futáshoz.
  const pool = new Pool({ connectionString: url, ssl, max: 3, idleTimeoutMillis: 10_000, connectionTimeoutMillis: 12_000 });
  // Üresjárati kapcsolat hibája ne döntse le a folyamatot; a következő lekérdezés új kapcsolatot kér.
  pool.on("error", () => undefined);

  async function transaction<T>(setup: (tx: Tx) => Promise<void>, fn: (tx: Tx) => Promise<T>): Promise<T> {
    const client = await connect(pool);
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
    tls: ssl !== false,
    system: (fn) => transaction(async () => undefined, fn),
    asUser: (userId, fn) =>
      transaction(async (tx) => {
        await tx.exec(`SET LOCAL ROLE ${APP_ROLE}`);
        await tx.query("SELECT set_config('app.user_id', $1, true)", [userId]);
      }, fn),
    close: () => pool.end(),
  };
}

/**
 * TLS: nem helyi hoszthoz mindig ellenőrzött tanúsítvány (`rejectUnauthorized: true`), függetlenül a `pg` verziójának `sslmode`-értelmezésétől
 * (a `pg` régebbi verziói a `require`-t `verify-full`-ként kezelik, később libpq-kompatibilisre változhat). Az `sslmode` paramétert ezért kivesszük az
 * URL-ből, és az `ssl` opciót mi adjuk meg. Helyi (loopback) szerverhez nincs TLS.
 */
export function tlsSettings(connectionString: string): { url: string; ssl: false | { rejectUnauthorized: true } } {
  let u: URL;
  try {
    u = new URL(connectionString);
  } catch {
    return { url: connectionString, ssl: false };
  }
  if (isLocalHost(u.hostname)) return { url: connectionString, ssl: false };
  u.searchParams.delete("sslmode");
  return { url: u.toString(), ssl: { rejectUnauthorized: true } };
}

const RETRYABLE = new Set(["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "EAI_AGAIN", "57P01", "57P03", "08006", "08001"]);

/** Egyetlen újrapróbálás a KAPCSOLÓDÁSNÁL (még nincs kiadott utasítás, ezért biztonságos): Neon hideg indítás, rövid hálózati hiba. */
async function connect(pool: Pool) {
  try {
    return await pool.connect();
  } catch (e) {
    const code = (e as { code?: string }).code;
    const timedOut = /timeout/i.test((e as Error).message ?? "");
    if (!(code && RETRYABLE.has(code)) && !timedOut) throw e;
    await new Promise((r) => setTimeout(r, 500));
    return pool.connect();
  }
}
