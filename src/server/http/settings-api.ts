import type { AuthUser } from "../auth/service";
import { listUsers } from "../auth/service";
import type { Db, Tx } from "../db/types";
import { features } from "../features";
import { hasPermission, permissionsOf, PERMISSION_LABELS, CRM_PERMISSIONS, ADMIN_PERMISSIONS, type CrmPermission } from "../data/permissions";
import { CATALOG_KINDS, createCatalogItem, listCatalog, reorderCatalog, SettingsError, SPECS, updateCatalogItem, type CatalogKind } from "../settings/catalog";
import { auditQuery, changePermissions, listAdminUsers, listAudit, logRejection, PermissionChangeError } from "../settings/admin";
import { csrfProblem, readBodyLimited } from "./guards";

/**
 * Adminisztrációs végpontok (v1.1): /api/settings/*. Mindegyik:
 *  - bejelentkezést igényel (a hívó api.ts már ellenőrizte) ÉS műveletspecifikus jogot, amelyet a szerver a kérés saját RLS-es
 *    tranzakciójában FRISSEN ellenőriz (visszavonás azonnal hat); a frontend nem biztonsági határ;
 *  - módosító kérésnél (POST/PATCH) azonos eredetet (CSRF) és JSON tartalomtípust, korlátozott törzsméretet;
 *  - érzékeny adatot nem gyorsítótáraz (no-store), belső SQL-hibát nem ad ki;
 *  - minden sikeres konfigurációs változás az adatbázis triggerén át ugyanabban a tranzakcióban naplózódik; az elutasított módosítási
 *    kísérletek (jogosultság hiánya, tiltott jogosultság-változás) külön, véglegesített naplóbejegyzést kapnak.
 * A meglévő v1.0 import/export végpontok (/api/data/*) változatlanok, és továbbra is a saját adatkezelési jogaikat követelik meg.
 */
const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE } });

const MSG = {
  forbidden: "Ehhez a művelethez nincs jogosultságod.",
  bad: "Érvénytelen kérés.",
  failed: "A módosítás nem sikerült.",
};
const MAX_BODY = 16 * 1024;

class Denied extends Error {}
const DENIED = Symbol("denied");

type Method = "GET" | "POST" | "PATCH";
interface Route { methods: Method[]; permission: CrmPermission | "any_settings" }

const catalogRoutes = Object.fromEntries(CATALOG_KINDS.flatMap((k) => [
  [`settings/${k}`, { methods: ["GET", "POST", "PATCH"], permission: "crm.settings.manage" }],
  [`settings/${k}/order`, { methods: ["PATCH"], permission: "crm.settings.manage" }],
])) as Record<string, Route>;

const ROUTES: Record<string, Route> = {
  "settings/overview": { methods: ["GET"], permission: "any_settings" },
  ...catalogRoutes,
  "settings/users": { methods: ["GET"], permission: "crm.users.manage" },
  "settings/users/permissions": { methods: ["PATCH"], permission: "crm.users.manage" },
  "settings/audit": { methods: ["GET"], permission: "crm.settings.audit.read" },
};

const entityOf = (path: string) =>
  path.startsWith("settings/pipeline") ? "pipeline_status" as const
    : path.startsWith("settings/task-types") ? "task_type" as const
      : path.startsWith("settings/task-inputs") ? "task_input" as const
        : path.startsWith("settings/users") ? "user_permission" as const : "settings" as const;

const logError = (where: string, e: unknown) => {
  const x = e as { code?: string; constraint?: string; name?: string };
  console.error(`[jg-os] ${where}:`, x?.code ?? x?.name ?? "hiba", x?.constraint ?? "");
};

/**
 * A kérés saját tranzakciójában friss jogellenőrzés; hiányzó jognál a módosítási kísérlet elutasítása naplózódik és a tranzakció
 * véglegesítődik (nem gördül vissza), majd Denied hiba keletkezik.
 */
async function withPermission<T>(db: Db, user: AuthUser, route: Route, path: string, method: Method, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const r = await db.asUser(user.id, async (tx) => {
    let ok = false;
    for (const p of route.permission === "any_settings" ? CRM_PERMISSIONS : [route.permission]) if (!ok) ok = await hasPermission(tx, p);
    if (!ok) {
      if (method !== "GET") await logRejection(tx, "settings.denied", entityOf(path), path, `Hiányzó jogosultság: ${route.permission}`);
      return DENIED;
    }
    return fn(tx);
  });
  if (r === DENIED) throw new Denied();
  return r as T;
}

async function readBody(req: Request): Promise<unknown | undefined> {
  const buf = await readBodyLimited(req, MAX_BODY);
  if (!buf) return undefined;
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    return undefined;
  }
}

