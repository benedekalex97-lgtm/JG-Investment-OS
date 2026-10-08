import { z } from "zod";
import {
  CALL_OUTCOMES, CONTACT_STATUSES, MANUAL_ACTIVITY_TYPES, NO_RESULT_REASONS, OUTREACH_CHANNELS, PROCESS_SOURCES, PROCESS_STATUSES,
  PROCESS_TYPES, RESTRICTION_KINDS, TASK_STATUSES, VERIFICATION_SOURCES,
} from "./constants";

const req = (label: string) => z.string().trim().min(1, `${label} megadása kötelező`);
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
  source: z.string().trim().default("manuális (demó)"),
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

export const taskInput = z
  .object({
    customerId: req("Ügyfél"),
    processId: optText,
    companyContactId: optText,
    title: req("Feladat címe"),
    description: optText,
    assigneeId: req("Felelős"),
    dueAt: isoDate,
    status: z.enum(TASK_STATUSES).default("open"),
    recordedBy: z.string().trim().optional(),
  })
  .strict();

export const verificationInput = z
  .object({
    sourceCategory: z.enum(VERIFICATION_SOURCES, { message: "Az igazolás forrásának kategóriája kötelező" }),
    complianceAcknowledged: z.literal(true, { message: "A compliance figyelmeztetés tudomásulvétele kötelező" }),
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
export type CompanyContactInput = z.infer<typeof companyContactInput>;
export type ProcessInput = z.infer<typeof processInput>;
export type ManualActivityInput = z.infer<typeof manualActivityInput>;
export type TaskInput = z.infer<typeof taskInput>;
export type StatusChangeInput = z.infer<typeof statusChangeInput>;
export type CloseInput = z.infer<typeof closeInput>;
export type ReopenInput = z.infer<typeof reopenInput>;
export type ContactStatusInput = z.infer<typeof contactStatusInput>;
export type RestrictionInput = z.infer<typeof restrictionInput>;
