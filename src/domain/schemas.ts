import { z } from "zod";
import {
  CALL_OUTCOMES, CONTACT_STATUSES, NOTE_OPTION_KEY, TASK_INPUT_KEYS, TASK_NOTE_MAX, TASK_OUTCOMES, TASK_OUTPUT_REQUIRED, TASK_TEXT_MAX, TASK_TYPE_KEYS, CRM_STATUSES, DEFAULT_CRM_STATUS, MANUAL_ACTIVITY_TYPES, NO_RESULT_REASONS, OUTREACH_CHANNELS, PROCESS_SOURCES, PROCESS_STATUSES,
  PROCESS_TYPES, RESTRICTION_KINDS, VERIFICATION_SOURCES,
} from "./constants";

const req = (label: string) => z.string({ message: `${label} megadása kötelező` }).trim().min(1, `${label} megadása kötelező`);
const optText = z.string().trim().optional().transform((v) => (v ? v : undefined));
const optEmail = z
  .string().trim().optional().transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Érvénytelen e-mail-cím");
const optPhone = z
  .string().trim().optional().transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^\+?[0-9 ()/-]{6,20}$/.test(v), "Érvénytelen telefonszám");
const isoDate = z.string().trim().min(1, "Dátum megadása kötelező").refine((v) => !Number.isNaN(Date.parse(v)), "Érvénytelen dátum");
const optIsoDate = z
  .string().trim().optional().transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Érvénytelen dátum");

const customerCommon = {
  ownerId: req("Felelős"),
  source: z.string().trim().default(""),
  email: optEmail,
  phone: optPhone,
};

/** Magánszemély: nincs companyName; a `.strict()` visszautasítja a cégnevet. Az új ügyfél mindig „Potenciális ügyfél”. */
export const individualCustomerInput = z
  .object({ type: z.literal("individual"), firstName: req("Keresztnév"), lastName: req("Vezetéknév"), notes: optText, ...customerCommon })
  .strict();

export const companyCustomerInput = z
  .object({ type: z.literal("company"), companyName: req("Cégnév"), ...customerCommon })
  .strict();

export const customerInput = z.discriminatedUnion("type", [individualCustomerInput, companyCustomerInput]);

export const companyContactInput = z
  .object({
    firstName: req("Keresztnév"), lastName: req("Vezetéknév"), position: optText, email: optEmail, phone: optPhone,
    isPrimaryContact: z.boolean().default(false),
  })
  .strict();

export const verificationInput = z
  .object({
    sourceCategory: z.enum(VERIFICATION_SOURCES, { message: "Az igazolás forrásának kategóriája kötelező" }),
    complianceAcknowledged: z.literal(true, { message: "A compliance figyelmeztetés tudomásulvétele kötelező" }),
  })
  .strict();

/**
 * v0.5 egyszerű ügyfélűrlap: az üzleti minimum a név (cégnél a cégnév). A telefonszám, az e-mail, a kapcsolati személy,
 * az adatforrás és a szerep mind opcionális. A kapcsolati státusz alapértéke: Feldolgozásra vár (waiting_for_contact); a „Tőke elhelyezve”
 * csak igazolási forrással és a compliance figyelmeztetés tudomásulvételével adható meg.
 */
const formCommon = {
  source: z.string().trim().optional().transform((v) => (v ? v : "")),
  crmStatus: z.enum(CRM_STATUSES).default(DEFAULT_CRM_STATUS),
  verification: verificationInput.optional(),
  recordedBy: req("Rögzítő"),
};
export const newCustomerForm = z.discriminatedUnion("type", [
  z.object({ type: z.literal("individual"), name: req("Név"), phone: optPhone, email: optEmail, notes: optText, ...formCommon }).strict(),
  z.object({ type: z.literal("company"), companyName: req("Cégnév"), phone: optPhone, email: optEmail, contactName: optText, contactPosition: optText, ...formCommon }).strict(),
]);

