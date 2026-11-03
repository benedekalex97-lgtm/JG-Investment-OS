import { z } from "zod";
import { CONFIG_DESCRIPTION_MAX, CONFIG_KEY_RE, CONFIG_LABEL_MAX, DEFAULT_STATUS_KEY, STATUS_COLORS } from "@/domain/config";
import type { Tx } from "../db/types";

/**
 * Konfigurációs katalógusok adminisztrációja (v1.1, SET-004-006): Pipeline-státuszok, feladattípusok, Input-opciók.
 *
 * Minden függvény a hívó RLS-es (`jg_app`) tranzakciójában fut, a jog előzetes, friss ellenőrzése után. Az adatbázis további,
 * független védelmei: oszlopszintű jogok (kulcs, rendszerjelölés, üzleti jelentés nem írható), őr-trigger (rendszerelem nem
 * archiválható, zárolt megnevezés nem írható át, verzió/ki/mikor automatikus), napló-trigger (minden változás a settings_audit-ba
 * ugyanabban a tranzakcióban), RLS (írás csak crm.settings.manage joggal). Törlés nincs: archiválás és újraaktiválás van.
 *
 * Párhuzamos módosítás: optimista - minden módosító kérés a kliens által látott verziót küldi; eltérésnél 409 és nincs írás.
 */
export type CatalogKind = "pipeline" | "task-types" | "task-inputs";
export const CATALOG_KINDS: readonly CatalogKind[] = ["pipeline", "task-types", "task-inputs"];

interface Spec {
  table: string;
  entity: "pipeline_status" | "task_type" | "task_input";
  noun: string;
}
export const SPECS: Record<CatalogKind, Spec> = {
  pipeline: { table: "crm_pipeline_statuses", entity: "pipeline_status", noun: "státusz" },
  "task-types": { table: "crm_task_types", entity: "task_type", noun: "feladattípus" },
  "task-inputs": { table: "crm_task_input_options", entity: "task_input", noun: "Input-opció" },
};

export class SettingsError extends Error {
  constructor(public status: 400 | 404 | 409, public code: string, message: string, public extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const CONFLICT_MESSAGE = "A beállítás időközben megváltozott. Frissítsd az adatokat az új mentés előtt.";

// Megjelenített szöveg: nincs vezérlőkarakter (sortörés, tabulátor stb.); HTML/script nem értelmeződik (a felület szövegként jeleníti
// meg), és az exportban a CSV képletvédelem érvényes. A szín csak a zárt palettából választható.
const text = (max: number, what: string) =>
  z.string({ message: `${what} megadása kötelező.` }).trim().min(1, `${what} megadása kötelező.`).max(max, `${what} legfeljebb ${max} karakter lehet.`)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), `${what} nem tartalmazhat vezérlőkaraktert.`);
const label = text(CONFIG_LABEL_MAX, "A megnevezés");
const description = z.string().trim().max(CONFIG_DESCRIPTION_MAX, `A leírás legfeljebb ${CONFIG_DESCRIPTION_MAX} karakter lehet.`)
  .refine((v) => !/[\u0000-\u0009\u000b-\u001f\u007f]/.test(v), "A leírás nem tartalmazhat vezérlőkaraktert.");
const color = z.enum(STATUS_COLORS, { message: "A szín csak a megadott palettából választható." });
const key = z.string().regex(CONFIG_KEY_RE);
const version = z.number().int().min(1);

export const createBodies = {
  pipeline: z.object({ label, description: description.optional(), color: color.default("neutral") }).strict(),
  "task-types": z.object({ label }).strict(),
  "task-inputs": z.object({ label, allowsNote: z.boolean().default(false) }).strict(),
} as const;
export const updateBodies = {
  pipeline: z.object({ key, version, label: label.optional(), description: description.nullable().optional(), color: color.optional(), isActive: z.boolean().optional(), confirmInUse: z.boolean().optional() }).strict(),
  "task-types": z.object({ key, version, label: label.optional(), isActive: z.boolean().optional(), confirmInUse: z.boolean().optional() }).strict(),
  "task-inputs": z.object({ key, version, label: label.optional(), isActive: z.boolean().optional(), allowsNote: z.boolean().optional(), confirmInUse: z.boolean().optional() }).strict(),
} as const;
export const orderBody = z.object({ order: z.array(z.object({ key, version }).strict()).min(1).max(500) }).strict();

type Row = Record<string, unknown>;
export interface CatalogItem {
  key: string; label: string; sortOrder: number; isActive: boolean; isSystem: boolean; version: number;
  description?: string | null; color?: string; semantic?: string; requiresVerification?: boolean; labelLocked?: boolean; allowsNote?: boolean;
  /** Használat: ügyfelek (státusznál az aktív ügyfelek aktuális státusza), feladatok (történeti hivatkozás), nyitott feladatok. */
  usage: { customers?: number; tasks: number; openTasks: number };
  updatedAt: string; archivedAt: string | null;
}

