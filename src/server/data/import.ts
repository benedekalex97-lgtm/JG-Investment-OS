import { z } from "zod";
import { DemoRepository } from "@/data/repository";
import { CUSTOMER_TYPE_LABELS } from "@/domain/constants";
import {
  canImportExplicitly, evaluateRow, importsByDefault, IMPORT_FIELD_KEYS, mappingProblems, ROW_STATE_SEVERITY, SOURCE_VERIFICATION, suggestMapping,
  type ColumnMapping, type ImportDecision, type ImportDraft, type RowIssue, type RowState,
} from "@/domain/data-import";
import { findDuplicates, maskRemoved, nameKey, strongEmail, strongPhone, type DuplicateCandidate } from "@/domain/duplicates";
import { splitName } from "@/domain/logic";
import { companyContactInput } from "@/domain/schemas";
import { emptySnapshot, type CompanyContact, type Customer, type DataSnapshot } from "@/domain/types";
import type { AuthUser } from "../auth/service";
import { customerFromRow, contactFromRow, contactToRow, customerToRow, type Row } from "../crm/rows";
import { newId } from "../crm/ops";
import type { Tx } from "../db/types";
import type { DataLimits } from "./limits";
import { parseUpload, type FileType, type ParsedUpload } from "./upload";

/**
 * Ügyféladat-import (v1.0, CRM-014-016): előnézet és véglegesítés.
 *
 * Folyamat: (1) fájl + adatforrás + megfeleltetés -> (2) szerveroldali validáció és duplikáció-ellenőrzés -> (3) előnézet: az
 * import_jobs rekord (személyes adat nélkül) és a soronkénti eredmény a felhasználónak -> (4) kifejezett jóváhagyás: a felhasználó a
 * fájlt ÚJRA elküldi a döntéseivel; a szerver ellenőrzi, hogy a fájl lenyomata egyezik, a zárolás alatt ÚJRA lefuttatja a validációt
 * és a duplikáció-ellenőrzést az aktuális adatbázison, és csak az előnézetben látott (vagy enyhébb) besorolású sorokat menti.
 *
 * Biztonság és adatkonzisztencia:
 *  - a fájl sehol nem tárolódik; az import_jobs csak lenyomatot, számokat és besorolási kódokat tárol;
 *  - minden ügyfél a CRM meglévő ügyfélszabályain (DemoRepository.createCustomerFromForm) megy át; státusz MINDIG „Feldolgozásra vár”;
 *  - nincs összevonás, nincs meglévő ügyfél frissítése vagy felülírása; tiltakozással/korlátozással rendelkező ügyféllel erősen egyező
 *    sor nem importálható;
 *  - a véglegesítés egyetlen tranzakció (minden sor vagy semmi), a kézi ügyfélfelvitellel közös zárral sorba rendezve (párhuzamos
 *    import/felvitel sem hoz létre nem jóváhagyott duplikációt); az ismételt véglegesítés a tárolt eredményt adja, nem importál újra.
 */

// ------------------------------------------------------------------------- opciók

export const importOptions = z.object({
  fileType: z.enum(["csv", "xlsx"]),
  encoding: z.enum(["utf-8", "windows-1250"]).optional(),
  sheetIndex: z.number().int().min(0).max(255).optional(),
  mapping: z.array(z.enum(IMPORT_FIELD_KEYS).nullable()).max(200),
  defaultType: z.enum(["individual", "company"]).nullable(),
  sourceName: z.string().trim().min(1, "Az adatforrás megnevezése kötelező.").max(200),
  purpose: z.string().trim().min(1, "Az import céljának megadása kötelező.").max(500),
  sourceVerification: z.enum(SOURCE_VERIFICATION),
  complianceDeclared: z.boolean(),
}).strict();
export type ImportOptions = z.infer<typeof importOptions>;

export const commitBody = z.object({
  jobId: z.string().min(1).max(80),
  decisions: z.record(z.string().regex(/^\d{1,7}$/), z.enum(["import", "skip"])).refine((d) => Object.keys(d).length <= 20_000, "Túl sok döntés."),
}).strict();

// ------------------------------------------------------------------------- válaszformák

