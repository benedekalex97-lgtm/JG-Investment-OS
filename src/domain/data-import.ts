import { CRM_STATUSES, CRM_STATUS_LABELS, DEFAULT_CRM_STATUS } from "./constants";
import { fold, phoneKey } from "./logic";

/**
 * Ügyféladat-import tartományi szabályai (v1.0, CRM-014 / CRM-015) - a kliens (mezőlista, felirat) és a szerver (validáció) közös
 * logikája, böngésző- és Node-független.
 *
 * Az importálható mezők KIZÁRÓLAG a CRM meglévő adatmodelljének mezői (ügyfél: típus, név / cégnév, telefonszám, e-mail, adatforrás,
 * magánszemélynél megjegyzés; céges kapcsolattartó: név, beosztás, telefonszám, e-mail). Új mező nincs.
 * A státusz oszlop csak ellenőrzésre szolgál: az importált ügyfél MINDIG „Feldolgozásra vár” (waiting_for_contact) státusszal jön
 * létre, a fájlban szereplő más státusz nem kerül átvételre (nincs automatikus státuszemelés). Megkeresési korlátozást, tiltakozást,
 * kapcsolati státuszt vagy igazolási adatot az import nem állít be és nem ír felül.
 */
export const IMPORT_FIELD_KEYS = [
  "type", "fullName", "lastName", "firstName", "companyName", "phone", "email",
  "contactName", "contactPosition", "contactPhone", "contactEmail", "notes", "source", "status",
] as const;
export type ImportFieldKey = (typeof IMPORT_FIELD_KEYS)[number];

export interface ImportFieldDef { key: ImportFieldKey; label: string; help: string; aliases: string[] }

/** Mezők, magyarázatok és a felismert (magyar/angol) oszlopnevek - normalizált alakban (kisbetű, ékezet és írásjel nélkül). */
export const IMPORT_FIELDS: readonly ImportFieldDef[] = [
  { key: "type", label: "Ügyféltípus", help: "Magánszemély vagy Cég. Ha nincs ilyen oszlop, az alapértelmezett típust az importnál kell megadni.", aliases: ["ugyfeltipus", "tipus", "type", "customertype", "ugyfelfajta"] },
  { key: "fullName", label: "Teljes név", help: "Magánszemély neve egy mezőben (vezetéknév elöl). Vagy ezt, vagy a Vezetéknév + Keresztnév párost használd.", aliases: ["nev", "teljesnev", "ugyfelneve", "ugyfelnev", "name", "fullname", "szemelynev"] },
  { key: "lastName", label: "Vezetéknév", help: "Magánszemély vezetékneve.", aliases: ["vezeteknev", "csaladnev", "lastname", "surname", "familyname"] },
  { key: "firstName", label: "Keresztnév", help: "Magánszemély keresztneve.", aliases: ["keresztnev", "utonev", "firstname", "givenname"] },
  { key: "companyName", label: "Cégnév", help: "Cég ügyfél neve (cégnél kötelező).", aliases: ["cegnev", "ceg", "cegneve", "company", "companyname", "vallalat", "vallalkozas", "szervezet", "organization"] },
  { key: "phone", label: "Telefonszám", help: "Az ügyfél telefonszáma. A magyar formák (+36, 06, 0036) egységes +36 alakra kerülnek.", aliases: ["telefonszam", "telefon", "tel", "mobil", "mobilszam", "phone", "mobile", "phonenumber"] },
  { key: "email", label: "E-mail", help: "Az ügyfél e-mail-címe.", aliases: ["email", "emailcim", "mail", "emailaddress", "levelcim"] },
  { key: "contactName", label: "Kapcsolattartó neve", help: "Cégnél a kapcsolattartó neve (vezetéknév elöl).", aliases: ["kapcsolattarto", "kapcsolattartoneve", "kapcsolattartonev", "kapcsolatiszemely", "contact", "contactname", "contactperson"] },
  { key: "contactPosition", label: "Kapcsolattartó beosztása", help: "Cégnél a kapcsolattartó beosztása.", aliases: ["beosztas", "kapcsolattartobeosztasa", "pozicio", "position", "jobtitle"] },
  { key: "contactPhone", label: "Kapcsolattartó telefonszáma", help: "Cégnél a kapcsolattartó telefonszáma (a kapcsolattartó vezeték- és keresztneve szükséges hozzá).", aliases: ["kapcsolattartotelefonszama", "kapcsolattartotelefon", "contactphone"] },
  { key: "contactEmail", label: "Kapcsolattartó e-mail-címe", help: "Cégnél a kapcsolattartó e-mail-címe (a kapcsolattartó vezeték- és keresztneve szükséges hozzá).", aliases: ["kapcsolattartoemail", "kapcsolattartoemailcime", "contactemail"] },
  { key: "notes", label: "Megjegyzés", help: "Csak magánszemélynél tárolható. Ne tartalmazzon különleges személyes adatot.", aliases: ["megjegyzes", "megjegyzesek", "jegyzet", "notes", "note", "comment"] },
  { key: "source", label: "Adatforrás (soronként)", help: "Ha üres, az import adatforrás-megnevezése kerül az ügyfélhez.", aliases: ["adatforras", "forras", "source", "datasource"] },
  { key: "status", label: "Státusz (csak ellenőrzés)", help: "Nem kerül átvételre: az importált ügyfél mindig „Feldolgozásra vár” státusszal jön létre.", aliases: ["statusz", "status", "pipelinestatusz", "allapot"] },
] as const;
export const IMPORT_FIELD_LABELS = Object.fromEntries(IMPORT_FIELDS.map((f) => [f.key, f.label])) as Record<ImportFieldKey, string>;

