import { BUILTIN_CRM_CONFIG } from "./config";

/**
 * Konfigurálható konstansok (v0.2). A megnevezések üzleti review alatt állnak.
 * Minden státusz és mérföldkő DEMÓ-célú, előzetes: nem jogi vagy szolgáltatói igazolás.
 */

export const CUSTOMER_TYPES = ["individual", "company"] as const;
export const CUSTOMER_TYPE_LABELS = { individual: "Magánszemély", company: "Cég" } as const;

/** Kapcsolati státusz: az ügyfél hosszabb távú kapcsolata, a folyamatstátusztól független. */
export const CONTACT_STATUSES = ["prospect", "existing_verified", "former_verified", "archived"] as const;
export const CONTACT_STATUS_LABELS = {
  prospect: "Potenciális ügyfél",
  existing_verified: "Meglévő ügyfél — igazolt",
  former_verified: "Korábbi ügyfél — igazolt",
  archived: "Archivált",
} as const;
/** Ezekre a besorolásokra csak igazolási forrás megadásával lehet váltani. */
export const VERIFIED_CONTACT_STATUSES = ["existing_verified", "former_verified"] as const;

export const RESTRICTION_KINDS = ["objection", "restriction"] as const;
export const RESTRICTION_LABELS = { objection: "Tiltakozás", restriction: "Megkeresési korlátozás" } as const;

// ------------------------------------------------------- Egyszerű CRM (v0.5) - v1.1-től katalógus
/**
 * A v1.0-ig kódba égetett hét státusz (kulcs, megnevezés, sorrend) - v1.1-től CSAK a beépített alapkonfiguráció leírása
 * (`BUILTIN_CRM_CONFIG`, ebből tölti fel a 0008 migráció a katalógust). A futó alkalmazás a státuszokat az adatbázis katalógusából
 * veszi (`DataSnapshot.config`); ezeket a listákat ne használd megjelenítésre vagy validációra (pl. az import fejlécfelismerése és a
 * tesztek használják). A kulcsok és az adatbázis-értékek változatlanok.
 */
export const CRM_STATUSES: readonly string[] = BUILTIN_CRM_CONFIG.statuses.map((s) => s.key);
export const CRM_STATUS_LABELS: Readonly<Record<string, string>> = Object.fromEntries(BUILTIN_CRM_CONFIG.statuses.map((s) => [s.key, s.label]));
export const DEFAULT_CRM_STATUS = "waiting_for_contact" as const;

// ------------------------------------------------------------------ Folyamat (régi, háttérben megőrzött)
export const PROCESS_TYPES = ["outbound_outreach", "inbound_inquiry"] as const;
export const PROCESS_TYPE_LABELS = { outbound_outreach: "Kimenő kapcsolatépítés", inbound_inquiry: "Bejövő érdeklődés" } as const;

export const OUTREACH_CHANNELS = ["phone", "email", "web_form", "referral", "in_person", "other"] as const;
export const OUTREACH_CHANNEL_LABELS = {
  phone: "Telefon", email: "E-mail", web_form: "Webes űrlap", referral: "Ajánlás", in_person: "Személyes", other: "Egyéb",
} as const;

export const PROCESS_SOURCES = ["contact_database", "web_inquiry", "referral", "existing_customer", "other"] as const;
export const PROCESS_SOURCE_LABELS = {
  contact_database: "Kontaktadatbázis", web_inquiry: "Weboldali érdeklődés", referral: "Ajánlás",
  existing_customer: "Meglévő ügyfél megkeresése", other: "Egyéb",
} as const;

/**
 * Folyamatstátuszok sorrendben. `phase`: kapcsolatépítés vagy értékesítés.
 * `types`: ha meg van adva, a státusz csak az adott folyamattípusnál él (kiinduló állapotok).
 * `milestone`: szolgáltatói mérföldkő - csak igazolási kontroll mellett rögzíthető.
 * A „Lezárt / nem folytatjuk” nem státusz, hanem lezárási állapot (lásd CLOSURE_STATES).
 */