export interface MatchView {
  /** null: eltávolított (logikailag törölt) ügyfél - adatai nem jelennek meg. */
  customerId: string | null;
  name: string;
  typeLabel: string;
  level: "strong" | "possible";
  reasons: string[];
  restricted: boolean;
}
export interface PreviewRow {
  rowNo: number;
  state: RowState;
  issues: RowIssue[];
  display?: { typeLabel: string; name: string; phone?: string; email?: string; contactName?: string; contactPhone?: string; contactEmail?: string };
  matches: MatchView[];
  fileMatches: { rowNo: number; level: "strong" | "possible" }[];
}
export interface PreviewSummary { total: number; valid: number; warning: number; error: number; duplicate: number; strong: number; possible: number; restricted: number; empty: number; importByDefault: number }

// ------------------------------------------------------------------------- duplikáció-index

interface DupIndex {
  customers: Map<string, Customer>;
  contactsOf: Map<string, CompanyContact[]>;
  removed: Set<string>;
  restricted: Set<string>;
  byEmail: Map<string, Set<string>>;
  byPhone: Map<string, Set<string>>;
  byName: Map<string, Set<string>>;
}
const add = (m: Map<string, Set<string>>, k: string, id: string) => {
  if (!k) return;
  const s = m.get(k);
  if (s) s.add(id);
  else m.set(k, new Set([id]));
};

/** A teljes (eltávolított rekordokat is tartalmazó) ügyfélállomány indexe - a CRM-013 egyezési kulcsaival. */
async function loadIndex(tx: Tx): Promise<DupIndex> {
  const custRows = await tx.query<Row>("select * from customers");
  const contactRows = await tx.query<Row>("select * from company_contacts");
  const restrictionRows = await tx.query<{ customer_id: string }>("select customer_id from customer_restrictions");
  const idx: DupIndex = {
    customers: new Map(), contactsOf: new Map(), removed: new Set(), restricted: new Set(restrictionRows.map((r) => String(r.customer_id))),
    byEmail: new Map(), byPhone: new Map(), byName: new Map(),
  };
  for (const r of custRows) {
    const c = customerFromRow(r);
    idx.customers.set(c.id, c);
    if (r.deleted_at !== null && r.deleted_at !== undefined) idx.removed.add(c.id);
    add(idx.byEmail, strongEmail(c.email), c.id);
    add(idx.byPhone, strongPhone(c.phone), c.id);
    add(idx.byName, c.type === "company" ? `c:${nameKey(c.companyName, true)}` : `i:${nameKey(c.displayName)}`, c.id);
  }
  for (const r of contactRows) {
    const k = contactFromRow(r);
    const list = idx.contactsOf.get(k.companyId) ?? [];
    list.push(k);
    idx.contactsOf.set(k.companyId, list);
    add(idx.byEmail, strongEmail(k.email), k.companyId);
    add(idx.byPhone, strongPhone(k.phone), k.companyId);
    add(idx.byName, `k:${nameKey(`${k.lastName} ${k.firstName}`)}`, k.companyId);
  }
  return idx;
}

function dbMatches(idx: DupIndex, d: ImportDraft): MatchView[] {
  const ids = new Set<string>();
  const look = (m: Map<string, Set<string>>, k: string) => { if (k) for (const id of m.get(k) ?? []) ids.add(id); };
  for (const e of [d.email, d.contactEmail]) look(idx.byEmail, strongEmail(e));
  for (const p of [d.phone, d.contactPhone]) look(idx.byPhone, strongPhone(p));
  if (d.type === "individual") {
    const k = nameKey(d.name ?? "");
    if (k) { look(idx.byName, `i:${k}`); look(idx.byName, `k:${k}`); }
  } else {
    const ck = nameKey(d.companyName ?? "", true);
    if (ck) look(idx.byName, `c:${ck}`);
    const pk = nameKey(d.contactName ?? "");
    if (pk) { look(idx.byName, `k:${pk}`); look(idx.byName, `i:${pk}`); }
  }
  if (!ids.size) return [];
  const customers = [...ids].map((id) => idx.customers.get(id)).filter((c): c is Customer => Boolean(c));
  const contacts = customers.flatMap((c) => idx.contactsOf.get(c.id) ?? []);
  const sub = { customers, contacts };
  const base = { type: d.type, name: d.name, companyName: d.companyName, contactName: d.contactName } as const;
  // A CRM-013 egyezésvizsgálata: az ügyfél és (cégnél) a kapcsolattartó elérhetőségével is.
  const found: DuplicateCandidate[] = [...findDuplicates(sub, { ...base, phone: d.phone, email: d.email })];
  if (d.contactPhone || d.contactEmail) found.push(...findDuplicates(sub, { ...base, phone: d.contactPhone, email: d.contactEmail }));
  const merged = new Map<string, DuplicateCandidate>();
  for (const f of found) {
    const id = f.customerId as string;
    const prev = merged.get(id);
    if (!prev) merged.set(id, f);
    else {
      const codes = [...prev.codes], reasons = [...prev.reasons];
      f.codes.forEach((c, i) => { if (!reasons.includes(f.reasons[i])) { codes.push(c); reasons.push(f.reasons[i]); } });
      merged.set(id, { ...prev, level: prev.level === "strong" || f.level === "strong" ? "strong" : "possible", codes, reasons });
    }
  }
  return [...merged.values()].map((m) => {
    const id = m.customerId as string;
    const restricted = idx.restricted.has(id);
    const view = idx.removed.has(id) ? maskRemoved(m) : m;
    return { customerId: view.customerId, name: view.name, typeLabel: view.typeLabel, level: view.level, reasons: view.reasons, restricted };
  }).sort((a, b) => Number(a.level === "possible") - Number(b.level === "possible"));
}