/** Oszlopnév normalizálása az automatikus felismeréshez. */
export const normalizeHeader = (h: string) => fold(h).replace(/[^a-z0-9]+/g, "");

/** Mapping: oszlopindex -> mező (vagy null: nem importált oszlop). */
export type ColumnMapping = (ImportFieldKey | null)[];

/**
 * Automatikus oszlopjavaslat: csak PONTOS (normalizált) egyezés a felismert nevekkel; bizonytalan egyezést nem javasol. Ugyanarra a
 * mezőre csak az első egyező oszlop kerül. A javaslat nem végleges - a felhasználó az előnézet előtt módosíthatja.
 */
export function suggestMapping(headers: string[]): ColumnMapping {
  const used = new Set<ImportFieldKey>();
  return headers.map((h) => {
    const n = normalizeHeader(h);
    if (!n) return null;
    const f = IMPORT_FIELDS.find((x) => x.aliases.includes(n) && !used.has(x.key));
    if (!f) return null;
    // A Teljes név és a Vezetéknév/Keresztnév kizárja egymást.
    if (f.key === "fullName" && (used.has("lastName") || used.has("firstName"))) return null;
    if ((f.key === "lastName" || f.key === "firstName") && used.has("fullName")) return null;
    used.add(f.key);
    return f.key;
  });
}

export type MappingProblem = { code: string; message: string };
/** A megfeleltetés szerkezeti ellenőrzése (az előnézet előtt). */
export function mappingProblems(mapping: ColumnMapping, defaultType: "individual" | "company" | null): MappingProblem[] {
  const out: MappingProblem[] = [];
  const keys = mapping.filter((k): k is ImportFieldKey => k !== null);
  const dup = [...new Set(keys.filter((k, i) => keys.indexOf(k) !== i))];
  for (const k of dup) out.push({ code: "duplicate_field", message: `A(z) „${IMPORT_FIELD_LABELS[k]}” mező több oszlophoz is hozzá van rendelve.` });
  const has = (k: ImportFieldKey) => keys.includes(k);
  if (has("fullName") && (has("lastName") || has("firstName"))) out.push({ code: "name_conflict", message: "A Teljes név és a Vezetéknév/Keresztnév mezők közül csak az egyik használható." });
  if (!has("fullName") && !has("lastName") && !has("firstName") && !has("companyName")) out.push({ code: "no_name", message: "Legalább egy névmezőt (Teljes név, Vezetéknév vagy Cégnév) hozzá kell rendelni." });
  if (!has("type") && !defaultType) out.push({ code: "no_type", message: "Nincs Ügyféltípus oszlop: válaszd ki az alapértelmezett ügyféltípust." });
  return out;
}

// ------------------------------------------------------------------------ normalizálás