export const PROCESS_STATUS_DEFS = [
  { key: "pending_outreach", label: "Megkeresésre vár", phase: "outreach", types: ["outbound_outreach"] },
  { key: "new_inquiry", label: "Új érdeklődés", phase: "outreach", types: ["inbound_inquiry"] },
  { key: "contact_in_progress", label: "Kapcsolatfelvétel folyamatban", phase: "outreach" },
  { key: "contact_established", label: "Kapcsolat létrejött", phase: "outreach" },
  { key: "interest_identified", label: "Érdeklődés azonosítva", phase: "sales" },
  { key: "needs_assessment", label: "Igényfelmérés / konzultáció", phase: "sales" },
  { key: "account_prep", label: "Számlanyitás előkészítése", phase: "sales" },
  { key: "account_opening", label: "Számlanyitás folyamatban", phase: "sales", milestone: true },
  { key: "account_opened", label: "Számla megnyitva", phase: "sales", milestone: true },
  { key: "awaiting_first_deposit", label: "Első pénzelhelyezésre vár", phase: "sales" },
  { key: "first_deposit_verified", label: "Első pénzelhelyezés igazolt", phase: "sales", milestone: true },
] as const;

export type ProcessStatusDef = (typeof PROCESS_STATUS_DEFS)[number];
export const PROCESS_STATUSES = PROCESS_STATUS_DEFS.map((d) => d.key) as unknown as readonly ProcessStatusDef["key"][];
export const PROCESS_STATUS_LABELS = Object.fromEntries(PROCESS_STATUS_DEFS.map((d) => [d.key, d.label])) as Record<ProcessStatusDef["key"], string>;
export const PHASE_LABELS = { outreach: "Kapcsolatépítés", sales: "Értékesítés" } as const;

export const CLOSURE_STATES = ["active", "closed_success", "closed_no_result"] as const;
export const CLOSURE_LABELS = { active: "Aktív", closed_success: "Sikeresen lezárt", closed_no_result: "Eredmény nélkül lezárt" } as const;

export const NO_RESULT_REASONS = ["not_interested", "unreachable", "postponed", "other_solution", "other"] as const;
export const NO_RESULT_REASON_LABELS = {
  not_interested: "Nem érdeklődik", unreachable: "Nem elérhető", postponed: "Későbbre halasztva",
  other_solution: "Más megoldást választott", other: "Egyéb (indoklással)",
} as const;

// -------------------------------------------------------- Szolgáltatói igazolás
export const VERIFICATION_SOURCES = ["provider_notification", "provider_system_check", "other_documented"] as const;
export const VERIFICATION_SOURCE_LABELS = {
  provider_notification: "Szolgáltatói értesítés",
  provider_system_check: "Szolgáltatói felületen végzett ellenőrzés",
  other_documented: "Egyéb, dokumentált forrás",
} as const;
export const VERIFICATION_COMPLIANCE_WARNING =
  "DEMÓ: szimulált rögzítés. Valós használatnál a szolgáltatói mérföldkő csak jogosult, ellenőrzött visszaigazolás alapján rögzíthető. " +
  "Ne rögzíts számlaszámot, egyenleget vagy tranzakciós bizonylatot. A CRM nem helyettesíti a K&H/Patria nyilvántartását.";
export const OUTREACH_COMPLIANCE_NOTICE =
  "A kontaktadatbázisban való szereplés nem igazolja a megkeresés jogszerűségét. Megkeresés előtt ellenőrizendő: az adatforrás, a megkeresési jogalap, " +
  "az esetleges tiltakozás vagy korlátozás és a kommunikáció célja. Ebben a demóban ez nincs automatikusan ellenőrizve.";

