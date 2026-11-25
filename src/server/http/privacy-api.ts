import type { AuthUser } from "../auth/service";
import { listUsers } from "../auth/service";
import type { Db, Tx } from "../db/types";
import { hasPermission, type CrmPermission } from "../data/permissions";
import {
  accessReport, createRequest, eraseCustomer, listRequests, privacyAudit, PrivacyError, privacyOverview, recordRestriction, retentionReview,
  retentionSettings, updateRequest,
} from "../privacy/privacy";
import { csrfProblem, readBodyLimited } from "./guards";

/**
 * Adatvédelmi végpontok (v1.3, GDPR): /api/privacy/*. Mindegyik:
 *  - bejelentkezést (a hívó api.ts ellenőrizte) ÉS adatvédelmi jogot igényel, amelyet a szerver a kérés saját RLS-es tranzakciójában
 *    frissen ellenőriz (visszavonás azonnal hat); az elutasítás véglegesített auditbejegyzést kap;
 *  - módosító kérésnél azonos eredetet (CSRF), JSON tartalomtípust és korlátozott törzsméretet;
 *  - semmit nem gyorsítótáraz (no-store), belső hibát nem ad ki; minden sikeres művelet és minden kivonat naplózódik (személyes adat nélkül).
 * A végleges anonimizálás külön joghoz (crm.privacy.erase) kötött, és az adatbázis-függvény is újraellenőrzi.
 */
const NO_STORE = {
  "Cache-Control": "no-store, no-cache, must-revalidate, private, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Vercel-CDN-Cache-Control": "no-store",
  Pragma: "no-cache",
  Expires: "0",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
};
const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...NO_STORE, ...extra } });

const MSG = { forbidden: "Ehhez a művelethez nincs jogosultságod.", bad: "Érvénytelen kérés.", failed: "A művelet nem sikerült. Az adatok nem változtak." };
const MAX_BODY = 16 * 1024;

type Method = "GET" | "POST" | "PATCH";
const ROUTES: Record<string, { methods: Method[]; permission: CrmPermission }> = {
  "privacy/overview": { methods: ["GET"], permission: "crm.privacy.manage" },
  "privacy/requests": { methods: ["GET", "POST", "PATCH"], permission: "crm.privacy.manage" },
  "privacy/report": { methods: ["POST"], permission: "crm.privacy.manage" },
  "privacy/restriction": { methods: ["POST"], permission: "crm.privacy.manage" },
  "privacy/erase": { methods: ["POST"], permission: "crm.privacy.erase" },
  "privacy/retention": { methods: ["GET"], permission: "crm.privacy.manage" },
};

class Denied extends Error {}
const DENIED = Symbol("denied");

async function withPermission<T>(db: Db, user: AuthUser, permission: CrmPermission, path: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const r = await db.asUser(user.id, async (tx) => {
    if (!(await hasPermission(tx, permission))) {
      await privacyAudit(tx, user.id, "privacy.denied", null, null, { route: path, permission });
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

const logError = (where: string, e: unknown) => {
  const x = e as { code?: string; constraint?: string; name?: string };
  console.error(`[jg-os] ${where}:`, x?.code ?? x?.name ?? "hiba", x?.constraint ?? "");
};

const safeName = (s: string) => s.replace(/[^A-Za-z0-9_-]/g, "");

export async function handlePrivacy(req: Request, path: string, db: Db, user: AuthUser, clock: () => Date): Promise<Response> {
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
  const now = clock();
  try {
    if (path === "privacy/overview") {
      return json({ ...(await withPermission(db, user, route.permission, path, (tx) => privacyOverview(tx, now))), canErase: await db.asUser(user.id, (tx) => hasPermission(tx, "crm.privacy.erase")) });
    }
    if (path === "privacy/requests") {
      const users = await listUsers(db);
      if (method === "GET") {
        const s = new URL(req.url).searchParams.get("status");
        const status = s === "open_all" || s === "open" || s === "in_progress" || s === "completed" || s === "rejected" ? s : undefined;
        return json({ requests: await withPermission(db, user, route.permission, path, (tx) => listRequests(tx, users, now, { status })) });
      }
      const request = await withPermission(db, user, route.permission, path, (tx) => (method === "POST" ? createRequest(tx, user.id, body, now, users) : updateRequest(tx, user.id, body, now, users)));
      return json({ request, message: "A kérelem mentve." }, method === "POST" ? 201 : 200);
    }
    if (path === "privacy/report") {
      const requestId = typeof (body as { requestId?: unknown })?.requestId === "string" ? String((body as { requestId: string }).requestId) : "";
      const users = await listUsers(db);
      // A jogosultság-ellenőrzés az érvényességi vizsgálat előtt történik (jog nélkül a kérés tartalmáról sem adunk visszajelzést).
      const report = await withPermission(db, user, route.permission, path, (tx) => {
        if (!/^pr-[0-9a-f]{16}$/.test(requestId)) throw new PrivacyError(400, "invalid", MSG.bad);
        return accessReport(tx, user, requestId, users, now);
      });
      const stamp = now.toISOString().slice(0, 10);
      return new Response(JSON.stringify(report, null, 2), {
        status: 200,
        headers: { "Content-Type": "application/json; charset=utf-8", "Content-Disposition": `attachment; filename="JG_Adatkivonat_${safeName(requestId)}_${stamp}.json"`, ...NO_STORE },
      });
    }
    if (path === "privacy/restriction") {
      await withPermission(db, user, route.permission, path, (tx) => recordRestriction(tx, user.id, body));
      return json({ ok: true, message: "A rögzítés megtörtént." });
    }
    if (path === "privacy/erase") {
      const result = await withPermission(db, user, route.permission, path, (tx) => eraseCustomer(tx, body));
      return json({ ok: true, ...result, message: "Az ügyfél adatai véglegesen anonimizálva." });
    }
    if (path === "privacy/retention") {
      return json(await withPermission(db, user, route.permission, path, (tx) => retentionReview(tx, retentionSettings(), now)));
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    if (e instanceof Denied) return json({ error: "forbidden", message: MSG.forbidden }, 403);
    if (e instanceof PrivacyError) return json({ error: e.code, message: e.message }, e.status);
    logError(path, e);
    return json({ error: "server_error", message: MSG.failed }, 500);
  }
}
