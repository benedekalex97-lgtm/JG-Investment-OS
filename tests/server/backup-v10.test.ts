import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { assertEmptyTarget, assertOperatorConnection, BACKUP_TABLES, CATALOG_TABLES, exportBackup, restoreBackup, RestoreError, tableChecksum, type Backup } from "@/server/backup";
import { BackupIntegrityError, generateKey, openBackup, parseKey, readHeader, sealBackup, verifyAgainstHeader } from "@/server/backup-crypto";
import { checkBackupTarget, insideGitRepo, loadBackupKey, plaintextGate, restoreGate } from "@/server/backup-ops";
import { LATEST_MIGRATION } from "@/server/db/migrate";
import { createPgliteDb } from "@/server/db/pglite-driver";
import { migrate } from "@/server/db/migrate";
import { createUser } from "@/server/auth/service";
import type { Db } from "@/server/db/types";
import { DRIVERS, PASSWORD_A, PASSWORD_B, addPilotUsers, client, makeApi, makeTestDb, type TestDb } from "./helpers";
import { baseOptions, csv, grant, uploader } from "./data-helpers";

/**
 * CRM-019 / CRM-020: teljes logikai mentés titkosítva, integritás-ellenőrzés, izolált visszaállítás, régi sémák, Production-védelem.
 * Eldobható (PGlite / külön PostgreSQL) adatbázisokon, kizárólag fiktív adattal.
 */
const SRC = { databaseFingerprint: "teszt-forras" };

/** Fiktív, „éles-szerű” forrásadatbázis: felhasználók, Google-azonosító, jogok, ügyfél, feladat + Output, tiltakozás, import, soft-delete. */
async function seed(db: Db) {
  const { a } = await addPilotUsers(db);
  await grant(db, "pilot.egy@example.test", "crm.customer.import", "crm.import.history.read");
  await db.system((tx) => tx.query("insert into oauth_identities (issuer, subject, user_id) values ('https://accounts.google.com', 'fiktiv-mentes-subject', $1)", [a.id]));
  const prev = process.env.JG_CUSTOMER_IMPORT_ENABLED;
  process.env.JG_CUSTOMER_IMPORT_ENABLED = "true";
  try {
    const handle = makeApi(db);
    const c = client(handle);
    await c.login("pilot.egy@example.test", PASSWORD_A);
    const cust = (await c.op<{ customer: { id: string } }>("customer.create", { input: { type: "company", companyName: "Mentett Kft.", contactName: "Mentő Márta", phone: "+36 1 000 0301" } })).body.result.value!.customer;
    const task = (await c.op<{ id: string }>("task.create", { input: { customerId: cust.id, taskType: "email" } })).body.result.value!;
    await c.op("task.close", { taskId: task.id, input: { outcome: "success", output: "Fiktív Output szöveg" } });
    const gone = (await c.op<{ customer: { id: string } }>("customer.create", { input: { type: "individual", name: "Eltávolított Edit" } })).body.result.value!.customer;
    await db.system((tx) => tx.query("update customers set deleted_at = now(), deleted_by = $2 where id = $1", [gone.id, a.id]));
    await db.system((tx) => tx.query("insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values ($1, 'restriction', 'fiktív korlátozás', now(), $2)", [cust.id, a.id]));
    const U = uploader(handle, c);
    const file = csv([["Ügyféltípus", "Név", "E-mail"], ["Magánszemély", "Importált Ibolya", "ibolya@example.test"]]);
    const pv = await U.upload("/api/data/import/preview", file, baseOptions(["type", "fullName", "email"]));
    await U.upload("/api/data/import/commit", file, { jobId: pv.body.jobId, decisions: {} });
  } finally {
    if (prev === undefined) delete process.env.JG_CUSTOMER_IMPORT_ENABLED; else process.env.JG_CUSTOMER_IMPORT_ENABLED = prev;
  }
  await db.system((tx) => tx.query("insert into ops_log (operation, environment, operator, detail) values ('permission.grant', 'local', 'Teszt', '{}'::jsonb)"));
  return { userId: a.id };
}