/** Fájlon belüli egyezés: a korábbi (nem hibás) sorokkal azonos e-mail / telefonszám (erős) vagy azonos név (lehetséges). */
class FileIndex {
  private strong = new Map<string, number>();
  private names = new Map<string, number>();
  match(d: ImportDraft): { rowNo: number; level: "strong" | "possible" }[] {
    const out = new Map<number, "strong" | "possible">();
    for (const k of this.strongKeys(d)) { const r = this.strong.get(k); if (r !== undefined) out.set(r, "strong"); }
    for (const k of this.nameKeys(d)) { const r = this.names.get(k); if (r !== undefined && !out.has(r)) out.set(r, "possible"); }
    return [...out.entries()].map(([rowNo, level]) => ({ rowNo, level })).sort((a, b) => a.rowNo - b.rowNo);
  }
  add(d: ImportDraft, rowNo: number) {
    for (const k of this.strongKeys(d)) if (!this.strong.has(k)) this.strong.set(k, rowNo);
    for (const k of this.nameKeys(d)) if (!this.names.has(k)) this.names.set(k, rowNo);
  }
  private strongKeys(d: ImportDraft) {
    return [`e:${strongEmail(d.email)}`, `e:${strongEmail(d.contactEmail)}`, `p:${strongPhone(d.phone)}`, `p:${strongPhone(d.contactPhone)}`].filter((k) => k.length > 2);
  }
  private nameKeys(d: ImportDraft) {
    const k = d.type === "company" ? `c:${nameKey(d.companyName ?? "", true)}` : `i:${nameKey(d.name ?? "")}`;
    return k.length > 2 ? [k] : [];
  }
}

// ------------------------------------------------------------------------- CRM-szabályok

/** A CRM ügyfélűrlapjának bemenete az importált sorból (a felelős és rögzítő a hitelesített felhasználó). */
function formInput(d: ImportDraft, source: string, userId: string): Record<string, unknown> {
  const base: Record<string, unknown> = { type: d.type, source: d.source ?? source, recordedBy: userId };
  if (d.phone) base.phone = d.phone;
  if (d.email) base.email = d.email;
  if (d.type === "individual") {
    base.name = d.name;
    if (d.notes) base.notes = d.notes;
  } else {
    base.companyName = d.companyName;
    if (d.contactName) base.contactName = d.contactName;
    if (d.contactPosition) base.contactPosition = d.contactPosition;
  }
  return base;
}

/**
 * Az ügyfél (és kapcsolattartó) létrehozása a CRM tartományi szabályaival egy közös repóban. A kapcsolattartó elérhetőségét a CRM
 * kapcsolattartó-szabálya (companyContactInput) előre ellenőrzi, így hiba esetén a repóba semmi nem kerül.
 */
function createViaCrm(repo: DemoRepository, d: ImportDraft, source: string, userId: string): { ok: true; customerId: string } | { ok: false; message: string } {
  const contactInfo = d.type === "company" && d.contactName && (d.contactPhone || d.contactEmail);
  if (contactInfo) {
    const { firstName, lastName } = splitName(d.contactName as string);
    const chk = companyContactInput.safeParse({ firstName, lastName, ...(d.contactPosition ? { position: d.contactPosition } : {}), ...(d.contactEmail ? { email: d.contactEmail } : {}), ...(d.contactPhone ? { phone: d.contactPhone } : {}), isPrimaryContact: true });
    if (!chk.success) return { ok: false, message: chk.error.issues[0]?.message ?? "A kapcsolattartó adatai érvénytelenek." };
  }
  const r = repo.createCustomerFromForm(formInput(d, source, userId));
  if (!r.ok) return { ok: false, message: Object.values(r.errors)[0] ?? "A CRM ügyfélszabályai szerint érvénytelen." };
  const contact = r.value.contact;
  if (contact && contactInfo) {
    const u = repo.updateContact(contact.id, {
      firstName: contact.firstName, lastName: contact.lastName, ...(contact.position ? { position: contact.position } : {}),
      ...(d.contactEmail ? { email: d.contactEmail } : {}), ...(d.contactPhone ? { phone: d.contactPhone } : {}), isPrimaryContact: true,
    });
    if (!u.ok) throw new Error("A kapcsolattartó előzetesen ellenőrzött adatai nem menthetők.");
  }
  return { ok: true, customerId: r.value.customer.id };
}

