import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportBackup, restoreBackup } from "@/server/backup";
import { generateKey } from "@/server/backup-crypto";
import type { JgEnv } from "@/server/config";
import { grantPermission, revokePermission } from "@/server/data/permissions";
import { migrate } from "@/server/db/migrate";
import { createPgliteDb } from "@/server/db/pglite-driver";
import { createUser } from "@/server/auth/service";
import { DRIVERS, addPilotUsers, makeTestDb, type TestDb } from "./helpers";
import { OPERATOR } from "./data-helpers";

/**
 * F2 (review): a jogosultság-módosítás és a mentés/visszaállítás az adatbázis SAJÁT környezetjelölését (meta.environment) is kötelezően
 * ellenőrzi, a művelet saját tranzakciójában, minden módosítás és adatolvasás előtt. A „production” jelölés itt kizárólag eldobható,
 * helyi tesztadatbázis címkéje; valódi Production-kapcsolat nincs.
 */
const EMAIL = "pilot.egy@example.test";

describe.each(DRIVERS)("adatbázis-környezet ellenőrzése (%s)", (kind) => {
  let t: TestDb;
  const count = async (sql: string) => Number((await t.db.system((tx) => tx.query<{ n: string }>(sql)))[0].n);
  const grant = (env: JgEnv) => grantPermission(t.db, { email: EMAIL, permission: "crm.customer.import", operator: OPERATOR, env });
  const revoke = (env: JgEnv) => revokePermission(t.db, { email: EMAIL, permission: "crm.customer.export", operator: OPERATOR, env });
  const setMeta = (value: string | null) => t.db.system(async (tx) => {
    await tx.query("delete from meta where key = 'environment'");
    if (value !== null) await tx.query("insert into meta (key, value) values ('environment', $1)", [value]);
  });

  beforeAll(async () => {
    t = await makeTestDb(kind, { migrate: false });
    await migrate(t.db, { env: "production" });
    await addPilotUsers(t.db);
    // Meglévő (fiktív) jog, amelynek a visszavonását próbáljuk.
    await t.db.system((tx) => tx.query("insert into user_permissions (user_id, permission, granted_by) select id, 'crm.customer.export', 'teszt' from users where email = $1", [EMAIL]));
  });
  afterAll(async () => { await t.cleanup(); });

  it("production jelölésű adatbázis + preview kérés: grant, revoke, backup és restore elutasítva; nincs változás és hamis sikerbejegyzés", async () => {
    await expect(grant("preview")).rejects.toThrow(/környezet/);
    await expect(revoke("preview")).rejects.toThrow(/környezet/);
    await expect(exportBackup(t.db, "preview")).rejects.toThrow(/környezet/);
    const backup = await exportBackup(t.db, "production");
    await expect(restoreBackup(t.db, { ...backup, environment: "preview" }, "preview")).rejects.toThrow(/környezet/);
    expect(await count("select count(*) as n from user_permissions where permission = 'crm.customer.import'")).toBe(0);
    expect(await count("select count(*) as n from user_permissions where permission = 'crm.customer.export'")).toBe(1);
    expect(await count("select count(*) as n from ops_log")).toBe(0);
  });

  it("hiányzó vagy érvénytelen környezetjelölés: elutasítva (fail-closed), a jelölés nem íródik át", async () => {
    for (const value of [null, "staging", "", "PRODUCTION"]) {
      await setMeta(value);
      await expect(grant("production")).rejects.toThrow(/környezet/);
      await expect(revoke("production")).rejects.toThrow(/környezet/);
      await expect(exportBackup(t.db, "production")).rejects.toThrow(/környezet/);
      const meta = await t.db.system((tx) => tx.query<{ value: string }>("select value from meta where key = 'environment'"));
      expect(meta.map((m) => m.value)).toEqual(value === null ? [] : [value]);
    }
    expect(await count("select count(*) as n from user_permissions where permission = 'crm.customer.import'")).toBe(0);
    expect(await count("select count(*) as n from ops_log")).toBe(0);
    await setMeta("production");
  });

  it("egyező környezetjelölés mellett a műveletek működnek", async () => {
    expect(await grant("production")).toMatchObject({ granted: true });
    expect(await revoke("production")).toEqual({ revoked: true });
    expect((await exportBackup(t.db, "production")).environment).toBe("production");
    expect(await count("select count(*) as n from ops_log where operation in ('permission.grant', 'permission.revoke')")).toBe(2);
  });
});

/** A CLI ugyanezt a védett útvonalat használja: eltérő jelölésű (eldobható, helyi) adatbázison nem oszt jogot és nem ment. */
describe("db CLI: környezet-eltérésnél nincs jogosultság-módosítás és nincs mentésfájl", () => {
  const work = mkdtempSync(join(tmpdir(), "jg-cli-env-"));
  const dir = join(work, "pg"), keyDir = join(work, "kulcs"), outDir = join(work, "mentes");
  const keyFile = join(keyDir, "k.key"), file = join(outDir, "m.jgbackup");
  const run = (args: string[]) => spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, JG_ENV: "local", JG_PGLITE_DIR: dir, JG_OPERATOR: OPERATOR, JG_BACKUP_KEY_FILE: keyFile },
  });
  beforeAll(async () => {
    mkdirSync(keyDir); mkdirSync(outDir);
    writeFileSync(keyFile, generateKey(), { mode: 0o600 });
    const db = await createPgliteDb(dir);
    await migrate(db, { env: "preview" });
    await createUser(db, { email: EMAIL, name: "CLI Pilot", password: "fiktiv-jelszo-A-12345" });
    await db.close();
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("JG_ENV=local, az adatbázis preview jelölésű: permission:grant, permission:revoke és backup elutasítva", async () => {
    for (const args of [["permission:grant", EMAIL, "crm.customer.import"], ["permission:revoke", EMAIL, "crm.customer.import"], ["backup", file]]) {
      const r = run(args);
      expect(r.status, args.join(" ")).not.toBe(0);
      expect(r.stderr).toMatch(/környezet/);
    }
    expect(existsSync(file)).toBe(false);
    const db = await createPgliteDb(dir);
    try {
      const [{ p, o }] = await db.system((tx) => tx.query<{ p: string; o: string }>("select (select count(*) from user_permissions) as p, (select count(*) from ops_log) as o"));
      expect([Number(p), Number(o)]).toEqual([0, 0]);
    } finally { await db.close(); }
  });
});
