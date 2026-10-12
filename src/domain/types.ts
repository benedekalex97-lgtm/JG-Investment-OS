import type {
  ACTIVITY_TYPES, CALL_OUTCOMES, CLOSURE_STATES, CRM_STATUSES, CONTACT_CHANNELS, CONTACT_PURPOSES, CONTACT_STATUSES, CONTACTABILITY_STATUSES,
  EVIDENCE_STATUSES, NO_RESULT_REASONS, OUTREACH_CHANNELS, PROCESS_SOURCES, PROCESS_TYPES, PROCESS_STATUS_DEFS, RESTRICTION_KINDS,
  TASK_STATUSES, VERIFICATION_SOURCES, VERIFICATION_STATUSES,
} from "./constants";

export type ContactStatus = (typeof CONTACT_STATUSES)[number];
/** v0.5: az ügyfél egyetlen aktuális kapcsolati státusza (hét érték). */
export type CrmStatus = (typeof CRM_STATUSES)[number];
export type ProcessType = (typeof PROCESS_TYPES)[number];
export type ProcessStatus = (typeof PROCESS_STATUS_DEFS)[number]["key"];
export type ClosureState = (typeof CLOSURE_STATES)[number];
export type NoResultReason = (typeof NO_RESULT_REASONS)[number];
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
export type ProcessSource = (typeof PROCESS_SOURCES)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type VerificationSource = (typeof VERIFICATION_SOURCES)[number];
export type RestrictionKind = (typeof RESTRICTION_KINDS)[number];
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export type ContactabilityStatus = (typeof CONTACTABILITY_STATUSES)[number];
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];
export type DataVerificationStatus = (typeof VERIFICATION_STATUSES)[number];

/** Megkeresési korlátozás / tiltakozás - jól látható, külön kezelt állapot. */
export interface ContactRestriction {
  kind: RestrictionKind;
  note: string;
  recordedAt: string;
  recordedBy: string;
}

interface CustomerBase {
  id: string;
  /** Régi (v0.2/v0.3) négyértékű besorolás: megőrzött adat, a v0.5 felület nem használja. */
  contactStatus: ContactStatus;
  /**
   * v0.5 kapcsolati státusz. Hiányzik a régebbi rekordokon: olvasáskor az alapértelmezett érvényes
   * (`statusOf`), az adat csak a felhasználó által kezdeményezett módosításkor íródik át.
   */
  crmStatus?: CrmStatus;
  ownerId: string;
  source: string;
  verificationStatus: DataVerificationStatus;
  email?: string;
  phone?: string;
  restriction?: ContactRestriction;
  createdAt: string;
  updatedAt: string;
}

/** Magánszemély - nincs cégnévmező. */
export interface IndividualCustomer extends CustomerBase {
  type: "individual";
  firstName: string;
  lastName: string;
  displayName: string;
  notes?: string;
}

export interface CompanyCustomer extends CustomerBase {
  type: "company";
  companyName: string;
}

export type Customer = IndividualCustomer | CompanyCustomer;

/** Céges kapcsolattartó - nem ügyféltípus. */
export interface CompanyContact {
  id: string;
  companyId: string;
  firstName: string;
  lastName: string;
  position?: string;
  email?: string;
  phone?: string;
  isPrimaryContact: boolean;
  createdAt: string;
  updatedAt: string;
}

/** Szimulált szolgáltatói igazolás. Nem tartalmazhat számlaszámot, egyenleget vagy bizonylatot. */
export interface Verification {
  sourceCategory: VerificationSource;
  recordedAt: string;
  recordedBy: string;
  complianceAcknowledged: true;
  simulated: true;
}

export interface ProcessClosure {
  state: ClosureState;
  reason?: NoResultReason;
  reasonNote?: string;
  closedAt?: string;
  closedBy?: string;
}

export interface CustomerProcess {
  id: string;
  customerId: string;
  companyContactId?: string;
  type: ProcessType;
  title: string;
  status: ProcessStatus;
  closure: ProcessClosure;
  channel: OutreachChannel;
  source: ProcessSource;
  ownerId: string;
  createdAt: string;
  updatedAt: string;
}

export interface ActivityMeta {
  fromStatus?: ProcessStatus;
  toStatus?: ProcessStatus;
  reason?: string;
  verification?: Verification;
  closureState?: ClosureState;
  closureReason?: NoResultReason;
  fromContactStatus?: ContactStatus;
  toContactStatus?: ContactStatus;
  fromCrmStatus?: CrmStatus;
  toCrmStatus?: CrmStatus;
  taskId?: string;
  restrictionKind?: RestrictionKind | null;
}

export interface Activity {
  id: string;
  customerId: string;
  processId?: string;
  companyContactId?: string;
  type: ActivityType;
  occurredAt: string;
  summary: string;
  recordedBy: string;
  callOutcome?: CallOutcome;
  meta?: ActivityMeta;
}

export interface Task {
  id: string;
  customerId: string;
  processId?: string;
  companyContactId?: string;
  title: string;
  description?: string;
  assigneeId: string;
  /** Opcionális határidő (v0.5). */
  dueAt?: string;
  /** Elvégzett = `done`; a v0.5 felület csak pipával kezeli (a régi `in_progress` nyitottnak számít). */
  status: TaskStatus;
  /** A feladat létrehozásakor az ügyfél aktuális státusza (hiányzik a régi feladatokon: ők nem kapnak kitalált státuszt). */
  crmStatus?: CrmStatus;
  createdAt: string;
  completedAt?: string;
}

/** Megkereshetőség - az ügyfélstátusztól független; alapértelmezett: unknown. */
export interface Contactability {
  id: string;
  customerId?: string;
  companyContactId?: string;
  purpose: ContactPurpose;
  channel: ContactChannel;
  status: ContactabilityStatus;
  evidenceStatus: EvidenceStatus;
  verifiedAt?: string;
}

export const SNAPSHOT_VERSION = 2 as const;

export interface DataSnapshot {
  version: typeof SNAPSHOT_VERSION;
  customers: Customer[];
  contacts: CompanyContact[];
  processes: CustomerProcess[];
  activities: Activity[];
  tasks: Task[];
  contactability: Contactability[];
}

export const emptySnapshot = (): DataSnapshot => ({
  version: SNAPSHOT_VERSION, customers: [], contacts: [], processes: [], activities: [], tasks: [], contactability: [],
});