// ------------------------------------------------------------------------- kiértékelés

/**
 * `rows`: a nem üres sorok (az előnézeti válasz); `states`: MINDEN adatsor (üres is, X) besorolási kódja a fájl sorrendjében, `order`:
 * ugyanígy a sorszámok - a véglegesítés ezek alapján illeszti az előnézet besorolását. Az üres sorok száma a parser kerete miatt korlátos.
 */
interface Evaluated { rows: PreviewRow[]; drafts: Map<number, ImportDraft>; states: RowState[]; order: number[]; summary: PreviewSummary }

/** A kiértékelés (validáció + duplikáció) teljes munkájának időkerete: túllépésnél hiba, nem részleges eredmény. */
function checkDeadline(deadline: number) {
  if (Date.now() > deadline) throw new ImportError("timeout", "A fájl feldolgozása túl sokáig tartott. Bontsd kisebb részekre.", 400);
}

function evaluate(upload: ParsedUpload, opts: ImportOptions, idx: DupIndex, userId: string, deadline: number): Evaluated {
  const mapping: ColumnMapping = upload.headers.map((_h, i) => opts.mapping[i] ?? null);
  const fileIdx = new FileIndex();
  const scratch = () => new DemoRepository(emptySnapshot(), { idGen: newId });
  const rows: PreviewRow[] = [];
  const drafts = new Map<number, ImportDraft>();
  const states: RowState[] = [];
  const order: number[] = [];
  const s: PreviewSummary = { total: 0, valid: 0, warning: 0, error: 0, duplicate: 0, strong: 0, possible: 0, restricted: 0, empty: 0, importByDefault: 0 };
  for (const { rowNo, cells } of upload.rows) {
    checkDeadline(deadline);
    order.push(rowNo);
    const ev = evaluateRow(cells, mapping, opts.defaultType, (col) => ({ formula: upload.formulaCells.has(`${rowNo}:${col}`), error: upload.errorCells.has(`${rowNo}:${col}`) }));
    if (ev.status === "empty") {
      // Üres sor: csak számoljuk (summary.empty); nem kerül az előnézeti válaszba és az import_results táblába.
      states.push("X");
      s.empty++;
      continue;
    }
    s.total++;
    const issues = [...ev.issues];
    let d = ev.draft;
    // A CRM saját ügyfélszabályai (pl. telefonszám-formátum, kötelező mezők) is lefutnak: az előnézet és a mentés ugyanazt fogadja el.
    if (d) {
      const chk = createViaCrm(scratch(), d, opts.sourceName, userId);
      if (!chk.ok) { issues.push({ level: "error", code: "crm_rule", message: chk.message }); d = undefined; }
    }
    const display = d ? {
      typeLabel: CUSTOMER_TYPE_LABELS[d.type], name: (d.type === "company" ? d.companyName : d.name) ?? "",
      ...(d.phone ? { phone: d.phone } : {}), ...(d.email ? { email: d.email } : {}), ...(d.contactName ? { contactName: d.contactName } : {}),
      ...(d.contactPhone ? { contactPhone: d.contactPhone } : {}), ...(d.contactEmail ? { contactEmail: d.contactEmail } : {}),
    } : undefined;
    if (!d) {
      rows.push({ rowNo, state: "E", issues, matches: [], fileMatches: [] });
      states.push("E");
      s.error++;
      continue;
    }
    const matches = dbMatches(idx, d);
    const fileMatches = fileIdx.match(d);
    fileIdx.add(d, rowNo);
    const strong = matches.some((m) => m.level === "strong") || fileMatches.some((m) => m.level === "strong");
    const restricted = matches.some((m) => m.level === "strong" && m.restricted);
    const possible = !strong && (matches.length > 0 || fileMatches.length > 0);
    if (restricted) issues.push({ level: "error", code: "restricted_match", message: "Az egyező ügyfélnél megkeresési korlátozás vagy tiltakozás van nyilvántartva: a sor nem importálható." });
    else if (matches.some((m) => m.restricted)) issues.push({ level: "warning", code: "restricted_similar", message: "Hasonló nevű ügyfélnél megkeresési korlátozás vagy tiltakozás van nyilvántartva: ellenőrizd, nem ugyanaz a személy-e." });
    const state: RowState = restricted ? "R" : strong ? "S" : possible ? "P" : ev.status === "warning" || issues.some((i) => i.level === "warning") ? "W" : "V";
    rows.push({ rowNo, state, issues, display, matches, fileMatches });
    drafts.set(rowNo, d);
    states.push(state);
    if (state === "V") s.valid++;
    if (state === "W") s.warning++;
    if (state === "S" || state === "R") s.strong++;
    if (state === "P") s.possible++;
    if (state === "R") s.restricted++;
    if (state === "S" || state === "P" || state === "R") s.duplicate++;
    if (importsByDefault(state)) s.importByDefault++;
  }
  return { rows, drafts, states, order, summary: s };
}

