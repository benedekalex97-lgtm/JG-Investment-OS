import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import { strongEmail, strongPhone } from "@/domain/duplicates";
import { customerName } from "@/domain/logic";
import {
  dueState, ERASE_CONFIRMATION_WORD, extendedDueAt, PRIVACY_CHANNELS, PRIVACY_REQUEST_KINDS, PRIVACY_REQUEST_STATUSES, PROCESSING_INFO, requestDueAt,
  type DueState, type PrivacyChannel, type PrivacyRequestKind, type PrivacyRequestStatus,
} from "@/domain/privacy";
import type { Tx } from "../db/types";
import { activityFromRow, contactFromRow, customerFromRow, processFromRow, taskFromRow, type Row } from "../crm/rows";

/**
 * Adatvédelmi műveletek (v1.3, GDPR). Minden függvény a kérés saját, RLS-es (`jg_app`) tranzakciójában fut; a jogot a hívó
 * (privacy-api.ts) a tranzakcióban frissen ellenőrzi, az írásokat pedig az adatbázis is védi (FORCE RLS, őr-triggerek, szűk
 * SECURITY DEFINER függvények, lásd 0012). Az auditnaplóba (audit_events) csak azonosítók, típusok és darabszámok kerülnek -
 * személyes adat értéke soha.
 */

// ------------------------------------------------------------------ Tiltólista-lenyomat

/**
 * Egyirányú, tartományelválasztott lenyomat a tiltólistához. A normalizálás a duplikáció-szűrés erős kulcsaival azonos (CRM-013:
 * kisbetűs e-mail; telefonszámnál csak számjegyek, a 06 / 0036 előhívó +36-ra egységesítve), így ugyanaz a személy más írásmóddal is
 * fennakad. A lenyomat továbbra is személyes adatnak minősül (álnevesítés), de a nyers elérhetőség nem olvasható ki belőle közvetlenül.
 */
export function suppressionHash(kind: "email" | "phone", value: string | undefined): string | null {
  const key = kind === "email" ? strongEmail(value) : strongPhone(value);
  if (!key) return null;
  return createHash("sha256").update(`jg-os:suppression:v1|${kind}|${key}`).digest("hex");
}

export interface SuppressionHash { kind: "email" | "phone"; hash: string }

export function suppressionHashes(input: { emails?: (string | undefined)[]; phones?: (string | undefined)[] }): SuppressionHash[] {
  const out = new Map<string, SuppressionHash>();
  for (const e of input.emails ?? []) { const h = suppressionHash("email", e); if (h) out.set(h, { kind: "email", hash: h }); }
  for (const p of input.phones ?? []) { const h = suppressionHash("phone", p); if (h) out.set(h, { kind: "phone", hash: h }); }
  return [...out.values()];
}

/** Van-e a megadott elérhetőségek között tiltólistás (bármely aktív felhasználó ellenőrizheti; csak igen/nem). */
export async function suppressedKinds(tx: Tx, input: { emails?: (string | undefined)[]; phones?: (string | undefined)[] }): Promise<("email" | "phone")[]> {
  const hashes = suppressionHashes(input);
  if (!hashes.length) return [];
  const rows = await tx.query<{ kind: "email" | "phone" }>("select distinct kind from privacy_suppressions where hash = any($1::text[])", [hashes.map((h) => h.hash)]);
  return rows.map((r) => r.kind);
}

/** Az összes ismert tiltólistás lenyomat (import-előnézethez: egyetlen lekérdezés, a fájl soronként memóriában ellenőrizhető). */
export async function loadSuppressionSet(tx: Tx): Promise<Set<string>> {
  return new Set((await tx.query<{ hash: string }>("select hash from privacy_suppressions")).map((r) => r.hash));
}

/** Egy ügyfél (és kapcsolattartói) összes elérhetőségének lenyomata - tiltakozásnál és törlésnél a tiltólistára kerül. */
async function customerHashes(tx: Tx, customerId: string): Promise<SuppressionHash[]> {
  const c = await tx.query<{ email: string | null; phone: string | null; extra_phones: string[] | null }>("select email, phone, extra_phones from customers where id = $1", [customerId]);
  const k = await tx.query<{ email: string | null; phone: string | null }>("select email, phone from company_contacts where company_id = $1", [customerId]);
  const all = [...c, ...k];
  // v1.4: az ügyfél további telefonszámai is a tiltólistára kerülnek.
  const extra = c.flatMap((r) => (Array.isArray(r.extra_phones) ? r.extra_phones : []));
  return suppressionHashes({ emails: all.map((r) => r.email ?? undefined), phones: [...all.map((r) => r.phone ?? undefined), ...extra] });
}