const TYPE_VALUES: Record<string, "individual" | "company"> = {
  maganszemely: "individual", magan: "individual", mszemely: "individual", szemely: "individual", individual: "individual", person: "individual", private: "individual", m: "individual",
  ceg: "company", company: "company", vallalat: "company", vallalkozas: "company", tarsasag: "company", szervezet: "company", business: "company", c: "company",
};
export const parseCustomerType = (v: string): "individual" | "company" | null => TYPE_VALUES[normalizeHeader(v)] ?? null;

const STATUS_BY_LABEL = new Map<string, string>([
  ...CRM_STATUSES.map((k) => [normalizeHeader(k), k] as [string, string]),
  ...CRM_STATUSES.map((k) => [normalizeHeader(CRM_STATUS_LABELS[k]), k] as [string, string]),
]);
export const parseStatus = (v: string): string | null => STATUS_BY_LABEL.get(normalizeHeader(v)) ?? null;

export const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** A CRM űrlapjának telefonszám-szabálya (schemas.ts optPhone). */
export const CRM_PHONE_RE = /^\+?[0-9 ()/-]{6,20}$/;

export type PhoneResult = { ok: true; value: string; warning?: "unusual_format" } | { ok: false };
/**
 * Telefonszám-normalizálás (V04): a magyar formák (+36, 0036, 06 előhívó, szóköz/kötőjel/pont/zárójel) egységes „+36 30 123 4567”
 * alakra; budapesti (1) számnál „+36 1 234 5678”. Más (külföldi vagy előhívó nélküli) számnál csak a formázás tisztul, és figyelmeztetés
 * jár (nem találunk ki előhívót). A végeredménynek a CRM telefonszám-szabályán is át kell mennie.
 */
export function normalizePhone(raw: string): PhoneResult {
  const v = raw.trim();
  if (!v) return { ok: false };
  if (!/^[+0-9 ()/.\-]+$/.test(v)) return { ok: false };
  const key = phoneKey(v);
  const plus = v.startsWith("+");
  if (key.startsWith("36") && (plus || v.replace(/\D/g, "").startsWith("06") || v.replace(/\D/g, "").startsWith("0036") || /^36\d{9}$/.test(key))) {
    const rest = key.slice(2);
    if (rest.length === 9 && /^[2-9]/.test(rest)) return { ok: true, value: `+36 ${rest.slice(0, 2)} ${rest.slice(2, 5)} ${rest.slice(5)}` };
    if (rest.length === 8 && rest.startsWith("1")) return { ok: true, value: `+36 1 ${rest.slice(1, 4)} ${rest.slice(4)}` };
  }
  const cleaned = v.replace(/\./g, " ").replace(/\s+/g, " ").trim();
  if (!CRM_PHONE_RE.test(cleaned) || cleaned.replace(/\D/g, "").length < 6) return { ok: false };
  return { ok: true, value: cleaned, warning: "unusual_format" };
}

export const normalizeEmailValue = (v: string) => v.trim().toLowerCase();

// ------------------------------------------------------------------------ sor-validáció

export const IMPORT_LIMITS_TEXT = { name: 200, email: 254, position: 120, notes: 2000, source: 200 } as const;

export type IssueLevel = "error" | "warning";
export interface RowIssue { level: IssueLevel; field?: ImportFieldKey; code: string; message: string }

/** A normalizált, importálható sor (a CRM ügyfélűrlap bemenetének megfelelő alak). */
export interface ImportDraft {
  type: "individual" | "company";
  name?: string;
  companyName?: string;
  phone?: string;
  email?: string;
  notes?: string;
  contactName?: string;
  contactPosition?: string;
  contactPhone?: string;
  contactEmail?: string;
  source?: string;
}

export interface RowEvaluation {
  status: "valid" | "warning" | "error" | "empty";
  issues: RowIssue[];
  draft?: ImportDraft;
}

/** Egy cella jelzői (a fájlolvasóból): képlet vagy hibaérték. */
export interface CellNotes { formula?: boolean; error?: boolean }

const issue = (level: IssueLevel, code: string, message: string, field?: ImportFieldKey): RowIssue => ({ level, code, message, ...(field ? { field } : {}) });

/**
 * Egy adatsor ellenőrzése és normalizálása (V03-V07). A hibaüzenetek nem tartalmazzák a cellaértéket (a hibajegyzék így nem
 * hordoz felesleges személyes adatot).
 */