// ------------------------------------------------------------------------- műveletek

export class ImportError extends Error {
  constructor(public readonly code: string, message: string, public readonly status = 400) {
    super(message);
  }
}

export interface InspectResult {
  fileType: FileType; sha256: string; size: number; sheets: { name: string; hidden: boolean }[]; sheetIndex: number;
  encoding?: string; delimiter?: string; headers: string[]; samples: string[][]; rowCount: number; emptyRows: number; suggestedMapping: ColumnMapping;
}

/** 1. lépés: a fájl szerkezete (munkalapok, fejléc, minta, javasolt megfeleltetés). Adatbázisba nem ír. */
export function inspect(bytes: Buffer, fileType: string, opts: { encoding?: string; sheetIndex?: number }, limits: DataLimits): InspectResult {
  const u = parseUpload(bytes, fileType, opts, limits);
  const samples = u.headers.map((_h, col) => u.rows.map((r) => (r.cells[col] ?? "").trim()).filter(Boolean).slice(0, 2).map((v) => v.slice(0, 60)));
  return {
    fileType: u.fileType, sha256: u.sha256, size: u.size, sheets: u.sheets, sheetIndex: u.sheetIndex, encoding: u.encoding, delimiter: u.delimiter,
    headers: u.headers, samples, rowCount: u.rows.length - u.emptyRows, emptyRows: u.emptyRows, suggestedMapping: suggestMapping(u.headers),
  };
}

export interface PreviewResult { jobId: string; summary: PreviewSummary; rows: PreviewRow[]; expiresAt: string; commitAllowed: boolean; commitBlockers: string[] }

export function commitBlockers(opts: { sourceVerification: string; complianceDeclared: boolean }, importEnabled: boolean): string[] {
  const out: string[] = [];
  if (!importEnabled) out.push("Az importálás véglegesítése ebben a környezetben nincs engedélyezve (adatkezelési jóváhagyásra vár). Az előnézet elkészíthető, adat nem kerül mentésre.");
  if (opts.sourceVerification !== "verified") out.push("A véglegesítéshez a forrásadatok ellenőrzött státusza szükséges.");
  if (!opts.complianceDeclared) out.push("A véglegesítéshez a nyilatkozat elfogadása szükséges.");
  return out;
}