// ------------------------------------------------------------------ Hibák

export class PrivacyError extends Error {
  constructor(public status: 400 | 403 | 404 | 409, public code: string, message: string) {
    super(message);
  }
}
const FN_ERRORS: Record<string, { status: 400 | 403 | 404 | 409; message: string }> = {
  "jg:forbidden": { status: 403, message: "Ehhez a művelethez nincs jogosultságod." },
  "jg:not_found": { status: 404, message: "Az ügyfél nem található." },
  "jg:already_erased": { status: 409, message: "Az ügyfél adatai már anonimizálva vannak." },
  "jg:request_mismatch": { status: 409, message: "A kérelem nem ehhez az ügyfélhez vagy művelethez tartozik, vagy már le van zárva." },
  "jg:four_eyes": { status: 409, message: "Négy-szem elv: a törlési kérelmet rögzítő felhasználó nem hajthatja végre a végleges törlést. Egy másik, törlési joggal rendelkező kolléga végezheti el." },
  "jg:identity_unverified": { status: 409, message: "A végleges törlés előtt rögzítsd, hogy az érintett személyazonossága ellenőrzött." },
  "jg:restriction_exists": { status: 409, message: "Az ügyfélnél már van rögzített tiltakozás vagy korlátozás; az nem írható felül." },
  "jg:request_closed": { status: 409, message: "A lezárt kérelem nem módosítható." },
  "jg:due_locked": { status: 409, message: "A határidő csak egyszer, a 12. cikk (3) szerinti meghosszabbítással módosítható." },
  "jg:protected_field": { status: 409, message: "A kérelem azonosító adatai nem módosíthatók." },
  "jg:invalid": { status: 400, message: "Érvénytelen kérés." },
  "jg:invalid_hash": { status: 400, message: "Érvénytelen kérés." },
};
export function mapPrivacyError(e: unknown): PrivacyError | null {
  if (e instanceof PrivacyError) return e;
  const m = String((e as { message?: string })?.message ?? "");
  const hit = Object.keys(FN_ERRORS).find((k) => m.includes(k));
  return hit ? new PrivacyError(FN_ERRORS[hit].status, hit.slice(3), FN_ERRORS[hit].message) : null;
}

export async function privacyAudit(tx: Tx, userId: string, action: string, entityId: string | null, customerId: string | null, detail: Record<string, unknown>) {
  await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail) values ($1, $2, 'privacy', $3, $4, $5::jsonb)",
    [userId, action, entityId, customerId, JSON.stringify(detail)]);
}

// ------------------------------------------------------------------ Érintetti kérelmek

const iso = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
const noCtl = (s: string) => !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(s);
const text = (max: number) => z.string().trim().max(max).refine(noCtl, "Vezérlőkarakter nem engedett.");

export interface PrivacyRequestView {
  id: string; kind: PrivacyRequestKind; status: PrivacyRequestStatus; channel: PrivacyChannel;
  customerId: string | null; customerName: string | null; customerState: "active" | "removed" | "erased" | null;
  subjectLabel: string | null; receivedAt: string; dueAt: string; extended: boolean; dueState: DueState;
  identityVerified: boolean; outcomeNote: string | null; createdBy: string; createdById: string; createdAt: string; updatedBy: string; updatedAt: string;
  closedAt: string | null; closedBy: string | null; version: number;
}

