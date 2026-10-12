import { z } from "zod";
import { ENV_LABELS } from "../config";
import { clearCookie, clientIp, isSecure, listUsers, login, logout, sessionCookie, userFromRequest, type AuthUser } from "../auth/service";
import type { Runtime } from "../db";
import { executeOp, isOpName } from "../crm/ops";
import { loadSnapshot, InvariantError } from "../crm/store";

/**
 * A HTTP API logikája szabványos Request/Response felületen (a Next route csak továbbítja), így Next nélkül is tesztelhető.
 * Minden CRM-végpont hitelesítést igényel; az adatműveletek korlátozott, RLS-es adatbázis-szerepkörrel futnak.
 * A hibaválaszok általánosak: nem tartalmaznak adatbázis-részletet, személyes adatot vagy hitelesítő adatot.
 */
const MAX_BODY = 64 * 1024;
const HEADERS = { "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" };

const json = (body: unknown, status = 200, extra: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json; charset=utf-8", ...HEADERS, ...extra } });

const loginBody = z.object({ email: z.string().max(200), password: z.string().max(500) }).strict();
const opBody = z.object({ requestId: z.string().uuid(), op: z.string().max(60), args: z.unknown() }).strict();

/** CSRF-védelem: a módosító kérés csak azonos eredetű lehet (Origin vagy Sec-Fetch-Site), és JSON tartalmú. */
function csrfProblem(req: Request): string | null {
  const origin = req.headers.get("origin");
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin) {
    let ok = origin === url.origin;
    try {
      ok = ok || (host !== null && new URL(origin).host === host);
    } catch {
      ok = false;
    }
    if (!ok) return "cross_origin";
  } else if (!["same-origin", "none"].includes(req.headers.get("sec-fetch-site") ?? "")) return "missing_origin";
  if (!(req.headers.get("content-type") ?? "").toLowerCase().startsWith("application/json")) return "bad_content_type";
  return null;
}

async function readJson(req: Request): Promise<unknown | undefined> {
  const text = await req.text();
  if (text.length > MAX_BODY) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** Naplózás személyes adat nélkül: csak a hiba kódja/neve és a kényszer neve. */
const logError = (where: string, e: unknown) => {
  const x = e as { code?: string; constraint?: string; name?: string };
  console.error(`[jg-os] ${where}:`, x?.code ?? x?.name ?? "hiba", x?.constraint ?? "");
};

export function createApi(getRuntime: () => Promise<Runtime>, clock: () => Date = () => new Date()) {
  return async function handle(req: Request): Promise<Response> {
    const path = new URL(req.url).pathname.replace(/^\/api\//, "").replace(/\/$/, "");
    try {
      const rt = await getRuntime();
      // Állapot-végpont (személyes adat nélkül): csak működő adatbázisnál 200, különben 503 - hibás DB esetén a rendszer nem jelentkezik késznek.
      if (path === "status") {
        if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        return rt.state === "ok" ? json({ state: "ok", environment: rt.env, environmentLabel: ENV_LABELS[rt.env] }) : json({ state: rt.state }, 503);
      }
      if (rt.state !== "ok") return json({ state: rt.state }, 503);
      const { db } = rt;

      if (path === "auth/login") {
        if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const bad = csrfProblem(req);
        if (bad) return json({ error: bad }, 403);
        const body = loginBody.safeParse(await readJson(req));
        if (!body.success) return json({ error: "bad_request" }, 400);
        const res = await login(db, body.data.email, body.data.password, clientIp(req));
        if (!res.ok) return json({ error: res.status === 429 ? "too_many_attempts" : "invalid_credentials" }, res.status, res.status === 429 ? { "Retry-After": "900" } : {});
        return json({ state: "ok", user: res.user, environment: rt.env, environmentLabel: ENV_LABELS[rt.env] }, 200, { "Set-Cookie": sessionCookie(res.token, isSecure(req)) });
      }

      if (path === "auth/logout") {
        if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const bad = csrfProblem(req);
        if (bad) return json({ error: bad }, 403);
        await logout(db, req);
        return json({ ok: true }, 200, { "Set-Cookie": clearCookie(isSecure(req)) });
      }

      // Minden további végpont hitelesítést igényel.
      const user: AuthUser | null = await userFromRequest(db, req);
      if (!user) return json({ state: "unauthenticated" }, 401);

      if (path === "auth/me") return req.method === "GET" ? json({ state: "ok", user, environment: rt.env, environmentLabel: ENV_LABELS[rt.env] }) : json({ error: "method_not_allowed" }, 405);

      if (path === "crm/snapshot") {
        if (req.method !== "GET") return json({ error: "method_not_allowed" }, 405);
        const snapshot = await db.asUser(user.id, (tx) => loadSnapshot(tx));
        return json({ snapshot, users: await listUsers(db) });
      }

      if (path === "crm/op") {
        if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405);
        const bad = csrfProblem(req);
        if (bad) return json({ error: bad }, 403);
        const body = opBody.safeParse(await readJson(req));
        if (!body.success || !isOpName(body.data.op)) return json({ error: "bad_request" }, 400);
        const out = await executeOp(db, user, { requestId: body.data.requestId, op: body.data.op, args: body.data.args }, clock);
        if (out.kind === "bad_args") return json({ error: "bad_request" }, 400);
        return json({ result: out.result, snapshot: out.snapshot, replayed: out.replayed });
      }

      return json({ error: "not_found" }, 404);
    } catch (e) {
      logError(path, e);
      if (e instanceof InvariantError) return json({ error: "invariant" }, 409);
      return json({ error: "server_error" }, 500);
    }
  };
}
