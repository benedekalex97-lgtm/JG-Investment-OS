/**
 * Adatbázis-kezelő parancssori eszköz (migráció, felhasználók, jogosultságok, mentés/visszaállítás). Soha nem seedel, nem reseteli az
 * adatbázist, és nem töröl üzleti adatot. A kapcsolat a környezeti változókból jön (lásd docs/V0.6-PERSISTENCE.md); titkot nem naplóz.
 *
 * Használat: npm run db -- <parancs>
 *   status | migrate | user:create <email> <név> | user:set-password <email> | user:deactivate <email> | user:activate <email>
 *   permission:grant <email> <jog> | permission:revoke <email> <jog> | permission:list      (v1.0; JG_OPERATOR kötelező a módosításhoz)
 *       jogok: crm.customer.import, crm.customer.export, crm.import.history.read
 *       v1.1 adminjogok: crm.settings.manage, crm.users.manage, crm.settings.audit.read (első admin kijelölése: külön jóváhagyás után,
 *       pl. JG_OPERATOR=<üzemeltető> npm run db -- permission:grant <email> crm.users.manage). A visszavonás nem töröl: a sor
 *       visszavont jelölést kap. Minden változás a beállítási változásnaplóba is bekerül (via=cli, az üzemeltető azonosítójával).
 *   backup <fájl>              titkosított mentés (JG_BACKUP_KEY vagy JG_BACKUP_KEY_FILE, JG_OPERATOR); Git munkakönyvtárba nem ír
 *   backup:keygen <fájl>       új, véletlen 32 bájtos mentési kulcs (0600 jogosultsággal; csak új fájlba)
 *   backup:inspect <fájl>      biztonságos metaadatok (kulcs nélkül; személyes adatot nem ír ki)
 *   backup:verify <fájl>       integritás-ellenőrzés visszafejtéssel (kulcs szükséges; adatbázis nem kell)
 *   restore:check <fájl>       a visszaállítás minden előfeltételének ellenőrzése írás nélkül (integritás, séma, környezet, üres cél)
 *   restore <fájl>             visszaállítás ÜRES, migrált adatbázisba (éles célnál külön, a mentéshez kötött jóváhagyás kell)
 *   customer:list-removed | customer:restore <ügyfél-azonosító> <üzemeltető e-mail>   (CRM-006: logikailag eltávolított ügyfél visszaállítása)
 *   runtime-role:provision <szerepkör-név>   (legkisebb jogosultságú futási szerepkör; jelszó: JG_RUNTIME_PASSWORD;
 *       JG_RUNTIME_PASSWORD_MODE=scram (alapértelmezett) | plaintext (Neon: csak tiszta szöveges jelszót fogad el; TLS kötelező))
 * A jelszót a JG_USER_PASSWORD környezeti változó vagy interaktív (rejtett) bekérés adja - parancssori argumentum nem.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { listRemovedCustomers, restoreCustomer } from "../src/server/admin";
import { assertEmptyTarget, assertOperatorConnection, checkBackupShape, exportBackup, restoreBackup, sha256, type Backup } from "../src/server/backup";
import { databaseFingerprint, describeHeader, generateKey, isSealed, openBackup, readHeader, sealBackup } from "../src/server/backup-crypto";
import { checkBackupTarget, insideGitRepo, loadBackupKey, plaintextGate, restoreGate } from "../src/server/backup-ops";
import { checkConfig, dbHost, isLocalHost, readConfig, type JgEnv } from "../src/server/config";
import { grantPermission, listPermissions, revokePermission, validateOperator } from "../src/server/data/permissions";
import { checkSchema, LATEST_MIGRATION, migrate } from "../src/server/db/migrate";
import { createPgDb } from "../src/server/db/pg-driver";
import { createPgliteDb } from "../src/server/db/pglite-driver";
import { createUser, setActive, setPassword } from "../src/server/auth/service";
import { PASSWORD_MODES, provisionRuntimeRole, type PasswordMode } from "../src/server/db/runtime-role";
import { opsLog } from "../src/server/ops-log";

async function promptHidden(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const w = rl as unknown as { _writeToOutput: (s: string) => void };
  process.stderr.write(question);
  w._writeToOutput = () => undefined;
  const answer = await new Promise<string>((res) => rl.question("", res));
  rl.close();
  process.stderr.write("\n");
  return answer;
}
const password = async () => process.env.JG_USER_PASSWORD ?? (await promptHidden("Jelszó: "));

/** Mentésfájl beolvasása: titkosított (ellenőrzött) vagy régi, titkosítatlan JSON (csak kifejezett engedéllyel). */
function loadBackupFile(file: string, env: JgEnv | null): { backup: Backup; contentSha256: string | null } {
  const buf = readFileSync(file);
  if (isSealed(buf)) {
    const { backup, header } = openBackup(buf, loadBackupKey(process.env, file));
    return { backup, contentSha256: header.contentSha256 };
  }
  if (env) plaintextGate(env, process.env);
  let backup: Backup;
  try {
    backup = JSON.parse(buf.toString("utf8")) as Backup;
  } catch {
    throw new Error("A mentésfájl sérült vagy ismeretlen formátumú.");
  }
  return { backup, contentSha256: null };
}