function requestView(r: Row, names: Map<string, string>, now: Date): PrivacyRequestView {
  const status = r.status as PrivacyRequestStatus;
  const dueAt = iso(r.due_at) as string;
  const custName = !r.c_id ? null : String((r.c_type === "company" ? r.company_name : r.display_name) ?? "");
  return {
    id: String(r.id), kind: r.kind as PrivacyRequestKind, status, channel: r.channel as PrivacyChannel,
    customerId: r.customer_id ? String(r.customer_id) : null, customerName: custName,
    customerState: !r.customer_id ? null : r.c_erased_at ? "erased" : r.c_deleted_at ? "removed" : "active",
    subjectLabel: r.subject_label ? String(r.subject_label) : null, receivedAt: iso(r.received_at) as string, dueAt, extended: r.extended === true,
    dueState: dueState(status, dueAt, now), identityVerified: r.identity_verified === true, outcomeNote: r.outcome_note ? String(r.outcome_note) : null,
    createdBy: names.get(String(r.created_by)) ?? "Ismeretlen felhasználó", createdById: String(r.created_by), createdAt: iso(r.created_at) as string,
    updatedBy: names.get(String(r.updated_by)) ?? "Ismeretlen felhasználó", updatedAt: iso(r.updated_at) as string,
    closedAt: iso(r.closed_at), closedBy: r.closed_by ? (names.get(String(r.closed_by)) ?? "Ismeretlen felhasználó") : null, version: Number(r.version),
  };
}

const REQUEST_SELECT = `select pr.*, c.id as c_id, c.type as c_type, c.display_name, c.company_name, c.deleted_at as c_deleted_at, c.erased_at as c_erased_at
  from privacy_requests pr left join customers c on c.id = pr.customer_id`;

export async function listRequests(tx: Tx, users: { id: string; name: string }[], now: Date, filter: { status?: "open_all" | PrivacyRequestStatus } = {}): Promise<PrivacyRequestView[]> {
  const names = new Map(users.map((u) => [u.id, u.name]));
  const where = filter.status === "open_all" ? " where pr.status in ('open','in_progress')" : filter.status ? " where pr.status = $1" : "";
  const rows = await tx.query<Row>(`${REQUEST_SELECT}${where} order by (pr.status in ('open','in_progress')) desc, pr.due_at, pr.created_at desc limit 500`,
    filter.status && filter.status !== "open_all" ? [filter.status] : []);
  return rows.map((r) => requestView(r, names, now));
}

async function getRequest(tx: Tx, id: string, users: { id: string; name: string }[], now: Date): Promise<PrivacyRequestView | null> {
  const rows = await tx.query<Row>(`${REQUEST_SELECT} where pr.id = $1`, [id]);
  return rows[0] ? requestView(rows[0], new Map(users.map((u) => [u.id, u.name])), now) : null;
}

export const createRequestBody = z.object({
  kind: z.enum(PRIVACY_REQUEST_KINDS),
  channel: z.enum(PRIVACY_CHANNELS),
  customerId: z.string().min(1).max(120).optional(),
  subjectLabel: text(200).optional(),
  /** A beérkezés napja (ÉÉÉÉ-HH-NN, budapesti nap) - a határidő ebből számítódik. Jövőbeli dátum nem fogadható el. */
  receivedOn: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  identityVerified: z.boolean().optional(),
  outcomeNote: text(1000).optional(),
}).strict();

export async function createRequest(tx: Tx, userId: string, raw: unknown, now: Date, users: { id: string; name: string }[]): Promise<PrivacyRequestView> {
  const p = createRequestBody.safeParse(raw);
  if (!p.success) throw new PrivacyError(400, "invalid", "Érvénytelen kérés. Ellenőrizd a kötelező mezőket.");
  const b = p.data;
  const subject = b.subjectLabel?.trim() || undefined;
  if (!b.customerId && !subject) throw new PrivacyError(400, "subject_required", "Add meg az ügyfelet, vagy - ha nem szerepel a CRM-ben - az érintett rövid megnevezését.");
  const receivedAt = new Date(`${b.receivedOn}T12:00:00Z`);
  if (Number.isNaN(receivedAt.getTime()) || receivedAt.getTime() > now.getTime() + 24 * 3600_000) throw new PrivacyError(400, "received_on", "A beérkezés napja nem lehet jövőbeli.");
  if (receivedAt.getTime() < now.getTime() - 366 * 24 * 3600_000) throw new PrivacyError(400, "received_on", "A beérkezés napja legfeljebb egy évvel korábbi lehet.");
  if (b.customerId) {
    const c = await tx.query("select 1 from customers where id = $1", [b.customerId]);
    if (!c.length) throw new PrivacyError(404, "customer", "Az ügyfél nem található.");
  }
  const id = `pr-${randomBytes(8).toString("hex")}`;
  await tx.query(
    `insert into privacy_requests (id, kind, customer_id, subject_label, channel, received_at, due_at, identity_verified, outcome_note, created_by, updated_by)
     values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)`,
    [id, b.kind, b.customerId ?? null, subject ?? null, b.channel, receivedAt.toISOString(), requestDueAt(receivedAt).toISOString(), b.identityVerified === true, b.outcomeNote || null, userId],
  );
  await privacyAudit(tx, userId, "privacy.request.create", id, b.customerId ?? null, { kind: b.kind, channel: b.channel, linkedCustomer: Boolean(b.customerId), identityVerified: b.identityVerified === true });
  return (await getRequest(tx, id, users, now))!;
}