export function evaluateRow(cells: string[], mapping: ColumnMapping, defaultType: "individual" | "company" | null, notes: (col: number) => CellNotes = () => ({})): RowEvaluation {
  const issues: RowIssue[] = [];
  const val: Partial<Record<ImportFieldKey, string>> = {};
  let anyValue = false;
  mapping.forEach((key, col) => {
    const raw = (cells[col] ?? "").replace(/ /g, " ").trim();
    const n = notes(col);
    if (raw) anyValue = true;
    if (!key) return;
    if (n.formula) { issues.push(issue("error", "formula_cell", "Képletet tartalmazó cella: a képletek nem kerülnek kiértékelésre, az érték nem importálható.", key)); anyValue = true; return; }
    if (n.error) { issues.push(issue("error", "error_cell", "Hibás cellaérték (pl. #N/A).", key)); anyValue = true; return; }
    if (raw) val[key] = raw.replace(/\s+/g, " ");
  });
  // Teljesen üres sor (az importált és a nem importált oszlopokban is): kihagyható, nem hiba.
  if (!anyValue && !issues.length) return { status: "empty", issues: [] };

  for (const [k, v] of Object.entries(val) as [ImportFieldKey, string][]) {
    if (/^[=@]/.test(v)) issues.push(issue("warning", "formula_like", "Képletnek tűnő érték (=, @ kezdetű): szövegként kerül tárolásra, ellenőrizd.", k));
  }

  let type: "individual" | "company" | null = defaultType;
  if (val.type !== undefined) {
    type = parseCustomerType(val.type);
    if (!type) issues.push(issue("error", "unknown_type", "Ismeretlen ügyféltípus (elfogadott: Magánszemély, Cég).", "type"));
  } else if (!type) issues.push(issue("error", "missing_type", "Hiányzó ügyféltípus.", "type"));

  const tooLong = (k: ImportFieldKey, max: number) => {
    if ((val[k] ?? "").length > max) { issues.push(issue("error", "too_long", `Túl hosszú érték (legfeljebb ${max} karakter).`, k)); return true; }
    return false;
  };
  for (const k of ["fullName", "lastName", "firstName", "companyName", "contactName"] as const) tooLong(k, IMPORT_LIMITS_TEXT.name);
  tooLong("contactPosition", IMPORT_LIMITS_TEXT.position);
  tooLong("notes", IMPORT_LIMITS_TEXT.notes);
  tooLong("source", IMPORT_LIMITS_TEXT.source);

  const draft: ImportDraft = { type: type ?? "individual" };
  const personName = val.fullName ?? [val.lastName, val.firstName].filter(Boolean).join(" ");

  if (type === "individual") {
    if (!personName) issues.push(issue("error", "missing_name", "Hiányzó név (magánszemélynél kötelező).", val.lastName === undefined && val.firstName === undefined ? "fullName" : "lastName"));
    if (val.companyName) issues.push(issue("error", "type_mismatch", "Magánszemélynél nem adható meg cégnév (magánszemély/cég eltérés).", "companyName"));
    for (const k of ["contactName", "contactPosition", "contactPhone", "contactEmail"] as const) {
      if (val[k]) issues.push(issue("error", "type_mismatch", "Magánszemélynél nem adható meg kapcsolattartó (magánszemély/cég eltérés).", k));
    }
    draft.name = personName || undefined;
    draft.notes = val.notes;
  } else if (type === "company") {
    if (!val.companyName) issues.push(issue("error", "missing_company_name", "Hiányzó cégnév (cégnél kötelező).", "companyName"));
    if (personName) issues.push(issue("error", "type_mismatch", "Cégnél a személynév a „Kapcsolattartó neve” mezőbe tartozik (magánszemély/cég eltérés).", val.fullName !== undefined ? "fullName" : "lastName"));
    if (val.notes) issues.push(issue("warning", "notes_not_stored", "Cégnél megjegyzés nem tárolható: a megjegyzés nem kerül importálásra.", "notes"));
    draft.companyName = val.companyName;
    draft.contactName = val.contactName;
    draft.contactPosition = val.contactPosition;
    if ((val.contactPhone || val.contactEmail) && !val.contactName) issues.push(issue("error", "contact_name_required", "A kapcsolattartó elérhetőségéhez a kapcsolattartó neve kötelező.", "contactName"));
    if ((val.contactPhone || val.contactEmail) && val.contactName && val.contactName.split(" ").length < 2) {
      issues.push(issue("error", "contact_full_name_required", "A kapcsolattartó elérhetőségéhez vezeték- és keresztnév szükséges.", "contactName"));
    }
    if (val.contactPosition && !val.contactName) issues.push(issue("error", "contact_name_required", "A kapcsolattartó beosztásához a kapcsolattartó neve kötelező.", "contactName"));
  }

  const email = (k: "email" | "contactEmail") => {
    const v = val[k];
    if (v === undefined) return undefined;
    const e = normalizeEmailValue(v);
    if (e.length > IMPORT_LIMITS_TEXT.email || !EMAIL_RE.test(e)) { issues.push(issue("error", "invalid_email", "Érvénytelen e-mail-cím.", k)); return undefined; }
    return e;
  };
  const phone = (k: "phone" | "contactPhone") => {
    const v = val[k];
    if (v === undefined) return undefined;
    const p = normalizePhone(v);
    if (!p.ok) { issues.push(issue("error", "invalid_phone", "Érvénytelen telefonszám.", k)); return undefined; }
    if (p.warning) issues.push(issue("warning", "phone_format", "Nem szokásos (külföldi vagy előhívó nélküli) telefonszám-formátum: ellenőrizd.", k));
    return p.value;
  };
  draft.email = email("email");
  draft.phone = phone("phone");
  if (type === "company") {
    draft.contactEmail = email("contactEmail");
    draft.contactPhone = phone("contactPhone");
  }
  if (val.source) draft.source = val.source;

  if (val.status !== undefined) {
    const s = parseStatus(val.status);
    if (!s) issues.push(issue("warning", "unknown_status", "Ismeretlen státusz: nem kerül átvételre, az ügyfél „Feldolgozásra vár” státusszal jön létre.", "status"));
    else if (s !== DEFAULT_CRM_STATUS) issues.push(issue("warning", "status_not_applied", "A fájlban szereplő státusz nem kerül átvételre: az ügyfél „Feldolgozásra vár” státusszal jön létre.", "status"));
  }
  if (!draft.phone && !draft.email && !draft.contactPhone && !draft.contactEmail && !issues.some((i) => i.level === "error")) {
    issues.push(issue("warning", "no_contact", "Nincs megadva elérhetőség (telefonszám vagy e-mail)."));
  }

  const status = issues.some((i) => i.level === "error") ? "error" : issues.length ? "warning" : "valid";
  return { status, issues, ...(status === "error" ? {} : { draft }) };
}

