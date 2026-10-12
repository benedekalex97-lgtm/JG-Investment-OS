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
  /** `NEXT_PUBLIC_*` változók, amelyek adatbázis- vagy JG-konfigurációt hordoznának (a kliens-csomagba kerülnének): tilos. */
  publicLeaks: string[];
}

export function readConfig(e: Record<string, string | undefined> = process.env): RuntimeConfig {
  return {
    env: JG_ENVS.find((x) => x === e.JG_ENV?.trim()),
    databaseUrl: e.DATABASE_URL?.trim() || undefined,
    pgliteDir: e.JG_PGLITE_DIR?.trim() || undefined,
    onVercel: Boolean(e.VERCEL),
    vercelEnv: e.VERCEL_ENV?.trim() || undefined,
    productionDbHosts: (e.JG_PRODUCTION_DB_HOSTS ?? "").split(",").map((h) => h.trim().toLowerCase()).filter(Boolean),
    publicLeaks: Object.keys(e).filter((k) => /^NEXT_PUBLIC_.*(DATABASE|DB_|PG|POSTGRES|NEON|JG_)/i.test(k) && e[k]),
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
const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);
const TLS_MODES = new Set(["require", "verify-ca", "verify-full"]);

/** Helyi (loopback) adatbázis-hoszt: csak itt engedett a titkosítatlan kapcsolat. */
export const isLocalHost = (host: string) => LOCAL_HOSTS.has(host.toLowerCase());

export function checkConfig(cfg: RuntimeConfig): ConfigCheck {
  // A titkos beállítás soha nem kerülhet a kliens-csomagba: a NEXT_PUBLIC_ előtagú, DB/JG jellegű változó konfigurációs hiba.
  if (cfg.publicLeaks.length) return { state: "invalid_config", reason: `Tiltott kliensoldali (NEXT_PUBLIC_) változó: ${cfg.publicLeaks.join(", ")}.` };
  if (!cfg.databaseUrl && !cfg.pgliteDir) return { state: "not_configured", reason: "Nincs DATABASE_URL vagy JG_PGLITE_DIR megadva." };
  if (cfg.databaseUrl && cfg.pgliteDir) return { state: "invalid_config", reason: "DATABASE_URL és JG_PGLITE_DIR egyszerre nem adható meg." };
  if (!cfg.env) return { state: "invalid_config", reason: "A JG_ENV kötelező: local, preview vagy production." };
  if (cfg.pgliteDir && (cfg.env !== "local" || cfg.onVercel)) {
    return { state: "invalid_config", reason: "A fájl alapú helyi adatbázis (JG_PGLITE_DIR) csak local környezetben, Vercelen kívül használható." };
  }
  if (cfg.databaseUrl && cfg.env !== "local") {
    // Nem helyi környezetben a kapcsolat kötelezően TLS-sel (ellenőrzött tanúsítvánnyal) történik; a jelszó hoszt-ellenőrzés nélkül nem utazhat.
    let url: URL | undefined;
    try {
      url = new URL(cfg.databaseUrl);
    } catch {
      return { state: "invalid_config", reason: "A DATABASE_URL nem érvényes URL." };
    }
    if (!["postgres:", "postgresql:"].includes(url.protocol)) return { state: "invalid_config", reason: "A DATABASE_URL protokollja nem postgres." };
    if (!isLocalHost(url.hostname) && !TLS_MODES.has(url.searchParams.get("sslmode") ?? "")) {
      return { state: "invalid_config", reason: "Nem helyi adatbázishoz az sslmode=require (vagy verify-full) kötelező." };
    }
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