/** 2-3. lépés: előnézet. Az import_jobs rekord létrejön (személyes adat nélkül); ügyfél NEM jön létre. */
export async function preview(tx: Tx, user: AuthUser, bytes: Buffer, rawOpts: unknown, limits: DataLimits, importEnabled: boolean, now: Date): Promise<PreviewResult> {
  const parsedOpts = importOptions.safeParse(rawOpts);
  if (!parsedOpts.success) throw new ImportError("bad_options", parsedOpts.error.issues[0]?.message ?? "Érvénytelen importbeállítás.");
  const opts = parsedOpts.data;
  const deadline = Date.now() + limits.maxSeconds * 1000;
  const upload = parseUpload(bytes, opts.fileType, { encoding: opts.encoding, sheetIndex: opts.sheetIndex }, limits);
  if (opts.mapping.length !== upload.headers.length) throw new ImportError("bad_mapping", "Az oszlop-megfeleltetés nem egyezik a fájl oszlopaival.");
  const problems = mappingProblems(opts.mapping, opts.defaultType);
  if (problems.length) throw new ImportError("bad_mapping", problems[0].message);
  const idx = await loadIndex(tx);
  const ev = evaluate(upload, opts, idx, user.id, deadline);
  const jobId = newId("imp");
  const expires = new Date(now.getTime() + limits.previewTtlMinutes * 60_000);
  const options = { fileType: opts.fileType, encoding: opts.encoding ?? null, sheetIndex: upload.sheetIndex, mapping: opts.mapping, defaultType: opts.defaultType };
  await tx.query(
    `insert into import_jobs (id, created_at, created_by, status, file_type, file_sha256, file_size, source_name, purpose, source_verification, compliance_declared, options, row_states,
       total_rows, valid_rows, warning_rows, error_rows, duplicate_rows, empty_rows, expires_at)
     values ($1,$2,$3,'previewed',$4,$5,$6,$7,$8,$9,$10,$11::jsonb,$12,$13,$14,$15,$16,$17,$18,$19)`,
    [jobId, now.toISOString(), user.id, upload.fileType, upload.sha256, upload.size, opts.sourceName, opts.purpose, opts.sourceVerification, opts.complianceDeclared,
      JSON.stringify(options), ev.states.join(""), ev.summary.total, ev.summary.valid, ev.summary.warning, ev.summary.error, ev.summary.duplicate, ev.summary.empty, expires.toISOString()],
  );
  await audit(tx, user.id, "import.preview", jobId, { fileType: upload.fileType, size: upload.size, rows: ev.summary.total, errors: ev.summary.error, duplicates: ev.summary.duplicate });
  const blockers = commitBlockers(opts, importEnabled);
  return { jobId, summary: ev.summary, rows: ev.rows, expiresAt: expires.toISOString(), commitAllowed: blockers.length === 0, commitBlockers: blockers };
}

export interface CommitResult {
  jobId: string; replayed: boolean; created: number; skipped: number;
  /** Üres sorok száma: nem kerülnek az import_results táblába (csak az összesítőbe). */
  empty: number;
  outcomes: Record<string, number>;
  rows: { rowNo: number; outcome: string; customerId?: string }[];
}

const OUTCOME_OF: Record<RowState, string> = { X: "skipped_empty", E: "skipped_error", R: "skipped_restricted", V: "skipped_user", W: "skipped_user", P: "skipped_duplicate", S: "skipped_duplicate" };

async function storedCommit(tx: Tx, jobId: string): Promise<CommitResult> {
  const job = (await tx.query<{ created_count: number; skipped_count: number; empty_rows: number }>("select created_count, skipped_count, empty_rows from import_jobs where id = $1", [jobId]))[0];
  const res = await tx.query<{ row_no: number; outcome: string; customer_id: string | null }>("select row_no, outcome, customer_id from import_results where job_id = $1 order by row_no", [jobId]);
  const outcomes: Record<string, number> = {};
  for (const r of res) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  return { jobId, replayed: true, created: Number(job?.created_count ?? 0), skipped: Number(job?.skipped_count ?? 0), empty: Number(job?.empty_rows ?? 0), outcomes, rows: res.map((r) => ({ rowNo: Number(r.row_no), outcome: r.outcome, ...(r.customer_id ? { customerId: r.customer_id } : {}) })) };
}

/** Kötegelt beszúrás új sorokra (legfeljebb 500 soronként), a meglévő sor-leképezésekkel; RLS és CHECK-ek érvényesek. */
async function insertBatch(tx: Tx, table: "customers" | "company_contacts", rows: Row[]) {
  for (let i = 0; i < rows.length; i += 500) {
    const chunk = rows.slice(i, i + 500);
    if (!chunk.length) continue;
    const cols = Object.keys(chunk[0]);
    await tx.query(`insert into ${table} (${cols.join(", ")}) select ${cols.join(", ")} from json_populate_recordset(null::${table}, $1::json)`, [JSON.stringify(chunk)]);
  }
}

/**
 * 4. lépés: véglegesítés. Egyetlen tranzakció; a szerver újraellenőriz mindent (fájl lenyomata, jogosultság, határidő, validáció,
 * duplikáció az aktuális adatbázison). Döntés nélkül csak az új, figyelmeztetés nélküli sor kerül mentésre; minden más sorhoz
 * kifejezett „import” döntés kell, és csak akkor, ha a sor besorolása azóta nem lett súlyosabb (pl. közben létrejött egyező ügyfél).
 */
