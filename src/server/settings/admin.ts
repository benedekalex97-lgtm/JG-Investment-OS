import { z } from "zod";
import type { Tx } from "../db/types";
import { CRM_PERMISSIONS, isCrmPermission, type CrmPermission } from "../data/permissions";
import { CONFLICT_MESSAGE } from "./catalog";

/**
 * Felhasználók és jogosultságok (v1.1, SET-003) és a beállítási változásnapló (SET-008).
 *
 * A jogosultság-módosítás kizárólag a szűk, auditált `app_admin_set_permission()` adatbázis-függvényen át történik (0007): az
 * alkalmazás szerepkörének nincs írási joga a `user_permissions` táblára, és a tulajdonosi kapcsolatot a kérés nem használja.
 * A függvény maga is frissen ellenőrzi a hívó jogát, az engedélyezőlistát, az önjogosítást és az utolsó felhasználókezelő admin
 * eltávolítását; a változást a tábla triggere naplózza. Egy kérés több változtatása egy tranzakcióban, mindent vagy semmit alapon fut.
 */
export interface AdminUser {
  id: string; name: string; email: string; active: boolean; createdAt: string; lastLoginAt: string | null; permissions: CrmPermission[];
}

const iso = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function listAdminUsers(tx: Tx): Promise<AdminUser[]> {
  const rows = await tx.query<Record<string, unknown>>("select * from app_admin_users()");
  return rows.map((r) => ({
    id: String(r.id), name: String(r.name), email: String(r.email), active: r.active === true, createdAt: iso(r.created_at) as string,
    lastLoginAt: iso(r.last_login_at), permissions: (Array.isArray(r.permissions) ? (r.permissions as string[]) : []).filter(isCrmPermission),
  }));
}

const permission = z.string().max(80);
export const permissionChangeBody = z.object({
  userId: z.string().min(1).max(120),
  /** A kliens által látott jelenlegi jogok: eltérés esetén (közben más módosított) 409, nincs írás. */
  expected: z.array(permission).max(20),
  grant: z.array(permission).max(20).default([]),
  revoke: z.array(permission).max(20).default([]),
}).strict();

/** Az adatbázis-függvény hibakódjai -> felhasználói üzenet. */
const FN_ERRORS: Record<string, { status: 400 | 403 | 404 | 409; message: string }> = {
  "jg:forbidden": { status: 403, message: "Ehhez a művelethez nincs jogosultságod." },
  "jg:self": { status: 403, message: "A saját jogosultságaidat nem módosíthatod. Kérj meg egy másik felhasználókezelő admint." },
  "jg:invalid_permission": { status: 400, message: "Ez a jogosultság a felületen nem osztható ki." },
  "jg:no_user": { status: 404, message: "A felhasználó nem található." },
  "jg:inactive_user": { status: 400, message: "Letiltott felhasználónak nem osztható ki új jogosultság." },
  "jg:last_admin": { status: 409, message: "Az utolsó felhasználókezelő admin jogosultsága nem vonható vissza: a jogosultságkezelés elérhetetlenné válna." },
};
export class PermissionChangeError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string) {
    super(message);
  }
}
export function mapPermissionError(e: unknown): PermissionChangeError | null {
  const m = String((e as { message?: string })?.message ?? "");
  const hit = Object.keys(FN_ERRORS).find((k) => m.includes(k));
  return hit ? new PermissionChangeError(FN_ERRORS[hit].status, hit.slice(3), FN_ERRORS[hit].message) : null;
}

export interface PermissionChangeResult { user: AdminUser; changed: { permission: string; result: string }[] }

/**
 * Egy felhasználó jogainak módosítása (előnézet utáni megerősítés). Ellenőrzés: ismert jogok, nincs ellentmondó (egyszerre kiosztott és
 * visszavont) jog, nem önmaga, a kliens által látott állapot még érvényes. A tényleges írás és a végső szabályok az adatbázis-függvényben.
 */
