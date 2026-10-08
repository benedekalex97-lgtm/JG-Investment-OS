import { z } from "zod";
import {
  ACTIVITY_TYPES, CASE_STAGES, CLOSURE_STATUSES, LIFECYCLE_STATUSES, TASK_STATUSES,
} from "./constants";

const req = (label: string) => z.string().trim().min(1, `${label} megadása kötelező`);
const optText = z.string().trim().optional().transform((v) => (v ? v : undefined));
const optEmail = z
  .string().trim().optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v), "Érvénytelen e-mail-cím");
const optPhone = z
  .string().trim().optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || /^\+?[0-9 ()/-]{6,20}$/.test(v), "Érvénytelen telefonszám");
const isoDate = z.string().trim().min(1, "Dátum megadása kötelező").refine((v) => !Number.isNaN(Date.parse(v)), "Érvénytelen dátum");
const optIsoDate = z
  .string().trim().optional()
  .transform((v) => (v ? v : undefined))
  .refine((v) => v === undefined || !Number.isNaN(Date.parse(v)), "Érvénytelen dátum");

const customerCommon = {
  lifecycleStatus: z.enum(LIFECYCLE_STATUSES),
  ownerId: req("Felelős"),
  source: z.string().trim().default("manuális (demó)"),
  email: optEmail,
  phone: optPhone,
};

/** Magánszemély: nincs companyName; a `.strict()` visszautasítja a cégnevet. */
export const personCustomerInput = z
  .object({
    type: z.literal("person"),
    firstName: req("Keresztnév"),
    lastName: req("Vezetéknév"),
    notes: optText,
    ...customerCommon,
  })
  .strict();

/** Cég: a cégnév kötelező. */
export const companyCustomerInput = z
  .object({
    type: z.literal("company"),
    companyName: req("Cégnév"),
    ...customerCommon,
  })
  .strict();

export const customerInput = z.discriminatedUnion("type", [personCustomerInput, companyCustomerInput]);

export const companyContactInput = z
  .object({
    firstName: req("Keresztnév"),
    lastName: req("Vezetéknév"),
    position: optText,
    email: optEmail,
    phone: optPhone,
    isPrimaryContact: z.boolean().default(false),
  })
  .strict();

export const caseInput = z
  .object({
    customerId: req("Ügyfél"),
    companyContactId: optText,
    title: req("Ügy címe"),
    stage: z.enum(CASE_STAGES).default("clarify_need"),
    closureStatus: z.enum(CLOSURE_STATUSES).default("open"),
    ownerId: req("Felelős"),
    nextAction: optText,
    nextActionDueAt: optIsoDate,
  })
  .strict();

export const activityInput = z
  .object({
    customerId: req("Ügyfél"),
    caseId: optText,
    companyContactId: optText,
    type: z.enum(ACTIVITY_TYPES),
    summary: req("Összefoglaló"),
    occurredAt: isoDate,
    ownerId: req("Felelős"),
  })
  .strict();

export const taskInput = z
  .object({
    customerId: req("Ügyfél"),
    caseId: optText,
    companyContactId: optText,
    title: req("Feladat címe"),
    description: optText,
    assigneeId: req("Felelős"),
    dueAt: isoDate,
    status: z.enum(TASK_STATUSES).default("open"),
  })
  .strict();

export type CustomerInput = z.infer<typeof customerInput>;
export type CompanyContactInput = z.infer<typeof companyContactInput>;
export type CaseInput = z.infer<typeof caseInput>;
export type ActivityInput = z.infer<typeof activityInput>;
export type TaskInput = z.infer<typeof taskInput>;
