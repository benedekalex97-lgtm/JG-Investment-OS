import { DEFAULT_CRM_STATUS, PROCESS_STATUS_DEFS, RESTRICTION_LABELS, VERIFIED_CONTACT_STATUSES } from "./constants";
import { findStatus, isMilestoneStatus, isOutreachStatus, type CrmConfig } from "./config";
import type { ContactStatus, CrmStatus, Customer, CustomerProcess, DataSnapshot, ProcessStatus, ProcessType, Verification } from "./types";
import type { CloseInput, ContactStatusInput, StatusChangeInput } from "./schemas";

/** A folyamattípushoz tartozó státuszok sorrendben (a másik típus kiinduló állapota nélkül). */
export function processPath(type: ProcessType): ProcessStatus[] {
  return PROCESS_STATUS_DEFS.filter((d) => !("types" in d) || (d.types as readonly ProcessType[]).includes(type)).map((d) => d.key);
}

export function initialStatus(type: ProcessType): ProcessStatus {
  return type === "outbound_outreach" ? "pending_outreach" : "new_inquiry";
}

export function statusDef(status: ProcessStatus) {
  return PROCESS_STATUS_DEFS.find((d) => d.key === status)!;
}
export const isMilestone = (status: ProcessStatus) => "milestone" in statusDef(status);
export const statusPhase = (status: ProcessStatus) => statusDef(status).phase;
export const isActive = (p: CustomerProcess) => p.closure.state === "active";

export interface NextSteps {
  /** A következő logikus lépés (indoklás nélkül váltható). */
  next?: ProcessStatus;
  /** Előreugrás: indoklással. */
  skipAhead: ProcessStatus[];
  /** Visszalépés: indoklással. */
  back: ProcessStatus[];
}

/** A folyamat nem kötelezően lineáris: minden más státuszra lehet váltani, de nem mindre indoklás nélkül. */
export function nextSteps(p: CustomerProcess): NextSteps {
  if (!isActive(p)) return { skipAhead: [], back: [] };
  const path = processPath(p.type);
  const i = path.indexOf(p.status);
  return { next: path[i + 1], skipAhead: path.slice(i + 2), back: path.slice(0, i) };
}

export const requiresReason = (p: CustomerProcess, to: ProcessStatus) => processPath(p.type).indexOf(to) !== processPath(p.type).indexOf(p.status) + 1;

type Errors = Record<string, string>;
const MIN_REASON = 3;

/** Státuszváltás szabályai. Üres objektum = érvényes. */
export function validateTransition(p: CustomerProcess, input: Pick<StatusChangeInput, "toStatus" | "reason" | "verification">): Errors {
  const errors: Errors = {};
  if (!isActive(p)) return { _form: "Lezárt folyamat státusza nem módosítható; előbb nyisd újra." };
  const path = processPath(p.type);
  if (!path.includes(input.toStatus)) return { toStatus: "Ez a státusz ennél a folyamattípusnál nem használható." };
  if (input.toStatus === p.status) return { toStatus: "A folyamat már ebben a státuszban van." };
  if (requiresReason(p, input.toStatus) && (input.reason ?? "").trim().length < MIN_REASON) {
    errors.reason = path.indexOf(input.toStatus) < path.indexOf(p.status) ? "Visszalépéshez indoklás szükséges." : "Előreugráshoz indoklás szükséges.";
  }
  if (isMilestone(input.toStatus) && !input.verification) {
    errors.verification = "Szolgáltatói mérföldkő csak az igazolási forrás és a compliance figyelmeztetés tudomásulvételével rögzíthető.";
  }
  return errors;
}

/** Sikeres lezárás: csak igazolt első pénzelhelyezés után; eredmény nélküli lezárás: indok kötelező. */
export function validateClosure(p: CustomerProcess, input: CloseInput, snap: DataSnapshot): Errors {
  if (!isActive(p)) return { _form: "A folyamat már le van zárva." };
  if (input.outcome === "success") {
    if (p.status !== "first_deposit_verified") return { _form: "Sikeres lezárás csak „Első pénzelhelyezés igazolt” státusznál lehetséges." };
    const verified = snap.activities.some((a) => a.processId === p.id && a.type === "provider_milestone" && a.meta?.toStatus === "first_deposit_verified" && a.meta.verification);
    if (!verified) return { _form: "Nincs rögzített igazolás az első pénzelhelyezésről." };
    return {};
  }
  const errors: Errors = {};
  if (input.reason === "other" && !input.reasonNote) errors.reasonNote = "„Egyéb” indoknál a szöveges indoklás kötelező.";
  if (input.reason === "postponed" && !input.followUpDueAt) errors.followUpDueAt = "Későbbre halasztásnál az újraértékelés időpontja kötelező (feladat készül, megkeresés nem).";
  return errors;
}

/** Kapcsolati státuszváltás: igazolt besorolásokhoz forrás kell. */
export function validateContactStatusChange(from: ContactStatus, input: Pick<ContactStatusInput, "to" | "verification">): Errors {
  if (input.to === from) return { to: "Az ügyfél már ebben a kapcsolati státuszban van." };
  if ((VERIFIED_CONTACT_STATUSES as readonly string[]).includes(input.to) && !input.verification) {
    return { verification: "Az „igazolt” besoroláshoz igazolási forrás és a figyelmeztetés tudomásulvétele szükséges." };
  }
  return {};
}

// ------------------------------------------------------------ v0.5 kapcsolati státusz (v1.1: katalógus alapján)
/** Szolgáltatói mérföldkő (igazolást igénylő) státusz a tényleges konfiguráció szerint. */
export const isCrmMilestone = (cfg: CrmConfig, s: CrmStatus) => isMilestoneStatus(cfg, s);

/**
 * Kapcsolati státuszváltás szabályai (v0.5, v1.1-től a katalógus üzleti jelentése alapján). Nincs kötelező sorrend és nincs indoklás.
 * - csak a katalógusban szereplő, AKTÍV státusz választható (archivált vagy ismeretlen nem);
 * - ugyanarra a státuszra nem váltható;
 * - megkeresési korlátozás/tiltakozás mellett a kimenő megkeresést jelentő státuszok (`outreach`) nem választhatók;
 * - a szolgáltatói mérföldkő (`milestone`) igazolási forrás + compliance tudomásulvétel nélkül nem rögzíthető (demóban szimulált).
 * A szabályok a kulcs üzleti jelentéséhez kötöttek, nem a megnevezéshez: átnevezés nem kapcsolja ki őket.
 */
export function validateCrmStatusChange(cfg: CrmConfig, customer: Customer, to: CrmStatus, verification?: Pick<Verification, "sourceCategory"> | { sourceCategory?: string; complianceAcknowledged?: boolean }): Record<string, string> {
  const def = findStatus(cfg, to);
  if (!def) return { toStatus: "Ismeretlen státusz." };
  if (to === (customer.crmStatus ?? DEFAULT_CRM_STATUS)) return { toStatus: "Az ügyfél már ebben a státuszban van." };
  if (!def.isActive) return { toStatus: "Ez a státusz archivált: új státuszváltásként nem választható." };
  if (customer.restriction && isOutreachStatus(cfg, to)) {
    return { toStatus: `${RESTRICTION_LABELS[customer.restriction.kind]} van rögzítve: ebbe a kimenő kapcsolatfelvételi státuszba nem váltható.` };
  }
  if (isMilestoneStatus(cfg, to) && !verification) {
    return { verification: `A „${def.label}” szolgáltatói mérföldkő csak igazolási forrással és a compliance figyelmeztetés tudomásulvételével rögzíthető.` };
  }
  return {};
}