describe.each(DRIVERS)("v1.0 mentés és visszaállítás (%s)", (kind) => {
  let src: TestDb;
  let backup: Backup;
  const key = parseKey(generateKey());
  beforeAll(async () => {
    src = await makeTestDb(kind);
    await seed(src.db);
    backup = JSON.parse(JSON.stringify(await exportBackup(src.db, "local")));
  });
  afterAll(async () => { await src.cleanup(); });

  it("B01/B02/B03/B07/B08/B09: minden üzleti tábla (új v1.0 táblák is), helyes sorszámok és sémaverzió; soft-delete, importnapló és jogok benne", () => {
    expect(Object.keys(backup.tables)).toEqual([...BACKUP_TABLES]);
    expect(backup.migration).toBe(LATEST_MIGRATION);
    for (const t of BACKUP_TABLES) expect(backup.counts[t]).toBe(backup.tables[t].length);
    expect(backup.counts).toMatchObject({ users: 2, oauth_identities: 1, user_permissions: 2, customers: 3, import_jobs: 1, import_results: 1, customer_restrictions: 1, task_results: 1 });
    expect(backup.counts.ops_log).toBeGreaterThanOrEqual(3);
    expect(backup.tables.customers.filter((c) => c.deleted_at !== null)).toHaveLength(1);
    expect(JSON.stringify(backup)).not.toMatch(/token_hash|oauth_flows|login_attempts/);
  });

  it("B04/B06: titkosított boríték - a fájlban nincs olvasható személyes adat; a fejléc csak metaadat; visszafejtve azonos", () => {
    const sealed = sealBackup(backup, key, SRC);
    const text = sealed.toString("latin1");
    for (const pii of ["Mentett Kft.", "Mentő Márta", "pilot.egy@example.test", "ibolya@example.test", "Fiktív Output", "scrypt"]) expect(text).not.toContain(pii);
    const { header } = readHeader(sealed);
    expect(header).toMatchObject({ format: "jg-os-backup-sealed", cipher: "aes-256-gcm", environment: "local", migration: LATEST_MIGRATION, counts: backup.counts });
    expect(JSON.stringify(header)).not.toMatch(/example\.test|Mentett|Márta/);
    expect(header.tableSha256.customers).toBe(tableChecksum(backup.tables.customers));
    const opened = openBackup(sealed, key);
    expect(opened.backup).toEqual(backup);
  });

  it("B10/R03/R04: sérült, módosított, csonka fájl, hibás kulcs és hibás formátum elutasítva", () => {
    const sealed = sealBackup(backup, key, SRC);
    const flip = Buffer.from(sealed); flip[flip.length - 5] ^= 0xff;
    expect(() => openBackup(flip, key)).toThrow(BackupIntegrityError);
    const { offset } = readHeader(sealed);
    const head = Buffer.from(sealed); head[offset - 10] ^= 0x01;
    expect(() => openBackup(head, key)).toThrow(BackupIntegrityError);
    expect(() => openBackup(sealed.subarray(0, sealed.length - 100), key)).toThrow(BackupIntegrityError);
    expect(() => openBackup(sealed, parseKey(generateKey()))).toThrow(/kulcs/);
    expect(() => openBackup(Buffer.from("nem mentés"), key)).toThrow(/formátum/);
    expect(() => parseKey("rövid")).toThrow(BackupIntegrityError);
    // Belső manipuláció: a tartalom módosítva és újra titkosítva a régi lenyomatokkal -> a fejléc-ellenőrzés elkapja.
    const tampered = JSON.parse(JSON.stringify(backup)) as Backup;
    tampered.tables.customers[0].company_name = "Hamisított Kft.";
    const good = readHeader(sealBackup(backup, key, SRC)).header;
    expect(() => verifyAgainstHeader(tampered, good)).toThrow(/lenyomata nem egyezik \(customers\)/);
    const short = JSON.parse(JSON.stringify(backup)) as Backup;
    short.tables.users.pop();
    expect(() => verifyAgainstHeader(short, good)).toThrow(/sorszám/);
  });

  it("R01/R08/R09/R11/R10: izolált, üres adatbázisba visszaállítás - sorszám és tartalom azonos, kapcsolatok, audit, Outputok, soft-delete; belépés és jogosultság működik", async () => {
    const dst = await makeTestDb(kind);
    try {
      const counts = await restoreBackup(dst.db, openBackup(sealBackup(backup, key, SRC), key).backup, "local");
      expect(counts).toEqual(backup.counts);
      const again = JSON.parse(JSON.stringify(await exportBackup(dst.db, "local")));
      expect(again.tables).toEqual(backup.tables);
      const [{ orphans }] = await dst.db.system((tx) => tx.query<{ orphans: string }>(
        `select (select count(*) from tasks t left join customers c on c.id = t.customer_id where c.id is null)
              + (select count(*) from import_results r left join customers c on c.id = r.customer_id where r.customer_id is not null and c.id is null)
              + (select count(*) from company_contacts k left join customers c on c.id = k.company_id where c.id is null) as orphans`));
      expect(Number(orphans)).toBe(0);
      const handle = makeApi(dst.db);
      const c = client(handle);
      expect((await c.login("pilot.egy@example.test", PASSWORD_A)).status).toBe(200);
      const me = (await (await c.get("/api/auth/me")).json()) as { permissions: string[] };
      expect(me.permissions).toEqual(["crm.customer.import", "crm.import.history.read"]);
      const jobs = (await (await c.get("/api/data/import/jobs")).json()) as { jobs: { status: string; createdCount: number }[] };
      expect(jobs.jobs).toMatchObject([{ status: "completed", createdCount: 1 }]);
      const snap = ((await (await c.get("/api/crm/snapshot")).json()) as { snapshot: import("@/domain/types").DataSnapshot }).snapshot;
      expect(snap.customers.map((x) => (x.type === "company" ? x.companyName : x.displayName)).sort()).toEqual(["Importált Ibolya", "Mentett Kft."]);
      expect(snap.tasks[0].outputs?.[0]).toMatchObject({ outcome: "success", text: "Fiktív Output szöveg" });
      expect(snap.customers.find((x) => x.type === "company")?.restriction).toMatchObject({ kind: "restriction" });
      const w = client(handle);
      expect((await w.login("pilot.ketto@example.test", PASSWORD_B)).status).toBe(200);
      expect((await w.get("/api/data/import/jobs")).status).toBe(403);
      // Az audit-sorszám folytatódik (nincs ütközés az új bejegyzéssel).
      expect((await c.op("customer.create", { input: { type: "individual", name: "Visszaállítás Utáni" } })).body.result.ok).toBe(true);
      const g = await dst.db.system((tx) => tx.query<{ n: string }>("select count(*) as n from oauth_identities where subject = 'fiktiv-mentes-subject'"));
      expect(Number(g[0].n)).toBe(1);
    } finally { await dst.cleanup(); }
  });

  it("R02/R05/R06/R07: nem üres cél, eltérő környezet, inkompatibilis séma, részleges hiba - semmi nem íródik", async () => {
    await expect(restoreBackup(src.db, backup, "local")).rejects.toThrow(/nem üres/);
    const dst = await makeTestDb(kind);
    try {
      await expect(restoreBackup(dst.db, backup, "preview")).rejects.toThrow(/környezet/);
      await expect(restoreBackup(dst.db, { ...backup, migration: "0099_jovobeli" }, "local")).rejects.toThrow(/sémaverzió/);
      await expect(restoreBackup(dst.db, { ...backup, migration: "0001_init" }, "local")).rejects.toThrow(/sémaverzió/);
      const extra = JSON.parse(JSON.stringify(backup)); extra.tables.ismeretlen = []; extra.counts.ismeretlen = 0;
      await expect(restoreBackup(dst.db, extra, "local")).rejects.toThrow(/Ismeretlen tábla/);
      const missing = JSON.parse(JSON.stringify(backup)); delete missing.tables.user_permissions;
      await expect(restoreBackup(dst.db, missing, "local")).rejects.toThrow(/Hiányzó tábla/);
      const badCount = JSON.parse(JSON.stringify(backup)); badCount.counts.customers = 99;
      await expect(restoreBackup(dst.db, badCount, "local")).rejects.toThrow(/sorösszesítő/);
      const broken = JSON.parse(JSON.stringify(backup)); broken.tables.import_results[0].customer_id = "nincs-ilyen-ugyfel";
      await expect(restoreBackup(dst.db, broken, "local")).rejects.toThrow();
      // v1.1: a katalógusok a migráció kiinduló sorait tartalmazzák (nem a mentés adatát) - a sikertelen kísérlet után is érintetlenül.
      const n = await dst.db.system((tx) => tx.query<{ n: string }>(`select (${BACKUP_TABLES.filter((t) => !(CATALOG_TABLES as readonly string[]).includes(t)).map((t) => `(select count(*) from ${t})`).join(" + ")}) as n`));
      expect(Number(n[0].n)).toBe(0);
      await dst.db.system((tx) => assertEmptyTarget(tx));
    } finally { await dst.cleanup(); }
  });

  it("régi (v0.9 / 0004) mentés: az azóta létrejött táblák nélkül is visszaállítható - üresek maradnak, kitalált jog vagy adatforrás nélkül", async () => {
    const old = JSON.parse(JSON.stringify(backup)) as Backup;
    old.migration = "0004_test_customer_soft_delete";
    for (const t of ["user_permissions", "ops_log", "import_jobs", "import_results"]) { delete old.tables[t]; delete old.counts[t]; }
    const dst = await makeTestDb(kind);
    try {
      const counts = await restoreBackup(dst.db, old, "local");
      expect(counts.user_permissions).toBeUndefined();
      const [{ p, j }] = await dst.db.system((tx) => tx.query<{ p: string; j: string }>("select (select count(*) from user_permissions) as p, (select count(*) from import_jobs) as j"));
      expect([Number(p), Number(j)]).toEqual([0, 0]);
      const c = client(makeApi(dst.db));
      await c.login("pilot.egy@example.test", PASSWORD_A);
      expect(((await (await c.get("/api/auth/me")).json()) as { permissions: string[] }).permissions).toEqual([]);
    } finally { await dst.cleanup(); }
    // 0005-ös mentésből az import-táblák hiányozhatnak, a jogosultság-tábla nem.
    const v5 = JSON.parse(JSON.stringify(backup)) as Backup;
    v5.migration = "0005_crm_data_permissions";
    for (const t of ["import_jobs", "import_results"]) { delete v5.tables[t]; delete v5.counts[t]; }
    v5.tables.customers = v5.tables.customers.filter(() => true);
    const dst2 = await makeTestDb(kind);
    try {
      const counts = await restoreBackup(dst2.db, v5, "local");
      expect(counts.user_permissions).toBe(2);
    } finally { await dst2.cleanup(); }
  });

  it("B05: üzemeltetői jogosultság - alkalmazás-szerepkörrel (jg_app) a mentés/visszaállítás nem futtatható", async () => {
    await expect(assertOperatorConnection(src.db)).resolves.toBeUndefined();
    const asApp: Db = { ...src.db, system: (fn) => src.db.system(async (tx) => { await tx.exec("SET LOCAL ROLE jg_app"); return fn(tx); }) };
    await expect(assertOperatorConnection(asApp)).rejects.toThrow(RestoreError);
    await expect(exportBackup(asApp, "local")).rejects.toThrow();
  });
});

