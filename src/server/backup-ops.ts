import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { JgEnv } from "./config";
import { parseKey } from "./backup-crypto";

/**
 * Üzemeltetői mentés/visszaállítás védőszabályai (v1.0, CRM-019 / CRM-020) - a CLI hívja, tisztán tesztelhető függvények.
 */

/** Igaz, ha az útvonal egy Git munkakönyvtáron belül van (a mentés soha nem kerülhet verziókezelésbe). */
export function insideGitRepo(path: string): boolean {
  let dir = dirname(resolve(path));
  for (;;) {
    if (existsSync(resolve(dir, ".git"))) return true;
    const parent = dirname(dir);
    if (parent === dir) return false;
    dir = parent;
  }
}

/** A mentési kulcs betöltése; a kulcsfájl nem lehet a mentéssel azonos könyvtárban, és nem lehet mások által olvasható. */
export function loadBackupKey(vars: Record<string, string | undefined>, backupFile: string): Buffer {
  if (vars.JG_BACKUP_KEY && vars.JG_BACKUP_KEY_FILE) throw new Error("A JG_BACKUP_KEY és a JG_BACKUP_KEY_FILE közül csak az egyik adható meg.");
  if (vars.JG_BACKUP_KEY_FILE) {
    const keyFile = resolve(vars.JG_BACKUP_KEY_FILE);
    if (dirname(keyFile) === dirname(resolve(backupFile))) throw new Error("A mentési kulcs nem tárolható a mentésfájllal azonos könyvtárban.");
    if (insideGitRepo(keyFile)) throw new Error("A mentési kulcs nem lehet Git munkakönyvtárban.");
    if (process.platform !== "win32" && (statSync(keyFile).mode & 0o077) !== 0) throw new Error("A kulcsfájl jogosultsága túl tág (csak a tulajdonos olvashatja: chmod 600).");
    return parseKey(readFileSync(keyFile, "utf8"));
  }
  if (vars.JG_BACKUP_KEY) return parseKey(vars.JG_BACKUP_KEY);
  throw new Error("Hiányzó mentési kulcs: JG_BACKUP_KEY vagy JG_BACKUP_KEY_FILE szükséges. A titkosítatlan mentés nem engedett.");
}

/** Mentési célfájl ellenőrzése: nem létező fájl, Git munkakönyvtáron kívül. */
export function checkBackupTarget(file: string): void {
  if (existsSync(file)) throw new Error("A célfájl már létezik: meglévő mentést nem írunk felül.");
  if (insideGitRepo(file)) throw new Error("A mentés nem írható Git munkakönyvtárba (személyes adatot tartalmaz). Válassz védett, verziókezelésen kívüli helyet.");
}

/**
 * Visszaállítási kapu. Production célkörnyezetbe a visszaállítás csak kifejezett, a KONKRÉT mentéshez kötött tulajdonosi jóváhagyással
 * indulhat: JG_CONFIRM_PRODUCTION=yes ÉS JG_RESTORE_PRODUCTION_APPROVAL=<a mentés tartalmi SHA-256 lenyomata> ÉS az üzemeltető
 * azonosítása. A célnak ilyenkor is üresnek, frissen migráltnak kell lennie (a meglévő adat felülírása nem lehetséges).
 * A v1.0 fejlesztési feladatban Production visszaállítás NEM történik.
 */
export function restoreGate(env: JgEnv, vars: Record<string, string | undefined>, contentSha256: string | null): void {
  if (env !== "production") return;
  if (vars.JG_CONFIRM_PRODUCTION !== "yes") throw new Error("Éles visszaállításhoz JG_CONFIRM_PRODUCTION=yes szükséges (külön tulajdonosi jóváhagyás után).");
  if (!contentSha256) throw new Error("Éles környezetbe csak titkosított, integritásvédett mentés állítható vissza.");
  if (vars.JG_RESTORE_PRODUCTION_APPROVAL !== contentSha256) throw new Error("Éles visszaállításhoz a jóváhagyott mentés tartalmi lenyomata szükséges: JG_RESTORE_PRODUCTION_APPROVAL=<SHA-256> (lásd backup:inspect).");
}

/** Titkosítatlan (v0.6-v0.9 JSON) mentés visszaállítása csak kifejezett engedéllyel és nem éles környezetben. */
export function plaintextGate(env: JgEnv, vars: Record<string, string | undefined>): void {
  if (env === "production") throw new Error("Éles környezetbe titkosítatlan mentés nem állítható vissza.");
  if (vars.JG_RESTORE_ALLOW_PLAINTEXT !== "yes") throw new Error("Ez titkosítatlan (régi formátumú) mentés: integritása nem ellenőrizhető. Visszaállításához JG_RESTORE_ALLOW_PLAINTEXT=yes szükséges.");
}
