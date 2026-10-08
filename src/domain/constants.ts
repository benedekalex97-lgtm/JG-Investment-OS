/**
 * Konfigurálható konstansok. A megnevezések üzleti review alatt állnak
 * (JG-OS spec 6. fejezet) - csak itt kell módosítani őket.
 * Ezek demóhoz használt előzetes állapotok, nem jogi vagy szolgáltatói
 * ügyfélstátusz-igazolások.
 */

export const CUSTOMER_TYPES = ["person", "company"] as const;
export const CUSTOMER_TYPE_LABELS = { person: "Magánszemély", company: "Cég" } as const;

export const LIFECYCLE_STATUSES = ["prospect", "existing", "former", "archived"] as const;
export const LIFECYCLE_LABELS = {
  prospect: "Érdeklődő",
  existing: "Meglévő ügyfél",
  former: "Korábbi kapcsolat",
  archived: "Archivált",
} as const;

export const VERIFICATION_STATUSES = ["unverified", "demo"] as const;
export const VERIFICATION_LABELS = { unverified: "Nem ellenőrzött", demo: "Fiktív demóadat" } as const;

export const CASE_STAGES = ["clarify_need", "consultation_set", "next_step_set", "provider_in_progress"] as const;
export const CASE_STAGE_LABELS = {
  clarify_need: "Igény tisztázása",
  consultation_set: "Konzultáció egyeztetve",
  next_step_set: "Következő lépés egyeztetve",
  provider_in_progress: "Szolgáltatói folyamatban",
} as const;

export const CLOSURE_STATUSES = ["open", "won", "lost", "cancelled"] as const;
export const CLOSURE_LABELS = { open: "Nyitott", won: "Megnyert", lost: "Elveszett", cancelled: "Visszavont" } as const;

export const ACTIVITY_TYPES = ["call", "note", "meeting", "follow_up"] as const;
export const ACTIVITY_LABELS = {
  call: "Hívás",
  note: "Jegyzet",
  meeting: "Meeting",
  follow_up: "Utánkövetés",
} as const;

export const TASK_STATUSES = ["open", "in_progress", "done"] as const;
export const TASK_STATUS_LABELS = { open: "Nyitott", in_progress: "Folyamatban", done: "Elvégzett" } as const;

export const CONTACT_PURPOSES = ["service", "follow_up", "marketing"] as const;
export const PURPOSE_LABELS = { service: "Szolgáltatás", follow_up: "Utánkövetés", marketing: "Marketing" } as const;
export const CONTACT_CHANNELS = ["email", "phone"] as const;
export const CHANNEL_LABELS = { email: "E-mail", phone: "Telefon" } as const;
export const CONTACTABILITY_STATUSES = ["allowed", "prohibited", "unknown"] as const;
export const CONTACTABILITY_LABELS = { allowed: "Engedélyezett (demó)", prohibited: "Tiltott", unknown: "Ismeretlen" } as const;
export const EVIDENCE_STATUSES = ["none", "to_verify", "documented_demo"] as const;
export const EVIDENCE_LABELS = { none: "Nincs", to_verify: "Ellenőrzendő", documented_demo: "Fiktív demó-igazolás" } as const;

/** Közös csapat (D02/D03): két fiktív pilotfelhasználó. Valódi hitelesítés nincs. */
export const DEMO_USERS = [
  { id: "user-1", name: "Teszt Admin Egy" },
  { id: "user-2", name: "Teszt Admin Kettő" },
] as const;

/** Az "ügy" nyitott szakaszai a dashboardhoz használt utánkövetési küszöb (nap). */
export const FOLLOW_UP_STALE_DAYS = 14;