/** Ügyfél szerkesztése: a kapcsolati státusz és a korlátozás NEM itt módosul (külön, naplózott műveletek). */
export const customerUpdateInput = z.discriminatedUnion("type", [
  z.object({ type: z.literal("individual"), name: req("Név"), phone: optPhone, email: optEmail, notes: optText, source: optText }).strict(),
  z.object({ type: z.literal("company"), companyName: req("Cégnév"), phone: optPhone, email: optEmail, contactName: optText, contactPosition: optText, source: optText }).strict(),
]);

/** Kapcsolati státusz váltása (v0.5): nincs kötelező sorrend, indoklás; a „Tőke elhelyezve” igazolást kér. */
export const crmStatusChangeInput = z
  .object({ toStatus: z.enum(CRM_STATUSES, { message: "Válassz státuszt" }), verification: verificationInput.optional(), recordedBy: req("Rögzítő") })
  .strict();

export const processInput = z
  .object({
    customerId: req("Ügyfél"),
    companyContactId: optText,
    type: z.enum(PROCESS_TYPES),
    title: req("Folyamat megnevezése"),
    channel: z.enum(OUTREACH_CHANNELS),
    source: z.enum(PROCESS_SOURCES),
    ownerId: req("Felelős"),
    recordedBy: req("Rögzítő"),
  })
  .strict();

export const manualActivityInput = z
  .object({
    customerId: req("Ügyfél"),
    processId: optText,
    companyContactId: optText,
    type: z.enum(MANUAL_ACTIVITY_TYPES),
    summary: req("Összefoglaló"),
    occurredAt: isoDate,
    recordedBy: req("Rögzítő"),
    callOutcome: z.enum(CALL_OUTCOMES).optional(),
  })
  .strict()
  .refine((v) => v.type === "call" || v.callOutcome === undefined, { path: ["callOutcome"], message: "Híváseredmény csak hívásnál adható meg" });

/** Az „Egyéb” Input/Output rövid, opcionális megjegyzése. */
const shortNote = z.string().trim().max(TASK_NOTE_MAX, `Legfeljebb ${TASK_NOTE_MAX} karakter adható meg`).optional().transform((v) => (v ? v : undefined));
const longText = z.string().trim().max(TASK_TEXT_MAX, `Legfeljebb ${TASK_TEXT_MAX} karakter adható meg`);

/**
 * Új feladat (v0.5.1): a feladat neve a kiválasztott `taskType` neve (központi lista: TASK_TYPES), nincs külön szabad szöveges név.
 * A `title` kizárólag régi/belső útra (seed, tesztek) marad: a felület mindig `taskType`-ot küld. Az Input (`description`)
 * opcionális és korlátozott hosszú. A feladat a létrehozáskori ügyfélstátuszhoz kapcsolódik (a repository tölti), nincs folyamathoz kötve.
 */
export const taskInput = z
  .object({
    customerId: req("Ügyfél"),
    processId: optText,
    companyContactId: optText,
    taskType: z.enum(TASK_TYPE_KEYS, { message: "A feladat típusának kiválasztása kötelező" }).optional(),
    title: optText,
    /** Régi, szabad szöveges Input: csak belső/régi útra (seed, tesztek) - a felület a legördülő `inputKey`-t küldi. */
    description: longText.optional().transform((v) => (v ? v : undefined)),
    inputKey: z.enum(TASK_INPUT_KEYS, { message: "Érvénytelen Input érték" }).optional(),
    inputNote: shortNote,
    assigneeId: req("Felelős"),
    dueAt: optIsoDate,
    /** Új feladat csak nyitott lehet; a lezárás Output-tal, a `closeTask` műveleten át történik (a „folyamatban” csak régi adat). */
    status: z.enum(["open", "in_progress"]).default("open"),
    crmStatus: z.enum(CRM_STATUSES).optional(),
    recordedBy: z.string().trim().optional(),
  })
  .strict()
  .refine((v) => v.taskType !== undefined || (v.title ?? "") !== "", { path: ["taskType"], message: "A feladat típusának kiválasztása kötelező" })
  .refine((v) => v.inputNote === undefined || v.inputKey === NOTE_OPTION_KEY, { path: ["inputNote"], message: "Megjegyzés csak az „Egyéb” Input értékhez adható meg" });

