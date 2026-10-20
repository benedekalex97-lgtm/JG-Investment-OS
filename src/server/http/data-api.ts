import type { AuthUser } from "../auth/service";
import { listUsers } from "../auth/service";
import type { Db, Tx } from "../db/types";
import { features } from "../features";
import { buildExport, describeFilters, exportBody, exportCount, exportFilters } from "../data/export";
import { audit, commit, ImportError, inspect, listJobs, preview } from "../data/import";
import { dataLimits } from "../data/limits";
import { hasPermission, type DataPermission } from "../data/permissions";
import { importTemplate } from "../data/template";
import { UploadError, uploadMessage } from "../data/upload";
import { csrfProblem, readBodyLimited } from "./guards";

/**
 * Adatkezelési végpontok (v1.0, CRM-014-018): /api/data/*. Mindegyik:
 *  - bejelentkezést (a hívó api.ts már ellenőrizte) ÉS műveletspecifikus jogot igényel, amelyet a szerver a kérés saját RLS-es
 *    tranzakciójában frissen ellenőriz (visszavonás azonnal hat); elutasításnál 403 és auditbejegyzés;
 *  - módosító kérésnél azonos eredetet (CSRF) és a megfelelő tartalomtípust; korlátozott törzsméretet; felhasználónkénti óránkénti
 *    kéréskorlátot;
 *  - általános, magyar nyelvű hibaüzenetet ad (adatbázis-részlet nélkül).
 * A teljes adatbázismentés és -visszaállítás itt NEM érhető el (csak üzemeltetői CLI).
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

const MSG = {
  forbidden: "Ehhez a művelethez nincs jogosultságod.",
  rate: "Túl sok kérés rövid időn belül. Próbáld újra később.",
  bad: "Érvénytelen kérés.",
  tooLarge: "A fájl túl nagy.",
  exportFailed: "Az exportálás nem sikerült. Próbáld újra, vagy fordulj a rendszerüzemeltetőhöz.",
  importFailed: "Az importálás nem sikerült. Az adatbázisba nem került adat. Próbáld újra, vagy fordulj a rendszerüzemeltetőhöz.",
};

const ROUTES: Record<string, { method: "GET" | "POST"; permission: DataPermission; body?: "json" | "multipart" }> = {
  "data/import/template": { method: "GET", permission: "crm.customer.import" },
  "data/import/inspect": { method: "POST", permission: "crm.customer.import", body: "multipart" },
  "data/import/preview": { method: "POST", permission: "crm.customer.import", body: "multipart" },
  "data/import/commit": { method: "POST", permission: "crm.customer.import", body: "multipart" },
  "data/import/jobs": { method: "GET", permission: "crm.import.history.read" },
  "data/export/count": { method: "POST", permission: "crm.customer.export", body: "json" },
  "data/export": { method: "POST", permission: "crm.customer.export", body: "json" },
};

class Denied extends Error {}

async function recentCount(tx: Tx, userId: string, actions: string[]): Promise<number> {
  const [r] = await tx.query<{ n: string }>("select count(*) as n from audit_events where user_id = $1 and action = any($2) and at > now() - interval '1 hour'", [userId, actions]);
  return Number(r?.n ?? 0);
}

const DENIED = Symbol("denied");
/**
 * A művelet a kérés saját tranzakciójában, a jog friss ellenőrzése után fut. Hiányzó jognál az elutasítás auditbejegyzése
 * véglegesítődik (a tranzakció nem gördül vissza), és Denied hiba keletkezik.
 */
async function withPermission<T>(db: Db, user: AuthUser, permission: DataPermission, route: string, fn: (tx: Tx) => Promise<T>): Promise<T> {
  const r = await db.asUser(user.id, async (tx) => {
    if (!(await hasPermission(tx, permission))) {
      await audit(tx, user.id, "data.denied", null, { route, permission });
      return DENIED;
    }
    return fn(tx);
  });
  if (r === DENIED) throw new Denied();
  return r as T;
}

async function readUpload(req: Request, maxFile: number): Promise<{ file: Buffer; meta: unknown } | "too_large" | "bad"> {
  const bytes = await readBodyLimited(req, maxFile + 64 * 1024);
  if (!bytes) return "too_large";
  let form: FormData;
  try {
    form = await new Response(new Uint8Array(bytes), { headers: { "content-type": req.headers.get("content-type") ?? "" } }).formData();
  } catch {
    return "bad";
  }
  const file = form.get("file");
  const metaRaw = form.get("meta");
  if (!(file instanceof Blob) || typeof metaRaw !== "string" || metaRaw.length > 400 * 1024) return "bad";
  if (file.size > maxFile) return "too_large";
  try {
    return { file: Buffer.from(await file.arrayBuffer()), meta: JSON.parse(metaRaw) };
  } catch {
    return "bad";
  }
}

const logError = (where: string, e: unknown) => {
  const x = e as { code?: string; constraint?: string; name?: string };
  console.error(`[jg-os] ${where}:`, x?.code ?? x?.name ?? "hiba", x?.constraint ?? "");
};

const safeFilename = (s: string) => s.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 120);