const iso = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

/** Lista a használati számokkal (archivált elemek is). */
export async function listCatalog(tx: Tx, kind: CatalogKind): Promise<CatalogItem[]> {
  const { table } = SPECS[kind];
  const rows = await tx.query<Row>(`select * from ${table} order by sort_order, key`);
  const col = kind === "pipeline" ? "crm_status" : kind === "task-types" ? "task_type" : "input_key";
  const taskUse = await tx.query<{ k: string; n: string; o: string }>(
    `select ${col} as k, count(*) as n, count(*) filter (where status <> 'done') as o from tasks where ${col} is not null group by ${col}`,
  );
  const custUse = kind === "pipeline"
    ? await tx.query<{ k: string; n: string }>("select coalesce(crm_status, $1) as k, count(*) as n from customers where deleted_at is null group by 1", [DEFAULT_STATUS_KEY])
    : [];
  return rows.map((r) => {
    const k = String(r.key);
    const t = taskUse.find((x) => x.k === k);
    return {
      key: k, label: String(r.label), sortOrder: Number(r.sort_order), isActive: r.is_active === true, isSystem: r.is_system === true, version: Number(r.version),
      ...(kind === "pipeline" ? {
        description: (r.description as string | null) ?? null, color: String(r.color), semantic: String(r.semantic_type),
        requiresVerification: r.requires_verification === true, labelLocked: r.label_locked === true,
      } : {}),
      ...(kind === "task-inputs" ? { allowsNote: r.allows_note === true } : {}),
      usage: {
        ...(kind === "pipeline" ? { customers: Number(custUse.find((x) => x.k === k)?.n ?? 0) } : {}),
        tasks: Number(t?.n ?? 0), openTasks: Number(t?.o ?? 0),
      },
      updatedAt: iso(r.updated_at) as string, archivedAt: iso(r.archived_at),
    };
  });
}

/** Stabil technikai kulcs a megnevezésből (ékezet nélkül, kisbetű, aláhúzás); ütközésnél sorszám. Létrehozás után soha nem változik. */
export function keyFromLabel(text: string, taken: Set<string>): string {
  const base0 = text.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 32);
  const base = /^[a-z]/.test(base0) && base0.length >= 2 ? base0 : `x_${base0}`.slice(0, 32).replace(/_+$/, "") || "x_elem";
  let k = base.length >= 2 ? base : `${base}_1`;
  for (let i = 2; taken.has(k); i++) k = `${base.slice(0, 32)}_${i}`;
  return k;
}

const pgCode = (e: unknown) => (e as { code?: string })?.code;
const pgMsg = (e: unknown) => String((e as { message?: string })?.message ?? "");

/** Adatbázis-hiba -> érthető, belső részletet nem tartalmazó üzenet. Ismeretlen hiba továbbdobva (500). */
export function mapDbError(e: unknown, noun: string): never {
  if (pgCode(e) === "23505") throw new SettingsError(409, "duplicate_label", `Már van ilyen megnevezésű ${noun}.`);
  const m = pgMsg(e);
  if (m.includes("jg:system_archive")) throw new SettingsError(400, "system_archive", "Rendszerelem nem archiválható.");
  if (m.includes("jg:label_locked")) throw new SettingsError(400, "label_locked", "Ennek a státusznak a megnevezése compliance-okból nem módosítható a felületről.");
  if (m.includes("jg:protected_field")) throw new SettingsError(400, "protected_field", "A védett mező nem módosítható.");
  throw e;
}

export async function createCatalogItem(tx: Tx, kind: CatalogKind, body: unknown): Promise<CatalogItem> {
  const spec = SPECS[kind];
  const parsed = createBodies[kind].safeParse(body);
  if (!parsed.success) throw new SettingsError(400, "invalid", parsed.error.issues[0]?.message ?? "Érvénytelen adatok.");
  const d = parsed.data as { label: string; description?: string; color?: string; allowsNote?: boolean };
  // Sorba rendezés: két egyidejű létrehozás nem kaphat azonos kulcsot / sorszámot.
  await tx.query("select pg_advisory_xact_lock(hashtextextended($1, 0))", [`jg.settings.${spec.table}`]);
  const existing = await tx.query<{ key: string; sort_order: number }>(`select key, sort_order from ${spec.table}`);
  const k = keyFromLabel(d.label, new Set(existing.map((r) => r.key)));
  const sort = Math.min(100000, existing.reduce((m, r) => Math.max(m, Number(r.sort_order)), 0) + 10);
  try {
    if (kind === "pipeline") {
      await tx.query(`insert into ${spec.table} (key, label, description, color, sort_order) values ($1, $2, $3, $4, $5)`, [k, d.label, d.description || null, d.color, sort]);
    } else if (kind === "task-inputs") {
      await tx.query(`insert into ${spec.table} (key, label, sort_order, allows_note) values ($1, $2, $3, $4)`, [k, d.label, sort, d.allowsNote === true]);
    } else {
      await tx.query(`insert into ${spec.table} (key, label, sort_order) values ($1, $2, $3)`, [k, d.label, sort]);
    }
  } catch (e) {
    mapDbError(e, spec.noun);
  }
  return (await listCatalog(tx, kind)).find((x) => x.key === k) as CatalogItem;
}

