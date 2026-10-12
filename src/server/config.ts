/**
 * Szerveroldali futtatási konfiguráció (v0.6). Kizárólag környezeti változókból; titok nem kerül a kódba vagy a kliensre.
 *
 * Környezetek (JG_ENV): `local` (fejlesztői, fiktív adat), `preview` (előnézet/staging, fiktív vagy külön jóváhagyott adat),
 * `production` (éles, külön jóváhagyással). Az előnézet nem kapcsolódhat éles adatbázishoz: a környezet-címke az adatbázis
 * `meta` táblájában is rögzül (lásd migrate.ts), és eltérés esetén az alkalmazás nem szolgál ki adatot.
 */
export type JgEnv = "local" | "preview" | "production";
export const JG_ENVS: readonly JgEnv[] = ["local", "preview", "production"];

export interface RuntimeConfig {
  env?: JgEnv;
  databaseUrl?: string;
  pgliteDir?: string;
  onVercel: boolean;
  vercelEnv?: string;
  productionDbHosts: string[];
}

export function readConfig(e: Record<string, string | undefined> = process.env): RuntimeConfig {
  return {
    env: JG_ENVS.find((x) => x === e.JG_ENV?.trim()),
    databaseUrl: e.DATABASE_URL?.trim() || undefined,
    pgliteDir: e.JG_PGLITE_DIR?.trim() || undefined,
    onVercel: Boolean(e.VERCEL),
    vercelEnv: e.VERCEL_ENV?.trim() || undefined,
    productionDbHosts: (e.JG_PRODUCTION_DB_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
  };
}

export type ConfigState = "ok" | "not_configured" | "invalid_config" | "environment_mismatch";
export interface ConfigCheck { state: ConfigState; reason?: string }

/** Az adatbázis-hoszt (jelszó nélkül) - naplózáshoz és a termelési hoszt-listával való összevetéshez. */
export function dbHost(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Konfiguráció ellenőrzése. Nincs csendes helyettesítés: ha nincs tartós adatbázis megadva, az alkalmazás `not_configured`
 * állapotban marad (nem esik vissza böngészőtárolásra vagy memóriára).
 */
export function checkConfig(cfg: RuntimeConfig): ConfigCheck {
  if (!cfg.databaseUrl && !cfg.pgliteDir) return { state: "not_configured", reason: "Nincs DATABASE_URL vagy JG_PGLITE_DIR megadva." };
  if (cfg.databaseUrl && cfg.pgliteDir) return { state: "invalid_config", reason: "DATABASE_URL és JG_PGLITE_DIR egyszerre nem adható meg." };
  if (!cfg.env) return { state: "invalid_config", reason: "A JG_ENV kötelező: local, preview vagy production." };
  if (cfg.pgliteDir && (cfg.env !== "local" || cfg.onVercel)) {
    return { state: "invalid_config", reason: "A fájl alapú helyi adatbázis (JG_PGLITE_DIR) csak local környezetben, Vercelen kívül használható." };
  }
  if (cfg.onVercel) {
    const expected: Record<string, JgEnv> = { production: "production", preview: "preview", development: "local" };
    const want = cfg.vercelEnv ? expected[cfg.vercelEnv] : undefined;
    if (!want || want !== cfg.env) return { state: "environment_mismatch", reason: `A Vercel környezet (${cfg.vercelEnv ?? "ismeretlen"}) és a JG_ENV (${cfg.env}) nem egyezik.` };
  }
  if (cfg.databaseUrl && cfg.env !== "production" && cfg.productionDbHosts.includes(dbHost(cfg.databaseUrl))) {
    return { state: "environment_mismatch", reason: "A nem éles környezet éles adatbázis-hosztra mutat (JG_PRODUCTION_DB_HOSTS)." };
  }
  return { state: "ok" };
}

/** Megjelenítendő környezet-címke (UI). */
export const ENV_LABELS: Record<JgEnv, string> = { local: "HELYI (fiktív adat)", preview: "ELŐNÉZET (fiktív adat)", production: "ÉLES" };
