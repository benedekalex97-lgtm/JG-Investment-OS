/**
 * Adatbázis-kezelő parancssori eszköz (migráció, felhasználók, mentés/visszaállítás). Soha nem seedel, nem reseteli az adatbázist,
 * és nem töröl üzleti adatot. A kapcsolat a környezeti változókból jön (lásd docs/V0.6-PERSISTENCE.md); titkot nem naplóz.
 *
 * Használat: npm run db -- <parancs>
 *   status | migrate | user:create <email> <név> | user:set-password <email> | user:deactivate <email> | user:activate <email>
 *   backup <fájl> | restore <fájl>
 *   customer:list-removed | customer:restore <ügyfél-azonosító> <üzemeltető e-mail>   (CRM-006: logikailag eltávolított ügyfél visszaállítása)
 *   runtime-role:provision <szerepkör-név>   (legkisebb jogosultságú futási szerepkör; jelszó: JG_RUNTIME_PASSWORD;
 *       JG_RUNTIME_PASSWORD_MODE=scram (alapértelmezett) | plaintext (Neon: csak tiszta szöveges jelszót fogad el; TLS kötelező))
 * A jelszót a JG_USER_PASSWORD környezeti változó vagy interaktív (rejtett) bekérés adja - parancssori argumentum nem.
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { createInterface } from "node:readline";
import { listRemovedCustomers, restoreCustomer } from "../src/server/admin";
import { exportBackup, restoreBackup, type Backup } from "../src/server/backup";
import { checkConfig, dbHost, isLocalHost, readConfig, type JgEnv } from "../src/server/config";
import { checkSchema, LATEST_MIGRATION, migrate } from "../src/server/db/migrate";
import { createPgDb } from "../src/server/db/pg-driver";
import { createPgliteDb } from "../src/server/db/pglite-driver";
import { createUser, setActive, setPassword } from "../src/server/auth/service";
import { PASSWORD_MODES, provisionRuntimeRole, type PasswordMode } from "../src/server/db/runtime-role";

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

async function main() {
  const [cmd, ...args] = process.argv.slice(2);
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
        if (!file) throw new Error("Használat: backup <fájl>");
        if (existsSync(file)) throw new Error("A célfájl már létezik: meglévő mentést nem írunk felül.");
        const b = await exportBackup(db, env);
        writeFileSync(file, JSON.stringify(b), { mode: 0o600, flag: "wx" });
        console.log(`Mentés kész: ${file} · sorok: ${JSON.stringify(b.counts)}\nFIGYELEM: a fájl személyes adatot és jelszó-hash-eket tartalmaz; titkosítva, védett helyen tárold, ne kerüljön verziókezelésbe.`);
        break;
      }
      case "restore": {
        const file = args[0];
        if (!file) throw new Error("Használat: restore <fájl>");
        if (env === "production" && process.env.JG_CONFIRM_PRODUCTION !== "yes") throw new Error("Éles visszaállításhoz JG_CONFIRM_PRODUCTION=yes szükséges.");
        const counts = await restoreBackup(db, JSON.parse(readFileSync(file, "utf8")) as Backup, env);
        console.log(`Visszaállítva üres adatbázisba · sorok: ${JSON.stringify(counts)}`);
        break;
      }
      default:
        throw new Error("Ismeretlen parancs. Elérhető: status, migrate, runtime-role:provision, user:create, user:set-password, user:deactivate, user:activate, backup, restore, customer:list-removed, customer:restore");
    }
  } finally {
    await db.close();
  }
}

main().catch((e: Error) => {
  console.error(`Hiba: ${e.message}`);
  process.exit(1);
});