export async function updateCatalogItem(tx: Tx, kind: CatalogKind, body: unknown): Promise<CatalogItem> {
  const spec = SPECS[kind];
  const parsed = updateBodies[kind].safeParse(body);
  if (!parsed.success) throw new SettingsError(400, "invalid", parsed.error.issues[0]?.message ?? "Érvénytelen adatok.");
  const d = parsed.data as { key: string; version: number; label?: string; description?: string | null; color?: string; isActive?: boolean; allowsNote?: boolean; confirmInUse?: boolean };
  const cur = (await tx.query<Row>(`select * from ${spec.table} where key = $1 for update`, [d.key]))[0];
  if (!cur) throw new SettingsError(404, "not_found", "A beállítás nem található.");
  if (Number(cur.version) !== d.version) throw new SettingsError(409, "conflict", CONFLICT_MESSAGE);
  // Érthető üzenetek a védett szabályokra (az adatbázis ettől függetlenül is tiltja).
  if (d.isActive === false && cur.is_system === true) throw new SettingsError(400, "system_archive", `Rendszer${spec.noun === "státusz" ? "státusz" : "elem"} nem archiválható: a működéséhez kötött szabályok (pl. alapértelmezett státusz, megkeresési korlátozás, igazolási követelmény) miatt védett.`);
  if (d.label !== undefined && d.label !== cur.label && cur.label_locked === true) throw new SettingsError(400, "label_locked", "Ennek a státusznak a megnevezése compliance-okból nem módosítható a felületről.");
  if (d.isActive === false && cur.is_active === true) {
    const [use] = (await listCatalog(tx, kind)).filter((x) => x.key === d.key);
    const inUse = (use.usage.customers ?? 0) + use.usage.openTasks;
    if (inUse > 0 && d.confirmInUse !== true) {
      throw new SettingsError(409, "in_use", `A(z) ${spec.noun} használatban van. Az archiválás nem helyezi át az ügyfeleket és feladatokat; megerősítés szükséges.`, { usage: use.usage });
    }
  }
  const sets: string[] = [];
  const vals: unknown[] = [];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (d.label !== undefined) set("label", d.label);
  if (d.description !== undefined) set("description", d.description ? d.description : null);
  if (d.color !== undefined) set("color", d.color);
  if (d.isActive !== undefined) set("is_active", d.isActive);
  if (d.allowsNote !== undefined) set("allows_note", d.allowsNote);
  if (sets.length) {
    vals.push(d.key, d.version);
    try {
      const rows = await tx.query(`update ${spec.table} set ${sets.join(", ")} where key = $${vals.length - 1} and version = $${vals.length} returning key`, vals);
      if (!rows.length) throw new SettingsError(409, "conflict", CONFLICT_MESSAGE);
    } catch (e) {
      if (e instanceof SettingsError) throw e;
      mapDbError(e, spec.noun);
    }
  }
  return (await listCatalog(tx, kind)).find((x) => x.key === d.key) as CatalogItem;
}

/**
 * Sorrend mentése: a kliens a TELJES listát küldi (aktív és archivált elemek) a látott verziókkal. A sorok zárolása után a szerver
 * ellenőrzi, hogy pontosan ugyanazok a kulcsok szerepelnek-e (duplikáció és hiány nélkül), és egyik sem változott-e közben.
 */
export async function reorderCatalog(tx: Tx, kind: CatalogKind, body: unknown): Promise<CatalogItem[]> {
  const spec = SPECS[kind];
  const parsed = orderBody.safeParse(body);
  if (!parsed.success) throw new SettingsError(400, "invalid", "Érvénytelen sorrend.");
  const order = parsed.data.order;
  const rows = await tx.query<{ key: string; version: number; sort_order: number }>(`select key, version, sort_order from ${spec.table} order by key for update`);
  const keys = new Set(order.map((o) => o.key));
  if (keys.size !== order.length || keys.size !== rows.length || rows.some((r) => !keys.has(r.key))) {
    throw new SettingsError(409, "conflict", CONFLICT_MESSAGE);
  }
  for (const o of order) if (Number(rows.find((r) => r.key === o.key)?.version) !== o.version) throw new SettingsError(409, "conflict", CONFLICT_MESSAGE);
  for (let i = 0; i < order.length; i++) {
    const want = (i + 1) * 10;
    const r = rows.find((x) => x.key === order[i].key)!;
    if (Number(r.sort_order) !== want) await tx.query(`update ${spec.table} set sort_order = $1 where key = $2`, [want, r.key]);
  }
  return listCatalog(tx, kind);
}