export async function commit(tx: Tx, user: AuthUser, bytes: Buffer, rawBody: unknown, limits: DataLimits, importEnabled: boolean, now: Date): Promise<CommitResult> {
  const body = commitBody.safeParse(rawBody);
  if (!body.success) throw new ImportError("bad_request", "Érvénytelen kérés.");
  const { jobId, decisions } = body.data;
  const jobs = await tx.query<Row>("select * from import_jobs where id = $1 for update", [jobId]);
  const job = jobs[0];
  if (!job || job.created_by !== user.id) throw new ImportError("not_found", "Az import nem található.", 404);
  if (job.status === "completed") return storedCommit(tx, jobId);
  const blockers = commitBlockers({ sourceVerification: String(job.source_verification), complianceDeclared: job.compliance_declared === true }, importEnabled);
  if (blockers.length) throw new ImportError("blocked", blockers[0], 403);
  if (new Date(String(job.expires_at instanceof Date ? job.expires_at.toISOString() : job.expires_at)).getTime() < now.getTime()) {
    throw new ImportError("expired", "Az előnézet lejárt. Készíts új előnézetet.", 409);
  }
  const deadline = Date.now() + limits.maxSeconds * 1000;
  const stored = job.options as { fileType: FileType; encoding: string | null; sheetIndex: number; mapping: ColumnMapping; defaultType: "individual" | "company" | null };
  const upload = parseUpload(bytes, stored.fileType, { encoding: stored.encoding ?? undefined, sheetIndex: stored.sheetIndex }, limits);
  if (upload.sha256 !== job.file_sha256 || upload.size !== Number(job.file_size)) throw new ImportError("file_mismatch", "A fájl eltér az előnézetben használttól. Készíts új előnézetet.", 409);

  // A kézi ügyfélfelvitellel (customer.create) közös zár: párhuzamos import vagy felvitel nem hozhat létre nem jóváhagyott duplikációt.
  await tx.query("select pg_advisory_xact_lock(hashtextextended('jg.customer.create', 0))");
  const opts: ImportOptions = {
    fileType: stored.fileType, ...(stored.encoding ? { encoding: stored.encoding as "utf-8" | "windows-1250" } : {}), sheetIndex: stored.sheetIndex,
    mapping: stored.mapping, defaultType: stored.defaultType, sourceName: String(job.source_name), purpose: String(job.purpose),
    sourceVerification: job.source_verification as ImportOptions["sourceVerification"], complianceDeclared: job.compliance_declared === true,
  };
  const ev = evaluate(upload, opts, await loadIndex(tx), user.id, deadline);
  const previewStates = String(job.row_states);
  // Az előnézet besorolása sorszám szerint (a row_states a fájl összes adatsorát - az üreseket is - tartalmazza, sorrendben).
  if (previewStates.length !== ev.order.length) throw new ImportError("file_mismatch", "A fájl eltér az előnézetben használttól. Készíts új előnézetet.", 409);
  const beforeOf = new Map(ev.order.map((rowNo, i) => [rowNo, previewStates[i] as RowState]));
  const repo = new DemoRepository(emptySnapshot(), { clock: () => now, idGen: newId });
  const results: { rowNo: number; outcome: string; customerId?: string }[] = [];
  ev.rows.forEach((row) => {
    checkDeadline(deadline);
    const before = beforeOf.get(row.rowNo) ?? "E";
    const nowState = row.state;
    const decision: ImportDecision | undefined = decisions[String(row.rowNo)];
    let outcome = OUTCOME_OF[nowState];
    // A felhasználó szándéka: kifejezett „import”, vagy döntés nélkül az előnézetben alapból importálandó (új, érvényes) sor.
    const intended = decision === "import" || (decision === undefined && importsByDefault(before));
    if (decision === "skip") outcome = "skipped_user";
    else if (intended && canImportExplicitly(nowState) && canImportExplicitly(before)) {
      // Csak az előnézetben látott (vagy enyhébb) besorolás menthető; döntés nélkül csak a továbbra is új, érvényes sor.
      const allowed = ROW_STATE_SEVERITY[nowState] <= ROW_STATE_SEVERITY[before] && (decision === "import" || importsByDefault(nowState));
      if (!allowed) outcome = "skipped_changed";
      else {
        const d = ev.drafts.get(row.rowNo);
        const r = d ? createViaCrm(repo, d, opts.sourceName, user.id) : { ok: false as const, message: "" };
        if (r.ok) { results.push({ rowNo: row.rowNo, outcome: "created", customerId: r.customerId }); return; }
        outcome = "skipped_error";
      }
    }
    results.push({ rowNo: row.rowNo, outcome });
  });

  const after: DataSnapshot = repo.getSnapshot();
  await insertBatch(tx, "customers", after.customers.map(customerToRow));
  await insertBatch(tx, "company_contacts", [...after.contacts].sort((a, b) => Number(a.isPrimaryContact) - Number(b.isPrimaryContact)).map(contactToRow));
  const created = results.filter((r) => r.outcome === "created");
  for (let i = 0; i < created.length; i += 500) {
    const chunk = created.slice(i, i + 500).map((r) => {
      const c = after.customers.find((x) => x.id === r.customerId);
      return { user_id: user.id, action: "customer.create", entity_type: "customer", entity_id: r.customerId, customer_id: r.customerId, detail: { type: c?.type, crmStatus: c?.crmStatus, via: "import", importId: jobId } };
    });
    await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail) select user_id, action, entity_type, entity_id, customer_id, detail from json_populate_recordset(null::audit_events, $1::json)", [JSON.stringify(chunk)]);
  }
  for (let i = 0; i < results.length; i += 1000) {
    const chunk = results.slice(i, i + 1000).map((r) => ({ job_id: jobId, row_no: r.rowNo, outcome: r.outcome, customer_id: r.customerId ?? null }));
    await tx.query("insert into import_results (job_id, row_no, outcome, customer_id) select job_id, row_no, outcome, customer_id from json_populate_recordset(null::import_results, $1::json)", [JSON.stringify(chunk)]);
  }
  const outcomes: Record<string, number> = {};
  for (const r of results) outcomes[r.outcome] = (outcomes[r.outcome] ?? 0) + 1;
  const skipped = results.length - created.length;
  await tx.query("update import_jobs set status = 'completed', committed_at = $2, committed_by = $3, created_count = $4, skipped_count = $5 where id = $1 and status = 'previewed'", [jobId, now.toISOString(), user.id, created.length, skipped]);
  await audit(tx, user.id, "import.commit", jobId, { created: created.length, skipped, outcomes });
  return { jobId, replayed: false, created: created.length, skipped, empty: ev.summary.empty, outcomes, rows: results };
}

