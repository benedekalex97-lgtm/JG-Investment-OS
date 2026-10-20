import { checkConfig, readConfig, type ConfigState, type JgEnv } from "../config";
import { checkSchema, migrate } from "./migrate";
import { createPgDb } from "./pg-driver";
import { createPgliteDb } from "./pglite-driver";
import type { Db } from "./types";

export type RuntimeState = ConfigState | "schema_missing" | "schema_outdated" | "unreachable";
export type Runtime = { state: "ok"; db: Db; env: JgEnv } | { state: Exclude<RuntimeState, "ok">; reason?: string };

interface Cache {
  signature: string;
  db: Promise<Db>;
  okUntil: number;
}
const g = globalThis as unknown as { __jgRuntime?: Cache };

/**
 * Az adatbázis-kapcsolat feloldása. Nincs csendes tartalék: konfiguráció nélkül `not_configured`, hibás sémánál/környezetnél
 * megfelelő állapot (az alkalmazás ilyenkor nem szolgál ki adatot). A séma automatikus migrálása kizárólag helyi
 * környezetben történik (fájl alapú helyi DB, vagy JG_AUTO_MIGRATE=1); előnézeten és éles környezetben a migráció külön, kézi lépés.
 */
export async function getRuntime(): Promise<Runtime> {
  const cfg = readConfig();
  const chk = checkConfig(cfg);
  if (chk.state !== "ok") return { state: chk.state, reason: chk.reason };
  const env = cfg.env as JgEnv;
  const signature = `${cfg.databaseUrl ?? ""}|${cfg.pgliteDir ?? ""}|${env}`;
  try {
    if (!g.__jgRuntime || g.__jgRuntime.signature !== signature) {
      const db = cfg.databaseUrl ? Promise.resolve(createPgDb(cfg.databaseUrl)) : createPgliteDb(cfg.pgliteDir);
      g.__jgRuntime = { signature, db, okUntil: 0 };
    }
    const cache = g.__jgRuntime;
    const db = await cache.db;
    if (Date.now() < cache.okUntil) return { state: "ok", db, env };
    if (env === "local" && (db.kind === "pglite" || process.env.JG_AUTO_MIGRATE === "1")) await migrate(db, { env });
    const schema = await checkSchema(db, env);
    if (!schema.ok) return { state: schema.reason };
    cache.okUntil = Date.now() + 30_000;
    return { state: "ok", db, env };
  } catch (e) {
    // A kapcsolati hiba részletei (hosztnév, felhasználó) nem kerülnek a kliensre; csak a hibakód naplózódik.
    console.error("[jg-os] adatbázis nem elérhető:", (e as { code?: string })?.code ?? (e as Error)?.name);
    if (g.__jgRuntime) g.__jgRuntime.okUntil = 0;
    return { state: "unreachable" };
  }
}