export async function handleData(req: Request, path: string, db: Db, user: AuthUser, clock: () => Date): Promise<Response> {
  const route = ROUTES[path];
  if (!route) return json({ error: "not_found" }, 404);
  if (req.method !== route.method) return json({ error: "method_not_allowed" }, 405);
  if (route.body) {
    const bad = csrfProblem(req, route.body);
    if (bad) return json({ error: bad, message: MSG.bad }, 403);
  }
  const limits = dataLimits();
  const enabled = features().customerImport;
  const now = clock();
  try {
    if (path === "data/import/template") {
      await withPermission(db, user, route.permission, path, async () => undefined);
      return new Response(new Uint8Array(importTemplate(now)), {
        headers: { ...NO_STORE, "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", "Content-Disposition": 'attachment; filename="JG_CRM_Import_Template.xlsx"' },
      });
    }

    if (path === "data/import/jobs") {
      const users = await listUsers(db);
      const jobs = await withPermission(db, user, route.permission, path, (tx) => listJobs(tx, users, now));
      return json({ jobs });
    }

    if (route.body === "multipart") {
      // A jogot a feltöltés beolvasása ELŐTT ellenőrizzük: jogosulatlan kérés fájlja nem kerül feldolgozásra.
      await withPermission(db, user, route.permission, path, async () => undefined);
      const up = await readUpload(req, limits.maxFileBytes);
      if (up === "too_large") return json({ error: "too_large", message: uploadMessage("too_large") }, 413);
      if (up === "bad") return json({ error: "bad_request", message: MSG.bad }, 400);
      const meta = (up.meta ?? {}) as Record<string, unknown>;
      // Kéréskorlát: minden feldolgozott feltöltés (sikertelen is) külön, véglegesített auditbejegyzéssel számít.
      const action = path === "data/import/preview" ? "import.upload.preview" : path === "data/import/inspect" ? "import.upload.inspect" : "import.upload.commit";
      const max = path === "data/import/preview" ? limits.previewsPerHour : path === "data/import/inspect" ? limits.previewsPerHour * 2 : limits.previewsPerHour;
      const allowed = await withPermission(db, user, route.permission, path, async (tx) => {
        if ((await recentCount(tx, user.id, [action])) >= max) return false;
        await audit(tx, user.id, action, null, { size: up.file.length });
        return true;
      });
      if (!allowed) return json({ error: "rate_limited", message: MSG.rate }, 429, { "Retry-After": "3600" });

      if (path === "data/import/inspect") {
        const opts = { encoding: typeof meta.encoding === "string" ? meta.encoding : undefined, sheetIndex: typeof meta.sheetIndex === "number" ? meta.sheetIndex : undefined };
        const result = await withPermission(db, user, route.permission, path, async () => inspect(up.file, String(meta.fileType ?? ""), opts, limits));
        return json({ ...result, limits: { maxFileBytes: limits.maxFileBytes, maxRows: limits.maxRows }, importEnabled: enabled });
      }
      if (path === "data/import/preview") {
        return json(await withPermission(db, user, route.permission, path, (tx) => preview(tx, user, up.file, meta, limits, enabled, now)));
      }
      return json(await withPermission(db, user, route.permission, path, (tx) => commit(tx, user, up.file, meta, limits, enabled, now)));
    }

    // JSON-törzsű export végpontok
    const text = await readBodyLimited(req, 16 * 1024);
    if (!text) return json({ error: "too_large", message: MSG.bad }, 413);
    let body: unknown;
    try {
      body = JSON.parse(text.toString("utf8"));
    } catch {
      return json({ error: "bad_request", message: MSG.bad }, 400);
    }
    if (path === "data/export/count") {
      const parsed = exportFilters.safeParse((body as { filters?: unknown })?.filters ?? {});
      if (!parsed.success) return json({ error: "bad_request", message: MSG.bad }, 400);
      const r = await withPermission(db, user, route.permission, path, (tx) => exportCount(tx, parsed.data));
      return json(r);
    }
    // data/export
    const parsed = exportBody.safeParse(body);
    if (!parsed.success) return json({ error: "bad_request", message: MSG.bad }, 400);
    const { format, filters } = parsed.data;
    // Az auditba a szűrés jellege kerül, a keresőkifejezés szövege nem (az személyes adat lehet).
    const auditFilters = { crmStatus: filters.crmStatus ?? null, type: filters.type ?? null, source: Boolean(filters.source), query: Boolean(filters.query?.trim()), queryLength: filters.query?.trim().length ?? 0 };
    try {
      const file = await withPermission(db, user, route.permission, path, async (tx) => {
        if ((await recentCount(tx, user.id, ["customer.export"])) >= limits.exportsPerHour) return null;
        const f = await buildExport(tx, format, filters, now);
        await audit(tx, user.id, "customer.export", null, { format, filters: auditFilters, count: f.count, ok: true });
        return f;
      });
      if (!file) return json({ error: "rate_limited", message: MSG.rate }, 429, { "Retry-After": "3600" });
      const name = safeFilename(file.filename);
      return new Response(new Uint8Array(file.body), {
        headers: {
          ...NO_STORE, "Content-Type": file.contentType, "Content-Disposition": `attachment; filename="${name}"`, "Content-Length": String(file.body.length),
          "X-JG-Export-Count": String(file.count), "X-JG-Export-Filter": encodeURIComponent(describeFilters({ ...filters, source: filters.source ? "megadva" : undefined })),
        },
      });
    } catch (e) {
      if (e instanceof Denied) throw e;
      logError(path, e);
      try {
        await db.asUser(user.id, (tx) => audit(tx, user.id, "customer.export", null, { format, filters: auditFilters, ok: false }));
      } catch { /* a naplózás hibája nem írja felül az eredeti hibát */ }
      return json({ error: "export_failed", message: MSG.exportFailed }, 500);
    }
  } catch (e) {
    if (e instanceof Denied) return json({ error: "forbidden", message: MSG.forbidden }, 403);
    if (e instanceof UploadError) return json({ error: e.code, message: e.message }, e.code === "too_large" ? 413 : 400);
    if (e instanceof ImportError) return json({ error: e.code, message: e.message }, e.status);
    logError(path, e);
    return json({ error: "server_error", message: path.startsWith("data/import") ? MSG.importFailed : MSG.exportFailed }, 500);
  }
}