/**
 * Feladat lezárása (v0.9): két, egymástól külön tárolt adat - a lezárás minősítése (`outcome`: Sikeres / Sikertelen, a két lezáró
 * gomb) és a kötelező, szabad szöveges Output (`output`). Üres vagy csak szóközt/sortörést tartalmazó Output nem fogadható el; a szöveg
 * belseje (sortörések, karakterek) változatlanul tárolódik, csak az elején/végén álló üres karakterek maradnak el. A hosszkorlát a
 * meglévő szabad szöveges korlát (TASK_TEXT_MAX). A lezárás nem módosítja az ügyfél kapcsolati (Pipeline) státuszát.
 */
export const closeTaskInput = z
  .object({
    outcome: z.enum(TASK_OUTCOMES, { message: "Válaszd ki a lezárás eredményét: Sikeres vagy Sikertelen." }),
    output: z.string({ message: TASK_OUTPUT_REQUIRED }).trim().min(1, TASK_OUTPUT_REQUIRED).max(TASK_TEXT_MAX, `Az Output legfeljebb ${TASK_TEXT_MAX} karakter lehet.`),
    recordedBy: req("Rögzítő"),
  })
  .strict();

export const statusChangeInput = z
  .object({
    toStatus: z.enum(PROCESS_STATUSES),
    reason: optText,
    verification: verificationInput.optional(),
    recordedBy: req("Rögzítő"),
  })
  .strict();

export const closeInput = z.discriminatedUnion("outcome", [
  z.object({ outcome: z.literal("success"), recordedBy: req("Rögzítő") }).strict(),
  z
    .object({
      outcome: z.literal("no_result"),
      reason: z.enum(NO_RESULT_REASONS, { message: "Az indok megadása kötelező" }),
      reasonNote: optText,
      followUpDueAt: optIsoDate,
      recordedBy: req("Rögzítő"),
    })
    .strict(),
]);

export const reopenInput = z.object({ reason: z.string().trim().min(3, "Az újranyitás indoklása kötelező"), recordedBy: req("Rögzítő") }).strict();

export const contactStatusInput = z
  .object({
    to: z.enum(CONTACT_STATUSES),
    reason: optText,
    verification: verificationInput.optional(),
    recordedBy: req("Rögzítő"),
  })
  .strict();

export const restrictionInput = z
  .object({
    kind: z.enum(RESTRICTION_KINDS).nullable(),
    note: optText,
    recordedBy: req("Rögzítő"),
  })
  .strict();

export type CustomerInput = z.infer<typeof customerInput>;
export type CrmStatusChangeInput = z.infer<typeof crmStatusChangeInput>;
export type NewCustomerForm = z.infer<typeof newCustomerForm>;
export type CustomerUpdateInput = z.infer<typeof customerUpdateInput>;
export type CompanyContactInput = z.infer<typeof companyContactInput>;
export type ProcessInput = z.infer<typeof processInput>;
export type ManualActivityInput = z.infer<typeof manualActivityInput>;
export type TaskInput = z.infer<typeof taskInput>;
export type CloseTaskInput = z.infer<typeof closeTaskInput>;
export type StatusChangeInput = z.infer<typeof statusChangeInput>;
export type CloseInput = z.infer<typeof closeInput>;
export type ReopenInput = z.infer<typeof reopenInput>;
export type ContactStatusInput = z.infer<typeof contactStatusInput>;
export type RestrictionInput = z.infer<typeof restrictionInput>;