export async function handleSettings(req: Request, path: string, db: Db, user: AuthUser): Promise<Response> {
  const route = ROUTES[path];
  if (!route) return json({ error: "not_found" }, 404);
  const method = req.method as Method;
  if (!route.methods.includes(method)) return json({ error: "method_not_allowed" }, 405);
  let body: unknown;
  if (method !== "GET") {
    const bad = csrfProblem(req, "json");
    if (bad) return json({ error: bad, message: MSG.bad }, 403);
    body = await readBody(req);
    if (body === undefined) return json({ error: "bad_request", message: MSG.bad }, 400);
  }

  try {
    if (path === "settings/overview") {
      const permissions = await permissionsOf(db, user.id);
      const result = await withPermission(db, user, route, path, method, async (tx) => {
        const admin = ADMIN_PERMISSIONS.some((p) => permissions.includes(p))
          ? (await tx.query<Record<string, unknown>>("select * from app_admin_overview()"))[0]
          : null;
        const catalogs = await tx.query<{ t: string; active: string; archived: string }>(
          `select 'pipeline' as t, count(*) filter (where is_active) as active, count(*) filter (where not is_active) as archived from crm_pipeline_statuses
           union all select 'taskTypes', count(*) filter (where is_active), count(*) filter (where not is_active) from crm_task_types
           union all select 'taskInputs', count(*) filter (where is_active), count(*) filter (where not is_active) from crm_task_input_options`,
        );
        const canSeeImports = permissions.includes("crm.customer.import") || permissions.includes("crm.import.history.read");
        const lastImport = canSeeImports
          ? (await tx.query<{ created_at: Date | string; status: string }>("select created_at, status from import_jobs order by created_at desc limit 1"))[0] ?? null
          : null;
        const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
        const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
        return {
          permissions,
          users: admin ? { active: n(admin.active_users), inactive: n(admin.inactive_users), settingsAdmins: n(admin.settings_admins), userAdmins: n(admin.user_admins), auditReaders: n(admin.audit_readers) } : null,
          lastChangeAt: admin ? iso(admin.last_change_at) : null,
          catalogs: Object.fromEntries(catalogs.map((c) => [c.t, { active: Number(c.active), archived: Number(c.archived) }])),
          imports: { commitEnabled: features().customerImport, last: lastImport ? { at: iso(lastImport.created_at), status: lastImport.status } : null, visible: canSeeImports },
        };
      });
      return json(result);
    }

    const kind = CATALOG_KINDS.find((k) => path === `settings/${k}` || path === `settings/${k}/order`) as CatalogKind | undefined;
    if (kind) {
      if (method === "GET") return json({ items: await withPermission(db, user, route, path, method, (tx) => listCatalog(tx, kind)) });
      try {
        if (path.endsWith("/order")) {
          return json({ items: await withPermission(db, user, route, path, method, (tx) => reorderCatalog(tx, kind, body)), message: "A beállítás mentve." });
        }
        const item = await withPermission(db, user, route, path, method, (tx) => (method === "POST" ? createCatalogItem(tx, kind, body) : updateCatalogItem(tx, kind, body)));
        return json({ item, message: "A beállítás mentve." }, method === "POST" ? 201 : 200);
      } catch (e) {
        if (e instanceof SettingsError) {
          // A szabálysértő módosítási kísérlet (pl. rendszerstátusz archiválása) külön, véglegesített naplóbejegyzést kap.
          if (["system_archive", "label_locked", "protected_field"].includes(e.code)) {
            const key = typeof (body as { key?: unknown })?.key === "string" ? String((body as { key: string }).key) : "-";
            try { await db.asUser(user.id, (tx) => logRejection(tx, `${SPECS[kind].entity}.update`, SPECS[kind].entity, key, e.code)); } catch { /* a naplózás hibája nem írja felül a választ */ }
          }
          return json({ error: e.code, message: e.message, ...e.extra }, e.status);
        }
        throw e;
      }
    }

    if (path === "settings/users") {
      const users = await withPermission(db, user, route, path, method, (tx) => listAdminUsers(tx));
      return json({
        users, currentUserId: user.id,
        permissions: CRM_PERMISSIONS.map((p) => ({ key: p, label: PERMISSION_LABELS[p], admin: (ADMIN_PERMISSIONS as readonly string[]).includes(p) })),
      });
    }

    if (path === "settings/users/permissions") {
      try {
        const result = await withPermission(db, user, route, path, method, (tx) => changePermissions(tx, user.id, body));
        return json({ ...result, message: "A beállítás mentve." });
      } catch (e) {
        if (!(e instanceof PermissionChangeError)) throw e;
        const target = typeof (body as { userId?: unknown })?.userId === "string" ? String((body as { userId: string }).userId) : "-";
        // A tiltott jogosultság-változás (önjogosítás, ismeretlen jog, utolsó admin) elutasítása naplózódik; a módosítás nem történt meg.
        if (e.code !== "conflict") {
          try { await db.asUser(user.id, (tx) => logRejection(tx, "permission.change", "user_permission", target, e.code)); } catch { /* lásd fent */ }
        }
        return json({ error: e.code, message: e.message }, e.status);
      }
    }

    if (path === "settings/audit") {
      const q = auditQuery.safeParse(Object.fromEntries(new URL(req.url).searchParams));
      if (!q.success) return json({ error: "bad_request", message: MSG.bad }, 400);
      const users = await listUsers(db);
      return json(await withPermission(db, user, route, path, method, (tx) => listAudit(tx, q.data, users)));
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof Denied) return json({ error: "forbidden", message: MSG.forbidden }, 403);
    logError(path, e);
    return json({ error: "server_error", message: MSG.failed }, 500);
  }
}
