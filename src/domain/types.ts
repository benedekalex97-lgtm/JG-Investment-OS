import type {
  ACTIVITY_TYPES, CASE_STAGES, CLOSURE_STATUSES, CONTACT_CHANNELS, CONTACT_PURPOSES,
  CONTACTABILITY_STATUSES, EVIDENCE_STATUSES, LIFECYCLE_STATUSES, TASK_STATUSES, VERIFICATION_STATUSES,
} from "./constants";

export type LifecycleStatus = (typeof LIFECYCLE_STATUSES)[number];
export type VerificationStatus = (typeof VERIFICATION_STATUSES)[number];
export type CaseStage = (typeof CASE_STAGES)[number];
export type ClosureStatus = (typeof CLOSURE_STATUSES)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
export type ContactPurpose = (typeof CONTACT_PURPOSES)[number];
export type ContactChannel = (typeof CONTACT_CHANNELS)[number];
export type ContactabilityStatus = (typeof CONTACTABILITY_STATUSES)[number];
export type EvidenceStatus = (typeof EVIDENCE_STATUSES)[number];

interface CustomerBase {
  id: string;
  lifecycleStatus: LifecycleStatus;
  ownerId: string;
  source: string;
  verificationStatus: VerificationStatus;
  email?: string;
  phone?: string;
  createdAt: string;
  updatedAt: string;
}

/** Magánszemély ügyfél - NINCS cégnévmező. */
export interface PersonCustomer extends CustomerBase {
  type: "person";
  firstName: string;
  lastName: string;
  displayName: string;
  notes?: string;
}

/** Céges ügyfél - a kapcsolattartók külön entitások (CompanyContact). */
export interface CompanyCustomer extends CustomerBase {
  type: "company";
  companyName: string;
}

export type Customer = PersonCustomer | CompanyCustomer;

/** Céges kapcsolattartó - NEM ügyféltípus, egy céghez tartozik. */
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

export interface Case {
  id: string;
  customerId: string;
  companyContactId?: string;
  title: string;
  stage: CaseStage;
  closureStatus: ClosureStatus;
  ownerId: string;
  nextAction?: string;
  nextActionDueAt?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Activity {
  id: string;
  customerId: string;
  caseId?: string;
  companyContactId?: string;
  type: ActivityType;
  summary: string;
  occurredAt: string;
  ownerId: string;
}

export interface Task {
  id: string;
  customerId: string;
  caseId?: string;
  companyContactId?: string;
  title: string;
  description?: string;
  assigneeId: string;
  dueAt: string;
  status: TaskStatus;
  createdAt: string;
  completedAt?: string;
}

/** Megkereshetőség - az ügyfélstátusztól függetlenül; alapértelmezett: unknown. */
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

export interface DataSnapshot {
  customers: Customer[];
  contacts: CompanyContact[];
  cases: Case[];
  activities: Activity[];
  tasks: Task[];
  contactability: Contactability[];
}
