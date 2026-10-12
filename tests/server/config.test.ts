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
    const base = { DATABASE_URL: "postgres://x@h.example/db?sslmode=require", VERCEL: "1" };
    expect(chk({ ...base, VERCEL_ENV: "preview", JG_ENV: "production" }).state).toBe("environment_mismatch");
    expect(chk({ ...base, VERCEL_ENV: "production", JG_ENV: "preview" }).state).toBe("environment_mismatch");
    expect(chk({ ...base, VERCEL_ENV: "preview", JG_ENV: "preview" }).state).toBe("ok");
    expect(chk({ ...base, VERCEL_ENV: "production", JG_ENV: "production" }).state).toBe("ok");
    expect(chk({ ...base, JG_ENV: "production" }).state).toBe("environment_mismatch");
  });
  it("nem éles környezet nem mutathat a megadott éles adatbázis-hosztra", () => {
    const hosts = { JG_PRODUCTION_DB_HOSTS: "prod.db.example, other.example" };
    expect(chk({ DATABASE_URL: "postgres://u:p@prod.db.example:5432/db?sslmode=require", JG_ENV: "preview", ...hosts }).state).toBe("environment_mismatch");
    expect(chk({ DATABASE_URL: "postgres://u:p@PROD.db.example/db?sslmode=require", JG_ENV: "local", ...hosts }).state).toBe("environment_mismatch");
    expect(chk({ DATABASE_URL: "postgres://u:p@prod.db.example/db?sslmode=require", JG_ENV: "production", ...hosts }).state).toBe("ok");
    expect(chk({ DATABASE_URL: "postgres://u:p@preview.db.example/db?sslmode=require", JG_ENV: "preview", ...hosts }).state).toBe("ok");
  });
  it("nem helyi adatbázishoz TLS kötelező (sslmode=require/verify-full); loopback helyi környezetben titkosítás nélkül is engedett", () => {
    const url = (q: string, host = "ep-x.c-8.eu-central-1.aws.neon.tech") => `postgres://u:p@${host}/db${q}`;
    for (const env of ["preview", "production"]) {
      expect(chk({ DATABASE_URL: url(""), JG_ENV: env }).state, `${env} sslmode nélkül`).toBe("invalid_config");
      for (const bad of ["disable", "allow", "prefer", "no-verify"]) expect(chk({ DATABASE_URL: url(`?sslmode=${bad}`), JG_ENV: env }).state, bad).toBe("invalid_config");
      for (const good of ["require", "verify-ca", "verify-full"]) expect(chk({ DATABASE_URL: url(`?sslmode=${good}`), JG_ENV: env }).state, good).toBe("ok");
    }
    expect(chk({ DATABASE_URL: url("", "localhost"), JG_ENV: "local" }).state).toBe("ok");
    expect(chk({ DATABASE_URL: url("", "127.0.0.1"), JG_ENV: "preview" }).state).toBe("ok");
    expect(chk({ DATABASE_URL: "nem-url", JG_ENV: "preview" }).state).toBe("invalid_config");
    expect(chk({ DATABASE_URL: "mysql://u:p@h.example/db?sslmode=require", JG_ENV: "preview" }).state).toBe("invalid_config");
  });
  it("adatbázis- vagy JG-konfiguráció NEXT_PUBLIC_ változóban tiltott (a kliens-csomagba kerülne); ártalmatlan NEXT_PUBLIC_ változó nem zavar", () => {
    const ok = { DATABASE_URL: "postgres://u:p@h.example/db?sslmode=require", JG_ENV: "preview" };
    for (const name of ["NEXT_PUBLIC_DATABASE_URL", "NEXT_PUBLIC_DB_HOST", "NEXT_PUBLIC_JG_ENV", "NEXT_PUBLIC_PGPASSWORD", "NEXT_PUBLIC_NEON_URL"]) {
      expect(chk({ ...ok, [name]: "x" }).state, name).toBe("invalid_config");
    }
    expect(chk({ ...ok, NEXT_PUBLIC_ANALYTICS_ID: "abc" }).state).toBe("ok");
    expect(chk({ ...ok, NEXT_PUBLIC_DATABASE_URL: "" }).state).toBe("ok");
  });
});