export const updateRequestBody = z.object({
  id: z.string().regex(/^pr-[0-9a-f]{16}$/),
  version: z.number().int().min(1),
  status: z.enum(PRIVACY_REQUEST_STATUSES).optional(),
  identityVerified: z.boolean().optional(),
  outcomeNote: text(1000).nullable().optional(),
  customerId: z.string().min(1).max(120).optional(),
  /** A határidő egyszeri meghosszabbítása a beérkezéstől számított három hónapra (12. cikk (3)); az indokot a megjegyzés rögzíti. */
  extend: z.literal(true).optional(),
}).strict();

export async function updateRequest(tx: Tx, userId: string, raw: unknown, now: Date, users: { id: string; name: string }[]): Promise<PrivacyRequestView> {
  const p = updateRequestBody.safeParse(raw);
  if (!p.success) throw new PrivacyError(400, "invalid", "Érvénytelen kérés.");
  const b = p.data;
  const cur = await tx.query<Row>("select * from privacy_requests where id = $1 for update", [b.id]);
  if (!cur.length) throw new PrivacyError(404, "not_found", "A kérelem nem található.");
  const r = cur[0];
  if (Number(r.version) !== b.version) throw new PrivacyError(409, "conflict", "A kérelmet időközben módosították. Frissítsd az adatokat.");
  if (["completed", "rejected"].includes(String(r.status))) throw new PrivacyError(409, "request_closed", FN_ERRORS["jg:request_closed"].message);
  // A törlési kérelem csak a végleges anonimizálással teljesíthető (a lezárást az adatbázis-függvény végzi), elutasítani lehet.
  if (b.status === "completed" && r.kind === "erasure") throw new PrivacyError(409, "erase_required", "A törlési kérelem a végleges anonimizálással teljesíthető (Végleges törlés).");
  if ((b.status === "completed" || b.status === "rejected") && !(b.outcomeNote ?? r.outcome_note)) {
    throw new PrivacyError(400, "outcome_required", "A lezáráshoz rögzítsd röviden az intézkedést vagy az elutasítás okát (személyes adat nélkül).");
  }
  if (b.customerId) {
    if (r.customer_id) throw new PrivacyError(409, "protected_field", FN_ERRORS["jg:protected_field"].message);
    if (!(await tx.query("select 1 from customers where id = $1", [b.customerId])).length) throw new PrivacyError(404, "customer", "Az ügyfél nem található.");
  }
  const sets: string[] = [];
  const vals: unknown[] = [b.id];
  const set = (col: string, v: unknown) => { vals.push(v); sets.push(`${col} = $${vals.length}`); };
  if (b.status) set("status", b.status);
  if (b.identityVerified !== undefined) set("identity_verified", b.identityVerified);
  if (b.outcomeNote !== undefined) set("outcome_note", b.outcomeNote || null);
  if (b.customerId) set("customer_id", b.customerId);
  if (b.extend) {
    if (r.extended === true) throw new PrivacyError(409, "due_locked", FN_ERRORS["jg:due_locked"].message);
    set("extended", true);
    set("due_at", extendedDueAt(new Date(String(r.received_at instanceof Date ? r.received_at.toISOString() : r.received_at))).toISOString());
  }
  if (!sets.length) throw new PrivacyError(400, "invalid", "Nincs módosítás.");
  set("updated_by", userId);
  await tx.query(`update privacy_requests set ${sets.join(", ")} where id = $1`, vals);
  await privacyAudit(tx, userId, "privacy.request.update", b.id, (b.customerId ?? (r.customer_id as string | null)) ?? null, {
    fields: [b.status ? "status" : null, b.identityVerified !== undefined ? "identityVerified" : null, b.outcomeNote !== undefined ? "outcomeNote" : null, b.customerId ? "customerId" : null, b.extend ? "extended" : null].filter(Boolean),
    ...(b.status ? { from: r.status, to: b.status } : {}),
  });
  return (await getRequest(tx, b.id, users, now))!;
}