describe("R12 és üzemeltetői védőszabályok", () => {
  it("Production visszaállítás: csak JG_CONFIRM_PRODUCTION=yes ÉS a konkrét mentés lenyomatához kötött jóváhagyással, titkosított mentésből", () => {
    const sha = "a".repeat(64);
    expect(() => restoreGate("production", {}, sha)).toThrow(/JG_CONFIRM_PRODUCTION/);
    expect(() => restoreGate("production", { JG_CONFIRM_PRODUCTION: "yes" }, sha)).toThrow(/JG_RESTORE_PRODUCTION_APPROVAL/);
    expect(() => restoreGate("production", { JG_CONFIRM_PRODUCTION: "yes", JG_RESTORE_PRODUCTION_APPROVAL: "b".repeat(64) }, sha)).toThrow(/JG_RESTORE_PRODUCTION_APPROVAL/);
    expect(() => restoreGate("production", { JG_CONFIRM_PRODUCTION: "yes", JG_RESTORE_PRODUCTION_APPROVAL: sha }, null)).toThrow(/titkosított/);
    expect(() => restoreGate("production", { JG_CONFIRM_PRODUCTION: "yes", JG_RESTORE_PRODUCTION_APPROVAL: sha }, sha)).not.toThrow();
    expect(() => restoreGate("preview", {}, null)).not.toThrow();
    expect(() => plaintextGate("production", { JG_RESTORE_ALLOW_PLAINTEXT: "yes" })).toThrow(/titkosítatlan/);
    expect(() => plaintextGate("local", {})).toThrow(/JG_RESTORE_ALLOW_PLAINTEXT/);
  });
  it("a mentés nem írható Git munkakönyvtárba; a kulcs nem lehet a mentés mellett; tág jogosultságú kulcsfájl elutasítva", () => {
    expect(insideGitRepo(join(process.cwd(), "valami.jgbackup"))).toBe(true);
    expect(() => checkBackupTarget(join(process.cwd(), "valami.jgbackup"))).toThrow(/Git/);
    const dir = mkdtempSync(join(tmpdir(), "jg-key-"));
    try {
      const keyFile = join(dir, "kulcs.txt");
      writeFileSync(keyFile, generateKey(), { mode: 0o600 });
      expect(() => loadBackupKey({ JG_BACKUP_KEY_FILE: keyFile }, join(dir, "mentes.jgbackup"))).toThrow(/azonos könyvtárban/);
      mkdirSync(join(dir, "mentesek"));
      expect(loadBackupKey({ JG_BACKUP_KEY_FILE: keyFile }, join(dir, "mentesek", "m.jgbackup"))).toHaveLength(32);
      const loose = join(dir, "laza.txt");
      writeFileSync(loose, generateKey(), { mode: 0o644 });
      if (process.platform !== "win32") expect(() => loadBackupKey({ JG_BACKUP_KEY_FILE: loose }, join(dir, "mentesek", "m.jgbackup"))).toThrow(/jogosultsága/);
      expect(() => loadBackupKey({}, "x")).toThrow(/titkosítatlan mentés nem engedett/);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});

/** Az üzemeltetői CLI végponttól végpontig (külön folyamat, fájl alapú helyi PGlite adatbázisok a repón kívül). */
describe("db CLI: backup / backup:verify / backup:inspect / restore:check / restore", () => {
  const work = mkdtempSync(join(tmpdir(), "jg-cli-backup-"));
  const srcDir = join(work, "src-pg"), dstDir = join(work, "dst-pg"), keyDir = join(work, "kulcs"), outDir = join(work, "mentesek");
  const keyFile = join(keyDir, "backup.key"), file = join(outDir, "crm.jgbackup");
  const run = (args: string[], env: Record<string, string> = {}) => spawnSync(process.execPath, ["--import", "tsx", "scripts/db.ts", ...args], {
    cwd: process.cwd(), encoding: "utf8", env: { ...process.env, JG_ENV: "local", JG_OPERATOR: "Teszt Üzemeltető", JG_BACKUP_KEY_FILE: keyFile, ...env },
  });
  beforeAll(async () => {
    mkdirSync(keyDir); mkdirSync(outDir);
    const db = await createPgliteDb(srcDir);
    await migrate(db, { env: "local" });
    await createUser(db, { email: "cli.pilot@example.test", name: "CLI Pilot", password: PASSWORD_A });
    await db.system((tx) => tx.query("insert into customers (id, type, display_name, first_name, last_name, owner_id, created_at, updated_at) select 'cust-cli', 'individual', 'Parancssori Panna', 'Panna', 'Parancssori', id, now(), now() from users"));
    await db.close();
  });
  afterAll(() => rmSync(work, { recursive: true, force: true }));

  it("kulcs nélkül nincs mentés; kulccsal titkosított mentés készül, ellenőrizhető, a metaadat-nézet személyes adatot nem ír ki", () => {
    expect(run(["backup", file], { JG_PGLITE_DIR: srcDir, JG_BACKUP_KEY_FILE: "" }).stderr).toMatch(/Hiányzó mentési kulcs/);
    expect(run(["backup:keygen", keyFile]).status).toBe(0);
    expect(run(["backup:keygen", keyFile]).status).not.toBe(0);
    const b = run(["backup", file], { JG_PGLITE_DIR: srcDir });
    expect(b.status, b.stderr).toBe(0);
    expect(b.stdout).toMatch(/Titkosított mentés kész/);
    expect(b.stdout + b.stderr).not.toMatch(/Parancssori Panna|cli\.pilot@example\.test/);
    expect(readFileSync(file).toString("latin1")).not.toContain("Parancssori Panna");
    expect(run(["backup", file], { JG_PGLITE_DIR: srcDir }).stderr).toMatch(/már létezik/);
    const v = run(["backup:verify", file]);
    expect(v.status, v.stderr).toBe(0);
    expect(v.stdout).toMatch(/Integritás rendben/);
    const i = run(["backup:inspect", file], { JG_BACKUP_KEY_FILE: "" });
    expect(i.status).toBe(0);
    expect(i.stdout).toMatch(/customers: 1/);
    expect(i.stdout).not.toMatch(/Panna|example\.test/);
    expect(run(["backup:verify", file], { JG_BACKUP_KEY_FILE: "", JG_BACKUP_KEY: generateKey() }).stderr).toMatch(/nem ehhez a mentéshez tartozik/);
  });

  it("restore:check írás nélkül ellenőriz; restore csak üres, migrált célba; a forrásba (nem üres) nem ír; üzemeltetői napló", async () => {
    expect(run(["restore:check", file], { JG_PGLITE_DIR: srcDir }).stderr).toMatch(/nem üres/);
    const m = run(["migrate"], { JG_PGLITE_DIR: dstDir });
    expect(m.status, m.stderr).toBe(0);
    const chk = run(["restore:check", file], { JG_PGLITE_DIR: dstDir });
    expect(chk.status, chk.stderr).toBe(0);
    expect(chk.stdout).toMatch(/előfeltételei rendben/);
    expect(run(["restore", file], { JG_PGLITE_DIR: dstDir, JG_OPERATOR: "" }).stderr).toMatch(/üzemeltető azonosítója kötelező/);
    const r = run(["restore", file], { JG_PGLITE_DIR: dstDir });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toMatch(/tartalom-ellenőrzéssel/);
    expect(run(["restore", file], { JG_PGLITE_DIR: dstDir }).stderr).toMatch(/nem üres/);
    const db = await createPgliteDb(dstDir);
    try {
      const rows = await db.system((tx) => tx.query<{ operation: string }>("select operation from ops_log order by id"));
      // A forrás „backup.create” bejegyzése a pillanatkép UTÁN íródik, ezért a célban csak a visszaállítás naplója szerepel.
      expect(rows.map((x) => x.operation)).toEqual(["restore.complete"]);
      const [{ n }] = await db.system((tx) => tx.query<{ n: string }>("select count(*) as n from customers where id = 'cust-cli'"));
      expect(Number(n)).toBe(1);
    } finally { await db.close(); }
  });

  it("régi, titkosítatlan JSON mentés csak kifejezett engedéllyel állítható vissza", async () => {
    const legacyDir = join(work, "legacy-pg"), legacyFile = join(outDir, "regi.json");
    const db = await createPgliteDb(srcDir);
    try { writeFileSync(legacyFile, JSON.stringify(await exportBackup(db, "local")), { mode: 0o600 }); } finally { await db.close(); }
    expect(run(["migrate"], { JG_PGLITE_DIR: legacyDir }).status).toBe(0);
    expect(run(["restore", legacyFile], { JG_PGLITE_DIR: legacyDir }).stderr).toMatch(/JG_RESTORE_ALLOW_PLAINTEXT/);
    const ok = run(["restore", legacyFile], { JG_PGLITE_DIR: legacyDir, JG_RESTORE_ALLOW_PLAINTEXT: "yes" });
    expect(ok.status, ok.stderr).toBe(0);
  });
});
