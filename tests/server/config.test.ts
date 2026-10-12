import { describe, expect, it } from "vitest";
import { checkConfig, readConfig } from "@/server/config";

const chk = (env: Record<string, string>) => checkConfig(readConfig(env));

describe("konfiguráció és környezet-szétválasztás", () => {
  it("adatbázis nélkül not_configured - nincs csendes tartalék", () => {
    expect(chk({}).state).toBe("not_configured");
    expect(chk({ JG_ENV: "local" }).state).toBe("not_configured");
  });
  it("a JG_ENV kötelező, és csak a három ismert érték", () => {
    expect(chk({ DATABASE_URL: "postgres://x@h/db" }).state).toBe("invalid_config");
    expect(chk({ DATABASE_URL: "postgres://x@h/db", JG_ENV: "staging" }).state).toBe("invalid_config");
    expect(chk({ DATABASE_URL: "postgres://x@h/db", JG_ENV: "local" }).state).toBe("ok");
  });
  it("a fájl alapú helyi DB csak local környezetben és Vercelen kívül engedett", () => {
    expect(chk({ JG_PGLITE_DIR: "/tmp/x", JG_ENV: "local" }).state).toBe("ok");
    expect(chk({ JG_PGLITE_DIR: "/tmp/x", JG_ENV: "preview" }).state).toBe("invalid_config");
    expect(chk({ JG_PGLITE_DIR: "/tmp/x", JG_ENV: "local", VERCEL: "1", VERCEL_ENV: "development" }).state).toBe("invalid_config");
    expect(chk({ JG_PGLITE_DIR: "/tmp/x", DATABASE_URL: "postgres://x@h/db", JG_ENV: "local" }).state).toBe("invalid_config");
  });
  it("Vercel előnézet nem futhat production címkével (és fordítva)", () => {
    const base = { DATABASE_URL: "postgres://x@h/db", VERCEL: "1" };
    expect(chk({ ...base, VERCEL_ENV: "preview", JG_ENV: "production" }).state).toBe("environment_mismatch");
    expect(chk({ ...base, VERCEL_ENV: "production", JG_ENV: "preview" }).state).toBe("environment_mismatch");
    expect(chk({ ...base, VERCEL_ENV: "preview", JG_ENV: "preview" }).state).toBe("ok");
    expect(chk({ ...base, VERCEL_ENV: "production", JG_ENV: "production" }).state).toBe("ok");
    expect(chk({ ...base, JG_ENV: "production" }).state).toBe("environment_mismatch");
  });
  it("nem éles környezet nem mutathat a megadott éles adatbázis-hosztra", () => {
    const hosts = { JG_PRODUCTION_DB_HOSTS: "prod.db.example, other.example" };
    expect(chk({ DATABASE_URL: "postgres://u:p@prod.db.example:5432/db", JG_ENV: "preview", ...hosts }).state).toBe("environment_mismatch");
    expect(chk({ DATABASE_URL: "postgres://u:p@PROD.db.example/db", JG_ENV: "local", ...hosts }).state).toBe("environment_mismatch");
    expect(chk({ DATABASE_URL: "postgres://u:p@prod.db.example/db", JG_ENV: "production", ...hosts }).state).toBe("ok");
    expect(chk({ DATABASE_URL: "postgres://u:p@preview.db.example/db", JG_ENV: "preview", ...hosts }).state).toBe("ok");
  });
});