export async function changePermissions(tx: Tx, callerId: string, body: unknown): Promise<PermissionChangeResult> {
  const parsed = permissionChangeBody.safeParse(body);
  if (!parsed.success) throw new PermissionChangeError(400, "invalid", "Érvénytelen kérés.");
  const d = parsed.data;
  const unknown = [...d.grant, ...d.revoke, ...d.expected].filter((p) => !isCrmPermission(p));
  if (unknown.length) throw new PermissionChangeError(400, "invalid_permission", FN_ERRORS["jg:invalid_permission"].message);
  if (d.grant.some((p) => d.revoke.includes(p)) || new Set(d.grant).size !== d.grant.length || new Set(d.revoke).size !== d.revoke.length) {
    throw new PermissionChangeError(400, "invalid", "Érvénytelen kérés.");
  }
  if (!d.grant.length && !d.revoke.length) throw new PermissionChangeError(400, "invalid", "Nincs módosítás.");
  if (d.userId === callerId) throw new PermissionChangeError(403, "self", FN_ERRORS["jg:self"].message);
  // A sorrend determinisztikus: előbb kiosztás, utána visszavonás (az utolsó-admin szabály így a végső állapotot nézi).
  await tx.query("select pg_advisory_xact_lock(hashtextextended('jg.user_permissions', 0))");
  const users = await listAdminUsers(tx);
  const target = users.find((u) => u.id === d.userId);
  if (!target) throw new PermissionChangeError(404, "no_user", FN_ERRORS["jg:no_user"].message);
  const same = (a: string[], b: string[]) => a.length === b.length && [...a].sort().every((x, i) => x === [...b].sort()[i]);
  if (!same(target.permissions, d.expected)) throw new PermissionChangeError(409, "conflict", CONFLICT_MESSAGE);
  const changed: PermissionChangeResult["changed"] = [];
  for (const [list, grant] of [[d.grant, true], [d.revoke, false]] as const) {
    for (const p of CRM_PERMISSIONS.filter((x) => list.includes(x))) {
      try {
        const [r] = await tx.query<{ r: string }>("select app_admin_set_permission($1, $2, $3) as r", [d.userId, p, grant]);
        changed.push({ permission: p, result: r.r });
      } catch (e) {
        throw mapPermissionError(e) ?? e;
      }
    }
  }
  const after = (await listAdminUsers(tx)).find((u) => u.id === d.userId) as AdminUser;
  return { user: after, changed };
}

/** Elutasított adminisztratív kísérlet naplózása (a hívó nevében; saját, külön tranzakcióban hívandó, hogy megmaradjon). */
export async function logRejection(tx: Tx, action: string, entityType: "pipeline_status" | "task_type" | "task_input" | "user_permission" | "settings", entityKey: string, reason: string) {
  await tx.query("select app_settings_audit_reject($1, $2, $3, $4)", [action, entityType, entityKey.slice(0, 200), reason.slice(0, 200)]);
}

// ------------------------------------------------------------------------- változásnapló

export interface AuditEntry {
  id: number; at: string; via: "app" | "cli"; actorId: string | null; actorName: string; action: string; entityType: string; entityKey: string;
  entityLabel?: string; outcome: "success" | "rejected"; changes: Record<string, { from: unknown; to: unknown }> | null; reason: string | null;
}

export const auditQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  entityType: z.enum(["pipeline_status", "task_type", "task_input", "user_permission", "settings"]).optional(),
}).strict();

/**
 * Napló olvasása (csak crm.settings.audit.read joggal - az RLS is ezt követeli). A `changes` csak konfigurációs értékeket tartalmaz
 * (megnevezés, szín, sorrend, aktív állapot, megjegyzés-szabály) vagy jogosultság-azonosítót; ügyféladat nincs benne.
 */
export async function listAudit(tx: Tx, q: z.infer<typeof auditQuery>, users: { id: string; name: string }[]): Promise<{ entries: AuditEntry[]; nextBefore: number | null }> {
  const params: unknown[] = [q.limit + 1];
  let where = "";
  if (q.before) { params.push(q.before); where += ` and id < $${params.length}`; }
  if (q.entityType) { params.push(q.entityType); where += ` and entity_type = $${params.length}`; }
  const rows = await tx.query<Record<string, unknown>>(`select * from settings_audit where true${where} order by id desc limit $1`, params);
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const page = rows.slice(0, q.limit);
  const labels = new Map<string, string>();
  for (const [type, table] of [["pipeline_status", "crm_pipeline_statuses"], ["task_type", "crm_task_types"], ["task_input", "crm_task_input_options"]] as const) {
    for (const r of await tx.query<{ key: string; label: string }>(`select key, label from ${table}`)) labels.set(`${type}:${r.key}`, r.label);
  }
  return {
    entries: page.map((r) => {
      const actorId = (r.actor_user_id as string | null) ?? null;
      const type = String(r.entity_type);
      const key = String(r.entity_key);
      const permUser = type === "user_permission" ? key.split(":")[0] : undefined;
      return {
        id: Number(r.id), at: iso(r.at) as string, via: r.via as "app" | "cli", actorId,
        actorName: actorId ? (nameOf.get(actorId) ?? actorId) : `Üzemeltető (CLI): ${String(r.actor_label ?? "")}`,
        action: String(r.action), entityType: type, entityKey: key,
        ...(labels.has(`${type}:${key}`) ? { entityLabel: labels.get(`${type}:${key}`) } : {}),
        ...(permUser ? { entityLabel: `${nameOf.get(permUser) ?? permUser} · ${key.slice(permUser.length + 1)}` } : {}),
        outcome: r.outcome as "success" | "rejected",
        changes: (r.changes as AuditEntry["changes"]) ?? null, reason: (r.reason as string | null) ?? null,
      };
    }),
    nextBefore: rows.length > q.limit ? Number(page[page.length - 1].id) : null,
  };
}