// ------------------------------------------------------------------ Aktivitás
export const MANUAL_ACTIVITY_TYPES = ["call", "note", "meeting", "follow_up"] as const;
export const SYSTEM_ACTIVITY_TYPES = [
  "status_change", "provider_milestone", "process_created", "process_closed", "process_reopened",
  "task_created", "task_completed", "task_updated", "contact_status_change", "restriction_change", "crm_status_change",
] as const;
export const ACTIVITY_TYPES = [...MANUAL_ACTIVITY_TYPES, ...SYSTEM_ACTIVITY_TYPES] as const;
export const ACTIVITY_LABELS = {
  call: "Hívás", note: "Jegyzet", meeting: "Egyeztetés", follow_up: "Utánkövetés",
  status_change: "Státuszváltás", provider_milestone: "Szolgáltatói mérföldkő (szimulált)",
  process_created: "Folyamat létrehozva", process_closed: "Folyamat lezárva", process_reopened: "Folyamat újranyitva",
  task_created: "Feladat létrehozva", task_completed: "Feladat elvégezve", task_updated: "Feladat módosítva",
  contact_status_change: "Régi kapcsolati státusz módosítva", restriction_change: "Megkeresési korlátozás", crm_status_change: "Kapcsolati státusz módosítva",
} as const;

export const CALL_OUTCOMES = [
  "not_answered", "busy", "wrong_contact_details", "wrong_person", "callback_requested", "interested", "not_interested", "consultation_scheduled",
] as const;
export const CALL_OUTCOME_LABELS = {
  not_answered: "Nem vette fel", busy: "Foglalt", wrong_contact_details: "Rossz elérhetőség", wrong_person: "Nem illetékes kapcsolattartó",
  callback_requested: "Visszahívást kért", interested: "Érdeklődést mutatott", not_interested: "Nem érdeklődik", consultation_scheduled: "Konzultáció egyeztetve",
} as const;

/**
 * Feladattípusok (v0.5.1; v1.1-től a `crm_task_types` katalógus). A beépített v1.0 lista a `BUILTIN_CRM_CONFIG`-ban él; a már
 * létrehozott feladatok a létrehozáskori nevüket őrzik (`Task.title`), ezért a katalógus változása (átnevezés, archiválás) nem érinti őket.
 */
export const TASK_TYPES: readonly { key: string; label: string }[] = BUILTIN_CRM_CONFIG.taskTypes.map(({ key, label }) => ({ key, label }));
export const TASK_TYPE_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TASK_TYPES.map((t) => [t.key, t.label]));
/** Karakterhossz-korlát a szabad szöveges Input (régi leírás) és Output (v0.9-től a lezárás kötelező szövege) értékekre. */
export const TASK_TEXT_MAX = 2000;
/** Rövid megjegyzés korlátja az „Egyéb” Input/Output értékhez (v0.6). */
export const TASK_NOTE_MAX = 500;

/**
 * Feladat Input-opciók (v0.6; v1.1-től a `crm_task_input_options` katalógus). A `key` stabil technikai azonosító (az adatbázisban ez
 * tárolódik), a megnevezés az adminfelületen módosítható; a kivezetett kulcsok archiválva a katalógusban maradnak.
 * `allowsNote`: ehhez az értékhez opcionális rövid megjegyzés adható (a beépített listában csak az „Egyéb”).
 */
export const TASK_INPUT_OPTIONS: readonly { key: string; label: string; allowsNote?: boolean }[] = BUILTIN_CRM_CONFIG.taskInputs.map(({ key, label, allowsNote }) => ({ key, label, ...(allowsNote ? { allowsNote } : {}) }));
export const TASK_INPUT_LABELS: Readonly<Record<string, string>> = Object.fromEntries(TASK_INPUT_OPTIONS.map((o) => [o.key, o.label]));

/**
 * Feladat Output-opciók (v0.6-v0.8): a régi, legördülős lezárás értékei. v0.9-től új lezárás nem használja (az Output szabad szöveg),
 * de a lista megmarad, hogy a korábban rögzített kulcsok változatlanul, olvasható címkével jelenjenek meg.
 */