// ------------------------------------------------------------------------ besorolás

/**
 * Sor-besorolás kódja (az import_jobs.row_states mezőben, személyes adat nélkül):
 *  V = új, érvényes; W = új, figyelmeztetéssel (döntés kell); P = lehetséges egyezés; S = erős egyezés; R = erős egyezés megkeresési
 *  korlátozással rendelkező ügyféllel (nem importálható); E = hibás; X = üres sor.
 */
export type RowState = "V" | "W" | "P" | "S" | "R" | "E" | "X";
export const ROW_STATE_SEVERITY: Record<RowState, number> = { X: 0, V: 1, W: 2, P: 3, S: 4, R: 9, E: 9 };
export const ROW_CATEGORY: Record<RowState, "NEW" | "POSSIBLE_MATCH" | "STRONG_MATCH" | "INVALID" | "EMPTY"> = {
  V: "NEW", W: "NEW", P: "POSSIBLE_MATCH", S: "STRONG_MATCH", R: "STRONG_MATCH", E: "INVALID", X: "EMPTY",
};
/** Importálható-e a sor kifejezett döntés nélkül (csak az új, figyelmeztetés nélküli sor). */
export const importsByDefault = (s: RowState) => s === "V";
/** Kérhető-e rá kifejezett „importálás új rekordként” döntés. */
export const canImportExplicitly = (s: RowState) => s === "V" || s === "W" || s === "P" || s === "S";

export type ImportDecision = "import" | "skip";

export const SOURCE_VERIFICATION = ["verified", "in_progress", "not_verified"] as const;
export type SourceVerification = (typeof SOURCE_VERIFICATION)[number];
export const SOURCE_VERIFICATION_LABELS: Record<SourceVerification, string> = {
  verified: "Ellenőrzött: a forrás eredete és felhasználási jogalapja dokumentált",
  in_progress: "Ellenőrzés folyamatban",
  not_verified: "Nem ellenőrzött",
};