// ------------------------------------------------------------------ Hozzáférési / hordozhatósági kivonat (15. és 20. cikk)

export interface AccessReport {
  format: "jg-os-gdpr-access-report";
  version: 1;
  generatedAt: string;
  generatedBy: string;
  requestId: string;
  requestKind: PrivacyRequestKind;
  controller: string;
  processing: Omit<typeof PROCESSING_INFO, "controller">;
  subject: Record<string, unknown>;
  contacts: Record<string, unknown>[];
  restriction: Record<string, unknown> | null;
  history: Record<string, unknown>[];
  tasks: Record<string, unknown>[];
  legacyProcesses: Record<string, unknown>[];
  importOrigin: Record<string, unknown>[];
  privacyRequests: Record<string, unknown>[];
  accessLog: Record<string, unknown>[];
}

/**
 * Teljes, géppel olvasható (JSON) kivonat egy érintett összes CRM-adatáról - az eltávolított (de nem anonimizált) ügyfélnél is. Csak
 * egy rögzített hozzáférési vagy hordozhatósági kérelem alapján készíthető (elszámoltathatóság); minden kivonat naplózódik. A
 * munkatársak nevét (felelős, rögzítő) a kivonat a feldolgozás átláthatósága érdekében tartalmazza; jelszó, token, belső
 * azonosító-titok nem kerül bele.
 */