export const TASK_OUTPUT_OPTIONS = [
  { key: "completed", label: "Feladat elvégezve" },
  { key: "not_reached", label: "Nem sikerült elérni" },
  { key: "contact_made", label: "Kapcsolat létrejött" },
  { key: "callback_requested", label: "Visszahívást kért" },
  { key: "meeting_scheduled", label: "Időpont egyeztetve" },
  { key: "information_sent", label: "Információ elküldve" },
  { key: "further_discussion", label: "További egyeztetés szükséges" },
  { key: "not_interested", label: "Nem érdeklődik" },
  { key: "other", label: "Egyéb", allowsNote: true },
] as const;
export const TASK_OUTPUT_KEYS = TASK_OUTPUT_OPTIONS.map((o) => o.key) as unknown as readonly (typeof TASK_OUTPUT_OPTIONS)[number]["key"][];
export const TASK_OUTPUT_LABELS = Object.fromEntries(TASK_OUTPUT_OPTIONS.map((o) => [o.key, o.label])) as Record<(typeof TASK_OUTPUT_OPTIONS)[number]["key"], string>;
/** Az „Egyéb” érték technikai kulcsa (a beépített listában ez enged rövid megjegyzést; v1.1-től az `allowsNote` dönt). */
export const NOTE_OPTION_KEY = "other" as const;

/**
 * Feladat lezárásának eredménye (v0.9): a két lezáró gomb (Sikeres / Sikertelen). Külön tárolódik a szabad szöveges Outputtól,
 * és független az ügyfél kapcsolati (Pipeline) státuszától. A régi (v0.6-v0.8) lezárásoknak nincs ilyen minősítése, és utólag sem kapnak.
 */
export const TASK_OUTCOMES = ["success", "failure"] as const;
export const TASK_OUTCOME_LABELS = { success: "Sikeres", failure: "Sikertelen" } as const;
/** A kötelező, szabad szöveges Output hibaüzenete (kliens és szerver ugyanazt mutatja). */
export const TASK_OUTPUT_REQUIRED = "A feladat lezárásához az Output kitöltése kötelező.";

export const TASK_STATUSES = ["open", "in_progress", "done"] as const;
export const TASK_STATUS_LABELS = { open: "Nyitott", in_progress: "Folyamatban", done: "Elvégzett" } as const;

// ------------------------------------------------------- Megkereshetőség (v0.1)
export const CONTACT_PURPOSES = ["service", "follow_up", "marketing"] as const;
export const PURPOSE_LABELS = { service: "Szolgáltatás", follow_up: "Utánkövetés", marketing: "Marketing" } as const;
export const CONTACT_CHANNELS = ["email", "phone"] as const;
export const CHANNEL_LABELS = { email: "E-mail", phone: "Telefon" } as const;
export const CONTACTABILITY_STATUSES = ["allowed", "prohibited", "unknown"] as const;
export const CONTACTABILITY_LABELS = { allowed: "Engedélyezett (demó)", prohibited: "Tiltott", unknown: "Ismeretlen" } as const;
export const EVIDENCE_STATUSES = ["none", "to_verify", "documented_demo"] as const;
export const EVIDENCE_LABELS = { none: "Nincs", to_verify: "Ellenőrzendő", documented_demo: "Fiktív demó-igazolás" } as const;

export const VERIFICATION_STATUSES = ["unverified", "demo"] as const;
export const VERIFICATION_LABELS = { unverified: "Nem ellenőrzött", demo: "Fiktív demóadat" } as const;

/** Közös csapat (D02/D03): két fiktív pilotfelhasználó. Valódi hitelesítés nincs. */
export const DEMO_USERS = [
  { id: "user-1", name: "Teszt Admin Egy" },
  { id: "user-2", name: "Teszt Admin Kettő" },
] as const;

/** Az utolsó aktivitás után ennyi nappal jelenik meg a „régóta nem volt kapcsolat” jelzés. */
export const STALE_ACTIVITY_DAYS = 14;
