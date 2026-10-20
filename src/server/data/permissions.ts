import type { Db, Tx } from "../db/types";
import { normalizeEmail } from "../auth/service";
import { opsLog } from "../ops-log";
import { assertDbEnvironment } from "../db/environment";
import type { JgEnv } from "../config";

/**
 * Műveletszintű jogosultságok (v1.0 CRM-018: adatmozgatás; v1.1 SET-002: adminisztráció).
 *
 * - A jog minden érzékeny kérésnél FRISSEN, a kérés saját (RLS-es, `jg_app`) tranzakciójában ellenőrződik az adatbázisból
 *   (`app_has_permission`, 0005/0007): visszavonás vagy a felhasználó letiltása után a következő kérés már elutasított, a meglévő
 *   munkamenettől függetlenül. Nincs munkamenetben vagy kliensen tárolt jogosultság.
 * - Fail-closed: ismeretlen jog, hiányzó vagy visszavont sor, inaktív felhasználó vagy bármilyen hiba = nincs jog.
 * - A régi `users.role = 'admin'` mező NEM ad jogot; senki nem kap automatikusan jogot.
 * - A teljes adatbázismentés/-visszaállítás, migráció, infrastruktúra és titkok NEM CRM-jogosultságok: kizárólag a tulajdonosi
 *   adatbázis-kapcsolattal és a mentési kulccsal rendelkező üzemeltető végezheti a CLI-ből (lásd backup.ts). HTTP-n nem érhetők el,
 *   és a felületen sem oszthatók ki (az adatbázis-függvény engedélyezőlistája csak az alábbi hat jogot ismeri).
 */
export const DATA_PERMISSIONS = ["crm.customer.import", "crm.customer.export", "crm.import.history.read"] as const;
export type DataPermission = (typeof DATA_PERMISSIONS)[number];
/** v1.1 adminisztratív jogok: CRM-beállítások kezelése, felhasználói jogok kezelése, beállítási változásnapló olvasása. */
export const ADMIN_PERMISSIONS = ["crm.settings.manage", "crm.users.manage", "crm.settings.audit.read"] as const;
export type AdminPermission = (typeof ADMIN_PERMISSIONS)[number];
export const CRM_PERMISSIONS = [...DATA_PERMISSIONS, ...ADMIN_PERMISSIONS] as const;
export type CrmPermission = (typeof CRM_PERMISSIONS)[number];
export const isDataPermission = (s: string): s is DataPermission => (DATA_PERMISSIONS as readonly string[]).includes(s);
export const isCrmPermission = (s: string): s is CrmPermission => (CRM_PERMISSIONS as readonly string[]).includes(s);

export const PERMISSION_LABELS: Record<CrmPermission, string> = {
  "crm.customer.import": "Ügyféladat-import (Excel/CSV)",
  "crm.customer.export": "Ügyféllista-export (Excel/CSV)",
  "crm.import.history.read": "Importelőzmények megtekintése",
  "crm.settings.manage": "CRM-beállítások kezelése (Pipeline, feladattípusok, Input-opciók)",
  "crm.users.manage": "Felhasználók és jogosultságok kezelése",
  "crm.settings.audit.read": "Beállítási változásnapló megtekintése",
};

/** A kérés tranzakciójában (asUser) ellenőrzi a jogot. Bármilyen hiba esetén hamis. */
export async function hasPermission(tx: Tx, permission: CrmPermission): Promise<boolean> {
  if (!isCrmPermission(permission)) return false;
  try {
    const rows = await tx.query<{ ok: boolean }>("select app_has_permission($1) as ok", [permission]);
    return rows[0]?.ok === true;
  } catch {
    return false;
  }
}

/** A felhasználó aktuális CRM-jogai (a felület navigációjához; a szerver minden műveletnél újra ellenőriz). */
export async function permissionsOf(db: Db, userId: string): Promise<CrmPermission[]> {
  try {
    return await db.asUser(userId, async (tx) => {
      const rows = await tx.query<{ p: string; ok: boolean }>("select p, app_has_permission(p) as ok from unnest($1::text[]) as p", [[...CRM_PERMISSIONS]]);
      return CRM_PERMISSIONS.filter((p) => rows.some((r) => r.p === p && r.ok === true));
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
  if (!isCrmPermission(input.permission)) throw new Error(`Ismeretlen jogosultság. Elérhető: ${CRM_PERMISSIONS.join(", ")}`);
  const operator = validateOperator(input.operator);
  return db.system(async (tx) => {
    // Az adatbázis saját környezetjelölése a módosítás előtt (fail-closed).
    await assertDbEnvironment(tx, input.env);
    // A beállítási változásnapló (0007 trigger) az üzemeltető azonosítóját is rögzíti.
    await tx.query("select set_config('jg.operator', $1, true)", [operator]);
    const users = await tx.query<{ id: string }>("select id from users where email = $1 and active", [normalizeEmail(input.email)]);
    if (!users.length) throw new Error("Nincs ilyen aktív felhasználó.");
    // Új kiosztás, vagy egy korábban visszavont jog újbóli kiosztása (a sor és a története megmarad).
    const rows = await tx.query(
      `insert into user_permissions (user_id, permission, granted_by) values ($1, $2, $3)
       on conflict (user_id, permission) do update set granted_at = now(), granted_by = excluded.granted_by, revoked_at = null, revoked_by = null
       where user_permissions.revoked_at is not null returning user_id`,
      [users[0].id, input.permission, operator],
    );
    if (rows.length) await opsLog(tx, { operation: "permission.grant", environment: input.env, operator, detail: { userId: users[0].id, permission: input.permission } });
    return { granted: rows.length > 0, userId: users[0].id };
  });
}

/**
 * Jog visszavonása: azonnal hat (a következő kérés már elutasított), a munkamenet érvényességétől függetlenül. v1.1-től a sor nem
 * törlődik, hanem visszavont jelölést kap (ki, mikor) - a kiosztás története megmarad.
 */
export async function revokePermission(db: Db, input: { email: string; permission: string; operator: string; env: JgEnv }): Promise<{ revoked: boolean }> {
  if (!isCrmPermission(input.permission)) throw new Error(`Ismeretlen jogosultság. Elérhető: ${CRM_PERMISSIONS.join(", ")}`);
  const operator = validateOperator(input.operator);
  return db.system(async (tx) => {
    await assertDbEnvironment(tx, input.env);
    await tx.query("select set_config('jg.operator', $1, true)", [operator]);
    const users = await tx.query<{ id: string }>("select id from users where email = $1", [normalizeEmail(input.email)]);
    if (!users.length) throw new Error("Nincs ilyen felhasználó.");
    const rows = await tx.query(
      "update user_permissions set revoked_at = now(), revoked_by = $3 where user_id = $1 and permission = $2 and revoked_at is null returning user_id",
      [users[0].id, input.permission, operator],
    );
    if (rows.length) await opsLog(tx, { operation: "permission.revoke", environment: input.env, operator, detail: { userId: users[0].id, permission: input.permission } });
    return { revoked: rows.length > 0 };
  });
}

/** A kiosztott (vissza nem vont) jogok listája (e-mail, jog, időpont, kiosztó) az üzemeltetőnek. */
export async function listPermissions(db: Db): Promise<{ email: string; permission: string; granted_at: string; granted_by: string; active: boolean }[]> {
  return db.system((tx) => tx.query(
    "select u.email, up.permission, up.granted_at::text as granted_at, up.granted_by, u.active from user_permissions up join users u on u.id = up.user_id where up.revoked_at is null order by u.email, up.permission",
  ));
}