export async function accessReport(tx: Tx, user: { id: string; name: string }, requestId: string, users: { id: string; name: string }[], now: Date): Promise<AccessReport> {
  const req = await tx.query<Row>("select * from privacy_requests where id = $1", [requestId]);
  const r = req[0];
  if (!r) throw new PrivacyError(404, "not_found", "A kérelem nem található.");
  if (!["access", "portability"].includes(String(r.kind))) throw new PrivacyError(409, "kind", "Kivonat csak hozzáférési vagy adathordozhatósági kérelemhez készíthető.");
  if (!r.customer_id) throw new PrivacyError(409, "customer", "A kérelemhez nincs ügyfél rendelve. Ha az érintett nem szerepel a CRM-ben, ezt a kérelem lezárásakor rögzítsd.");
  if (["completed", "rejected"].includes(String(r.status))) throw new PrivacyError(409, "request_closed", FN_ERRORS["jg:request_closed"].message);
  const customerId = String(r.customer_id);
  const name = (id: unknown) => (id ? users.find((u) => u.id === String(id))?.name ?? "Ismeretlen felhasználó" : null);
  const [cRow] = await tx.query<Row>("select * from customers where id = $1", [customerId]);
  if (!cRow) throw new PrivacyError(404, "customer", "Az ügyfél nem található.");
  if (cRow.erased_at) throw new PrivacyError(409, "erased", FN_ERRORS["jg:already_erased"].message);
  const [restriction] = await tx.query<Row>("select * from customer_restrictions where customer_id = $1", [customerId]);
  const c = customerFromRow(cRow, restriction);
  const contacts = (await tx.query<Row>("select * from company_contacts where company_id = $1 order by created_at, id", [customerId])).map(contactFromRow);
  const acts = (await tx.query<Row>("select * from activities where customer_id = $1 order by occurred_at, id", [customerId])).map(activityFromRow);
  const results = await tx.query<Row>("select * from task_results where task_id in (select id from tasks where customer_id = $1) order by task_id, seq", [customerId]);
  const tasks = (await tx.query<Row>("select * from tasks where customer_id = $1 order by created_at, id", [customerId])).map((t) => taskFromRow(t, results.filter((x) => x.task_id === t.id)));
  const processes = (await tx.query<Row>("select * from processes where customer_id = $1 order by created_at, id", [customerId])).map(processFromRow);
  const origin = await tx.query<Row>("select * from app_privacy_import_origin($1)", [customerId]);
  const requests = await tx.query<Row>("select id, kind, status, channel, received_at, due_at, closed_at from privacy_requests where customer_id = $1 order by received_at, id", [customerId]);
  const log = await tx.query<Row>("select at, user_id, action from audit_events where customer_id = $1 order by at, id", [customerId]);
  const [channel] = await tx.query<{ label: string }>("select label from crm_acquisition_channels where key = $1", [c.acquisitionChannel]);
  const [status] = c.crmStatus ? await tx.query<{ label: string }>("select label from crm_pipeline_statuses where key = $1", [c.crmStatus]) : [];
  const { controller, ...processing } = PROCESSING_INFO;
  const report: AccessReport = {
    format: "jg-os-gdpr-access-report", version: 1, generatedAt: now.toISOString(), generatedBy: user.name, requestId, requestKind: r.kind as PrivacyRequestKind,
    controller, processing,
    subject: {
      id: c.id, type: c.type, name: customerName(c), ...(c.type === "individual" ? { lastName: c.lastName, firstName: c.firstName, notes: c.notes ?? null } : { companyName: c.companyName }),
      phone: c.phone ?? null, extraPhones: c.extraPhones ?? [], email: c.email ?? null, pipelineStatus: status?.label ?? c.crmStatus ?? null, acquisitionChannel: channel?.label ?? c.acquisitionChannel,
      acquisitionDetail: c.acquisitionDetail ?? null, dataSource: c.source || null, owner: name(cRow.owner_id), createdAt: c.createdAt, updatedAt: c.updatedAt,
      removedFromActiveCrmAt: iso(cRow.deleted_at),
    },
    contacts: contacts.map((k) => ({ lastName: k.lastName, firstName: k.firstName, position: k.position ?? null, phone: k.phone ?? null, email: k.email ?? null, primary: k.isPrimaryContact, createdAt: k.createdAt })),
    restriction: c.restriction ? { kind: c.restriction.kind, note: c.restriction.note, recordedAt: c.restriction.recordedAt, recordedBy: name(c.restriction.recordedBy) } : null,
    history: acts.map((a) => ({ type: a.type, occurredAt: a.occurredAt, summary: a.summary, recordedBy: name(a.recordedBy), ...(a.callOutcome ? { callOutcome: a.callOutcome } : {}) })),
    tasks: tasks.map((t) => ({
      title: t.title, type: t.taskType ?? null, description: t.description ?? null, input: t.inputKey ?? null, inputNote: t.inputNote ?? null, status: t.status,
      dueAt: t.dueAt ?? null, createdAt: t.createdAt, completedAt: t.completedAt ?? null, assignee: name(t.assigneeId),
      outputs: (t.outputs ?? []).map((o) => ({ outcome: o.outcome ?? null, text: o.text, closedAt: o.closedAt, closedBy: name(o.closedBy) })),
    })),
    legacyProcesses: processes.map((p) => ({ type: p.type, title: p.title, status: p.status, createdAt: p.createdAt, updatedAt: p.updatedAt })),
    importOrigin: origin.map((o) => ({ importId: o.import_id, sourceName: o.source_name, purpose: o.purpose, sourceVerification: o.source_verification, importedAt: iso(o.committed_at) })),
    privacyRequests: requests.map((x) => ({ id: x.id, kind: x.kind, status: x.status, channel: x.channel, receivedAt: iso(x.received_at), dueAt: iso(x.due_at), closedAt: iso(x.closed_at) })),
    accessLog: log.map((l) => ({ at: iso(l.at), action: l.action, user: name(l.user_id) })),
  };
  await privacyAudit(tx, user.id, "privacy.access_report", requestId, customerId, {
    kind: r.kind, contacts: contacts.length, history: acts.length, tasks: tasks.length, imports: origin.length,
  });
  return report;
}

// ------------------------------------------------------------------ Tiltakozás / korlátozás (18. és 21. cikk)

export const restrictionBody = z.object({
  customerId: z.string().min(1).max(120),
  kind: z.enum(["objection", "restriction"]),
  note: text(500).pipe(z.string().min(1)),
  requestId: z.string().regex(/^pr-[0-9a-f]{16}$/).optional(),
}).strict();

/**
 * Tiltakozás vagy megkeresési korlátozás első rögzítése. A rögzítés után a kimenő megkeresés tiltott (a meglévő CRM-szabályok), az import
 * az egyező sort elutasítja; tiltakozásnál az elérhetőségek a tiltólistára is felkerülnek. Kérelemhez kötve a kérelem teljesítettként zárul.
 */