/** Adatbázist nem igénylő parancsok (a mentésfájl vizsgálata). */
function offline(cmd: string, args: string[]): boolean {
  switch (cmd) {
    case "backup:keygen": {
      const file = args[0];
      if (!file) throw new Error("Használat: backup:keygen <fájl>");
      if (insideGitRepo(file)) throw new Error("A kulcsfájl nem lehet Git munkakönyvtárban.");
      writeFileSync(file, `${generateKey()}\n`, { mode: 0o600, flag: "wx" });
      console.log(`Új mentési kulcs: ${file} (0600). Tárold a mentésektől elkülönítve (pl. jelszókezelőben / titokkezelőben); elvesztése esetén a mentések nem állíthatók vissza.`);
      return true;
    }
    case "backup:inspect": {
      const file = args[0];
      if (!file) throw new Error("Használat: backup:inspect <fájl>");
      const buf = readFileSync(file);
      if (!isSealed(buf)) {
        console.log("Titkosítatlan (régi, v0.6-v0.9 formátumú) JSON mentés: integritása nem ellenőrizhető, tartalmát nem jelenítjük meg.");
        return true;
      }
      console.log(describeHeader(readHeader(buf).header, buf.length));
      console.log("A fejléc nem hitelesített: az integritást a backup:verify ellenőrzi.");
      return true;
    }
    case "backup:verify": {
      const file = args[0];
      if (!file) throw new Error("Használat: backup:verify <fájl>");
      const buf = readFileSync(file);
      if (!isSealed(buf)) throw new Error("Titkosítatlan (régi formátumú) mentés: integritása nem ellenőrizhető.");
      const { header } = openBackup(buf, loadBackupKey(process.env, file));
      console.log(`Integritás rendben: ${Object.keys(header.counts).length} tábla, ${Object.values(header.counts).reduce((a, b) => a + b, 0)} sor, tartalom SHA-256 ${header.contentSha256}.`);
      return true;
    }
    default:
      return false;
  }
}

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
  if (offline(cmd, args)) return;
  const cfg = readConfig();
  const chk = checkConfig(cfg);
  if (chk.state !== "ok") throw new Error(`${chk.state}: ${chk.reason ?? ""}`);
  const env = cfg.env as JgEnv;
  const db = cfg.databaseUrl ? createPgDb(cfg.databaseUrl) : await createPgliteDb(cfg.pgliteDir);
  const target = cfg.databaseUrl ? `PostgreSQL (${dbHost(cfg.databaseUrl)})` : `helyi PGlite (${cfg.pgliteDir})`;
  console.error(`Környezet: ${env} · adatbázis: ${target}`);
  try {
    switch (cmd) {
      case "status": {
        const s = await checkSchema(db, env);
        console.log(s.ok ? `Séma rendben (${LATEST_MIGRATION}).` : `Séma állapota: ${s.reason}`);
        break;
      }
      case "migrate": {
        if (env === "production" && process.env.JG_CONFIRM_PRODUCTION !== "yes") throw new Error("Éles migrációhoz JG_CONFIRM_PRODUCTION=yes szükséges (külön jóváhagyás után).");
        const r = await migrate(db, { env, allowDestructive: process.env.JG_ALLOW_DESTRUCTIVE_MIGRATION });
        console.log(`Alkalmazva: ${r.applied.join(", ") || "-"} · már alkalmazva volt: ${r.alreadyApplied.join(", ") || "-"}`);
        break;
      }
      case "user:create": {
        const [email, name] = args;
        if (!email || !name) throw new Error("Használat: user:create <email> <név>");
        const u = await createUser(db, { email, name, password: await password() });
        console.log(`Felhasználó létrehozva: ${u.email} (${u.id})`);
        break;
      }
      case "user:set-password":
        if (!args[0]) throw new Error("Használat: user:set-password <email>");
        await setPassword(db, args[0], await password());
        console.log("Jelszó módosítva, a meglévő munkamenetek érvénytelenek.");
        break;
      case "user:deactivate":
      case "user:activate":
        if (!args[0]) throw new Error(`Használat: ${cmd} <email>`);
        await setActive(db, args[0], cmd === "user:activate");
        console.log(cmd === "user:activate" ? "Felhasználó aktiválva." : "Felhasználó letiltva, munkamenetei törölve (a rekordjai megmaradnak).");
        break;
      case "permission:grant":
      case "permission:revoke": {
        const [email, permission] = args;
        if (!email || !permission) throw new Error(`Használat: JG_OPERATOR=<üzemeltető> ${cmd} <email> <jog>`);
        if (env === "production" && process.env.JG_CONFIRM_PRODUCTION !== "yes") throw new Error("Éles jogosultság-módosításhoz JG_CONFIRM_PRODUCTION=yes szükséges (külön jóváhagyás után).");
        const input = { email, permission, operator: process.env.JG_OPERATOR ?? "", env };
        if (cmd === "permission:grant") {
          const r = await grantPermission(db, input);
          console.log(r.granted ? `Jogosultság kiosztva: ${permission} -> ${r.userId}` : `A jogosultság már ki volt osztva: ${permission} -> ${r.userId}`);
        } else {
          const r = await revokePermission(db, input);
          console.log(r.revoked ? `Jogosultság visszavonva: ${permission} (azonnal hat, a meglévő munkamenetre is).` : "Nem volt ilyen kiosztott jogosultság.");
        }
        break;
      }
      case "permission:list": {
        for (const p of await listPermissions(db)) console.log(`${p.email}\t${p.permission}\t${p.granted_at}\t${p.granted_by}${p.active ? "" : "\t(letiltott felhasználó)"}`);
        break;
      }
      case "runtime-role:provision": {
        const name = args[0];
        const pw = process.env.JG_RUNTIME_PASSWORD;
        if (!name || !pw) throw new Error("Használat: JG_RUNTIME_PASSWORD=<generált, min. 24 karakter> runtime-role:provision <szerepkör-név>");
        if (env === "production" && process.env.JG_CONFIRM_PRODUCTION !== "yes") throw new Error("Éles szerepkör-módosításhoz JG_CONFIRM_PRODUCTION=yes szükséges.");
        const mode = (process.env.JG_RUNTIME_PASSWORD_MODE || "scram") as PasswordMode;
        if (!PASSWORD_MODES.includes(mode)) throw new Error("Érvénytelen JG_RUNTIME_PASSWORD_MODE (scram vagy plaintext).");
        // Nem helyi adatbázisnál a tiszta jelszó csak ellenőrzött TLS-sel küldhető (a művelet előtt a kapcsolat titkosítása ellenőrzött).
        await provisionRuntimeRole(db, { name, password: pw, passwordMode: mode, requireTls: Boolean(cfg.databaseUrl) && !isLocalHost(dbHost(cfg.databaseUrl as string)) });
        console.log(`Jelszó-mód: ${mode}.`);
        console.log(`Futási szerepkör kész: ${name}. A DATABASE_URL felhasználóját/jelszavát a futtatási környezetben erre kell cserélni; a migrációs URL külön marad.`);
        break;
      }
      case "customer:list-removed": {
        for (const r of await listRemovedCustomers(db)) console.log(`${r.id}\t${r.type}\t${r.deleted_at}\t${r.deleted_by}`);
        break;
      }
      case "customer:restore": {
        const [customerId, operator] = args;
        if (!customerId || !operator) throw new Error("Használat: customer:restore <ügyfél-azonosító> <üzemeltető e-mail>");
        const r = await restoreCustomer(db, customerId, operator);
        console.log(r.restored ? `Visszaállítva: ${customerId}` : `Nincs ilyen eltávolított ügyfél: ${customerId}`);
        break;
      }
      case "backup": {
        const file = args[0];
        if (!file) throw new Error("Használat: JG_OPERATOR=<üzemeltető> JG_BACKUP_KEY_FILE=<kulcsfájl> backup <fájl>");
        const operator = validateOperator(process.env.JG_OPERATOR);
        checkBackupTarget(file);
        const key = loadBackupKey(process.env, file);
        await assertOperatorConnection(db);
        const b = await exportBackup(db, env);
        const sealed = sealBackup(b, key, { databaseFingerprint: databaseFingerprint(cfg.databaseUrl ?? `pglite:${cfg.pgliteDir}`) });
        writeFileSync(file, sealed, { mode: 0o600, flag: "wx" });
        const contentSha256 = sha256(Buffer.from(JSON.stringify(b), "utf8"));
        await db.system((tx) => opsLog(tx, { operation: "backup.create", environment: env, operator, detail: { migration: b.migration, rows: Object.values(b.counts).reduce((x, y) => x + y, 0), contentSha256 } }));
        console.log(`Titkosított mentés kész: ${file} · ${Object.values(b.counts).reduce((x, y) => x + y, 0)} sor · tartalom SHA-256 ${contentSha256}`);
        console.log("A fájl titkosítva személyes adatot és jelszó-hash-eket tartalmaz: hozzáférés-védett helyen, a kulcstól elkülönítve tárold. Ellenőrzés: backup:verify.");
        break;
      }
      case "restore:check":
      case "restore": {
        const file = args[0];
        if (!file) throw new Error(`Használat: ${cmd} <fájl>`);
        if (!existsSync(file)) throw new Error("A mentésfájl nem található.");
        const operator = validateOperator(process.env.JG_OPERATOR);
        const { backup, contentSha256 } = loadBackupFile(file, env);
        checkBackupShape(backup, env);
        await assertOperatorConnection(db);
        const schema = await checkSchema(db, env);
        if (!schema.ok) throw new Error(`A céladatbázis nincs a jelenlegi sémán (${schema.reason}). Előbb: npm run db -- migrate`);
        await db.system((tx) => assertEmptyTarget(tx));
        if (cmd === "restore:check") {
          console.log(`Visszaállítás előfeltételei rendben: integritás ${contentSha256 ? "ellenőrizve" : "NEM ellenőrizhető (titkosítatlan régi mentés)"}, séma ${backup.migration} -> ${LATEST_MIGRATION}, környezet ${env}, a cél üres.`);
          break;
        }
        restoreGate(env, process.env, contentSha256);
        const counts = await restoreBackup(db, backup, env);
        await db.system((tx) => opsLog(tx, { operation: "restore.complete", environment: env, operator, detail: { migration: backup.migration, rows: Object.values(counts).reduce((x, y) => x + y, 0), contentSha256, sealed: contentSha256 !== null } }));
        console.log(`Visszaállítva üres adatbázisba, tartalom-ellenőrzéssel · sorok: ${JSON.stringify(counts)}`);
        break;
      }
      default:
        throw new Error("Ismeretlen parancs. Elérhető: status, migrate, runtime-role:provision, user:create, user:set-password, user:deactivate, user:activate, permission:grant, permission:revoke, permission:list, backup, backup:keygen, backup:inspect, backup:verify, restore:check, restore, customer:list-removed, customer:restore");
    }
  } finally {
    await db.close();
  }
}

main().catch((e: Error) => {
  console.error(`Hiba: ${e.message}`);
  process.exit(1);
});