export async function audit(tx: Tx, userId: string, action: string, entityId: string | null, detail: Record<string, unknown>) {
  await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, detail) values ($1, $2, 'data', $3, $4::jsonb)", [userId, action, entityId, JSON.stringify(detail)]);
}

export interface ImportJobView {
  id: string; createdAt: string; createdBy: string; createdByName: string; status: string; expired: boolean; fileType: string; fileSha256: string; fileSize: number;
  sourceName: string; purpose: string; sourceVerification: string; complianceDeclared: boolean;
  totalRows: number; validRows: number; warningRows: number; errorRows: number; duplicateRows: number; emptyRows: number;
  createdCount: number | null; skippedCount: number | null; committedAt: string | null; committedByName: string | null;
}

/** Importnapló (CRM-016): személyes adat nélküli metaadatok, legfeljebb 200 legutóbbi. */
export async function listJobs(tx: Tx, users: { id: string; name: string }[], now: Date): Promise<ImportJobView[]> {
  const rows = await tx.query<Row>("select * from import_jobs order by created_at desc, id desc limit 200");
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const t = (v: unknown) => (v === null || v === undefined ? null : v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());
  return rows.map((r) => ({
    id: String(r.id), createdAt: t(r.created_at) as string, createdBy: String(r.created_by), createdByName: nameOf.get(String(r.created_by)) ?? String(r.created_by),
    status: String(r.status), expired: r.status === "previewed" && new Date(t(r.expires_at) as string).getTime() < now.getTime(),
    fileType: String(r.file_type), fileSha256: String(r.file_sha256), fileSize: Number(r.file_size), sourceName: String(r.source_name), purpose: String(r.purpose),
    sourceVerification: String(r.source_verification), complianceDeclared: r.compliance_declared === true,
    totalRows: Number(r.total_rows), validRows: Number(r.valid_rows), warningRows: Number(r.warning_rows), errorRows: Number(r.error_rows), duplicateRows: Number(r.duplicate_rows), emptyRows: Number(r.empty_rows),
    createdCount: r.created_count === null ? null : Number(r.created_count), skippedCount: r.skipped_count === null ? null : Number(r.skipped_count),
    committedAt: t(r.committed_at), committedByName: r.committed_by ? nameOf.get(String(r.committed_by)) ?? String(r.committed_by) : null,
  }));
}