export async function recordRestriction(tx: Tx, userId: string, raw: unknown): Promise<{ recorded: true }> {
  const p = restrictionBody.safeParse(raw);
  if (!p.success) throw new PrivacyError(400, "invalid", "Érvénytelen kérés. A megjegyzés kötelező (legfeljebb 500 karakter).");
  const b = p.data;
  const hashes = b.kind === "objection" ? await customerHashes(tx, b.customerId) : [];
  try {
    await tx.query("select app_privacy_record_restriction($1, $2, $3, $4, $5, $6::jsonb)",
      [b.customerId, b.kind, b.note, b.requestId ?? null, `act-${randomBytes(8).toString("hex")}`, JSON.stringify(hashes)]);
  } catch (e) {
    throw mapPrivacyError(e) ?? e;
  }
  if (b.requestId) {
    await tx.query("update privacy_requests set status = 'completed', outcome_note = coalesce(outcome_note, $2), updated_by = $3 where id = $1",
      [b.requestId, b.kind === "objection" ? "Tiltakozás rögzítve; kimenő megkeresés tiltva, elérhetőség tiltólistán." : "Megkeresési korlátozás rögzítve.", userId]);
  }
  await privacyAudit(tx, userId, "privacy.restriction", b.requestId ?? null, b.customerId, { kind: b.kind, suppressions: hashes.length, linkedRequest: Boolean(b.requestId) });
  return { recorded: true };
}

// ------------------------------------------------------------------ Végleges anonimizálás (17. cikk)

export const eraseBody = z.object({ requestId: z.string().regex(/^pr-[0-9a-f]{16}$/), confirmation: z.string().max(40) }).strict();

export async function eraseCustomer(tx: Tx, raw: unknown): Promise<{ customerId: string; counts: Record<string, number> }> {
  const p = eraseBody.safeParse(raw);
  if (!p.success) throw new PrivacyError(400, "invalid", "Érvénytelen kérés.");
  if (p.data.confirmation.trim() !== ERASE_CONFIRMATION_WORD) throw new PrivacyError(400, "confirmation", `A végleges törléshez írd be pontosan: ${ERASE_CONFIRMATION_WORD}`);
  const [r] = await tx.query<{ customer_id: string | null }>("select customer_id from privacy_requests where id = $1", [p.data.requestId]);
  if (!r) throw new PrivacyError(404, "not_found", "A kérelem nem található.");
  if (!r.customer_id) throw new PrivacyError(409, "customer", "A kérelemhez nincs ügyfél rendelve.");
  await tx.query("select id from customers where id = $1 for update", [r.customer_id]);
  const hashes = await customerHashes(tx, r.customer_id);
  try {
    const [res] = await tx.query<{ r: Record<string, number> }>("select app_privacy_erase_customer($1, $2, $3::jsonb) as r", [r.customer_id, p.data.requestId, JSON.stringify(hashes)]);
    return { customerId: r.customer_id, counts: res.r };
  } catch (e) {
    throw mapPrivacyError(e) ?? e;
  }
}

// ------------------------------------------------------------------ Megőrzési felülvizsgálat (5. cikk (1) e))

/**
 * Jóváhagyott megőrzési rend (tulajdonos, 2026-11-25; docs/V1.3-DATA-PROTECTION.md 6. fejezet): érdeklődő / leendő ügyfél utolsó
 * tevékenységtől 24 hónap; „Elvesztett” jelentésű státusz 12 hónap; az eltávolított, nem anonimizált ügyfél 6 hónap. A szerződéses
 * ügyfél (mérföldkő-státusz: Számlanyitás, Tőke elhelyezve) nem kerül az inaktivitási felülvizsgálatba: rá a szerződéses viszony és az
 * irányadó megőrzési idő vonatkozik, a felülvizsgálat egyedi döntés.
 */
