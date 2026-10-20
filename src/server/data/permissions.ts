import type { Db, Tx } from "../db/types";
import { normalizeEmail } from "../auth/service";
import { opsLog } from "../ops-log";
import type { JgEnv } from "../config";

/**
 * Műveletszintű adatmozgatási jogosultságok (v1.0, CRM-018).
 *
 * - A jog minden érzékeny kérésnél FRISSEN, a kérés saját (RLS-es, `jg_app`) tranzakciójában ellenőrződik az adatbázisból
 *   (`app_has_permission`, 0005): visszavonás vagy a felhasználó letiltása után a következő kérés már elutasított, a meglévő
 *   munkamenettől függetlenül. Nincs munkamenetben vagy kliensen tárolt jogosultság.
 * - Fail-closed: ismeretlen jog, hiányzó sor, inaktív felhasználó vagy bármilyen hiba = nincs jog.
 * - A teljes adatbázismentés/-visszaállítás NEM CRM-jogosultság: kizárólag a tulajdonosi adatbázis-kapcsolattal és a mentési kulccsal
 *   rendelkező üzemeltető végezheti a CLI-ből (lásd backup.ts). HTTP-n nem érhető el.
 */
export const DATA_PERMISSIONS = ["crm.customer.import", "crm.customer.export", "crm.import.history.read"] as const;
export type DataPermission = (typeof DATA_PERMISSIONS)[number];
export const isDataPermission = (s: string): s is DataPermission => (DATA_PERMISSIONS as readonly string[]).includes(s);

export const PERMISSION_LABELS: Record<DataPermission, string> = {
  "crm.customer.import": "Ügyféladat-import (Excel/CSV)",
  "crm.customer.export": "Ügyféllista-export (Excel/CSV)",
  "crm.import.history.read": "Importelőzmények megtekintése",
};

/** A kérés tranzakciójában (asUser) ellenőrzi a jogot. Bármilyen hiba esetén hamis. */
export async function hasPermission(tx: Tx, permission: DataPermission): Promise<boolean> {
  if (!isDataPermission(permission)) return false;
  try {
    const rows = await tx.query<{ ok: boolean }>("select app_has_permission($1) as ok", [permission]);
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/** A felhasználó aktuális adatmozgatási jogai (a felület navigációjához; a szerver minden műveletnél újra ellenőriz). */
export async function permissionsOf(db: Db, userId: string): Promise<DataPermission[]> {
  try {
    return await db.asUser(userId, async (tx) => {
      const out: DataPermission[] = [];
      for (const p of DATA_PERMISSIONS) if (await hasPermission(tx, p)) out.push(p);
      return out;
    });
  } catch {
    return [];
  }
}

// ------------------------------------------------------------------ Üzemeltetői kiosztás (tulajdonosi CLI)

const OPERATOR_RE = /^[\p{L}\p{N} .@_+-]{2,100}$/u;
export function validateOperator(operator: string | undefined): string {
  const o = (operator ?? "").trim();
  if (!OPERATOR_RE.test(o)) throw new Error("Az üzemeltető azonosítója kötelező (JG_OPERATOR: 2-100 karakter, betű/szám/szóköz/.@_+-).");
  return o;
}

/**
 * Jog kiosztása kifejezetten megnevezett, AKTÍV felhasználónak. Csak a tulajdonosi (`system`) kapcsolaton fut (üzemeltetői CLI);
 * a művelet az üzemeltetői naplóba kerül. Idempotens: meglévő jognál nem ír újra.
 */
export async function grantPermission(db: Db, input: { email: string; permission: string; operator: string; env: JgEnv }): Promise<{ granted: boolean; userId: string }> {
  if (!isDataPermission(input.permission)) throw new Error(`Ismeretlen jogosultság. Elérhető: ${DATA_PERMISSIONS.join(", ")}`);
  const operator = validateOperator(input.operator);
  return db.system(async (tx) => {
    const users = await tx.query<{ id: string }>("select id from users where email = $1 and active", [normalizeEmail(input.email)]);
    if (!users.length) throw new Error("Nincs ilyen aktív felhasználó.");
    const rows = await tx.query("insert into user_permissions (user_id, permission, granted_by) values ($1, $2, $3) on conflict do nothing returning user_id", [users[0].id, input.permission, operator]);
    if (rows.length) await opsLog(tx, { operation: "permission.grant", environment: input.env, operator, detail: { userId: users[0].id, permission: input.permission } });
    return { granted: rows.length > 0, userId: users[0].id };
  });
}

/** Jog visszavonása: azonnal hat (a következő kérés már elutasított), a munkamenet érvényességétől függetlenül. */
export async function revokePermission(db: Db, input: { email: string; permission: string; operator: string; env: JgEnv }): Promise<{ revoked: boolean }> {
  if (!isDataPermission(input.permission)) throw new Error(`Ismeretlen jogosultság. Elérhető: ${DATA_PERMISSIONS.join(", ")}`);
  const operator = validateOperator(input.operator);
  return db.system(async (tx) => {
    const users = await tx.query<{ id: string }>("select id from users where email = $1", [normalizeEmail(input.email)]);
    if (!users.length) throw new Error("Nincs ilyen felhasználó.");
    const rows = await tx.query("delete from user_permissions where user_id = $1 and permission = $2 returning user_id", [users[0].id, input.permission]);
    if (rows.length) await opsLog(tx, { operation: "permission.revoke", environment: input.env, operator, detail: { userId: users[0].id, permission: input.permission } });
    return { revoked: rows.length > 0 };
  });
}

/** A kiosztott jogok listája (azonosító, e-mail, jog, időpont, kiosztó) az üzemeltetőnek. */
export async function listPermissions(db: Db): Promise<{ email: string; permission: string; granted_at: string; granted_by: string; active: boolean }[]> {
  return db.system((tx) => tx.query(
    "select u.email, up.permission, up.granted_at::text as granted_at, up.granted_by, u.active from user_permissions up join users u on u.id = up.user_id order by u.email, up.permission",
  ));
}