export interface RetentionSettings { inactiveMonths: number; lostMonths: number; removedMonths: number; requestLogDays: number }
const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};
export function retentionSettings(env: Record<string, string | undefined> = process.env): RetentionSettings {
  return {
    inactiveMonths: int(env.JG_RETENTION_INACTIVE_MONTHS, 24, 6, 120),
    lostMonths: int(env.JG_RETENTION_LOST_MONTHS, 12, 3, 120),
    removedMonths: int(env.JG_RETENTION_REMOVED_MONTHS, 6, 1, 60),
    requestLogDays: int(env.JG_RETENTION_REQUEST_LOG_DAYS, 30, 7, 365),
  };
}

export interface RetentionCandidate {
  customerId: string; name: string; type: "individual" | "company"; crmStatus: string | null; reason: "inactive" | "lost" | "removed";
  lastActivityAt: string; removedAt: string | null; restricted: boolean; openRequest: boolean;
}

/**
 * Felülvizsgálandó ügyfelek: (a) az aktív CRM-ben lévő, a megadott ideje semmilyen tevékenységet nem mutató ügyfelek; (b) a logikailag
 * eltávolított, de még nem anonimizált ügyfelek a megadott idő után. Automatikus törlés NINCS: a döntés (megtartás, törlési kérelem,
 * anonimizálás) emberi, és az anonimizálás csak rögzített kérelemmel, külön joggal történhet.
 */
export async function retentionReview(tx: Tx, settings: RetentionSettings, now: Date): Promise<{ settings: RetentionSettings; candidates: RetentionCandidate[] }> {
  const rows = await tx.query<Row>(
    `with last as (
       select c.id, greatest(c.updated_at, c.created_at,
         coalesce((select max(a.occurred_at) from activities a where a.customer_id = c.id), c.created_at),
         coalesce((select max(coalesce(t.completed_at, t.created_at)) from tasks t where t.customer_id = c.id), c.created_at)) as last_at
       from customers c where c.erased_at is null
     )
     select c.*, l.last_at, s.semantic_type, exists (select 1 from customer_restrictions r where r.customer_id = c.id) as restricted,
       exists (select 1 from privacy_requests pr where pr.customer_id = c.id and pr.status in ('open','in_progress')) as open_request
     from customers c join last l on l.id = c.id left join crm_pipeline_statuses s on s.key = c.crm_status
     where (c.deleted_at is not null and c.deleted_at < $2)
        or (c.deleted_at is null and s.semantic_type is not distinct from 'lost' and l.last_at < $3)
        or (c.deleted_at is null and coalesce(s.semantic_type, '') not in ('lost', 'milestone') and l.last_at < $1)
     order by (c.deleted_at is not null) desc, l.last_at limit 500`,
    [addMonthsIso(now, -settings.inactiveMonths), addMonthsIso(now, -settings.removedMonths), addMonthsIso(now, -settings.lostMonths)],
  );
  return {
    settings,
    candidates: rows.map((r) => {
      const c = customerFromRow(r);
      return {
        customerId: c.id, name: customerName(c), type: c.type, crmStatus: c.crmStatus ?? null, reason: r.deleted_at ? "removed" as const : r.semantic_type === "lost" ? "lost" as const : "inactive" as const,
        lastActivityAt: iso(r.last_at) as string, removedAt: iso(r.deleted_at), restricted: r.restricted === true, openRequest: r.open_request === true,
      };
    }),
  };
}
const addMonthsIso = (d: Date, m: number) => {
  const r = new Date(d.getTime());
  r.setUTCMonth(r.getUTCMonth() + m);
  return r.toISOString();
};

export async function privacyOverview(tx: Tx, now: Date): Promise<{ open: number; overdue: number; dueSoon: number; erased: number; suppressions: number }> {
  const [r] = await tx.query<Record<string, string>>(
    `select count(*) filter (where status in ('open','in_progress')) as open,
       count(*) filter (where status in ('open','in_progress') and due_at < $1) as overdue,
       count(*) filter (where status in ('open','in_progress') and due_at >= $1 and due_at <= $2) as due_soon
     from privacy_requests`, [now.toISOString(), new Date(now.getTime() + 7 * 24 * 3600_000).toISOString()]);
  const [e] = await tx.query<{ n: string }>("select count(*) as n from customers where erased_at is not null");
  const [s] = await tx.query<{ n: string }>("select count(*) as n from privacy_suppressions");
  return { open: Number(r.open), overdue: Number(r.overdue), dueSoon: Number(r.due_soon), erased: Number(e.n), suppressions: Number(s.n) };
}
