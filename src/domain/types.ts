import type {
  ACTIVITY_TYPES, CALL_OUTCOMES, CLOSURE_STATES, CONTACT_CHANNELS, CONTACT_PURPOSES, CONTACT_STATUSES, CONTACTABILITY_STATUSES,
  EVIDENCE_STATUSES, NO_RESULT_REASONS, OUTREACH_CHANNELS, PROCESS_SOURCES, PROCESS_TYPES, PROCESS_STATUS_DEFS, RESTRICTION_KINDS,
  TASK_OUTCOMES, TASK_OUTPUT_OPTIONS, TASK_STATUSES, VERIFICATION_SOURCES, VERIFICATION_STATUSES,
} from "./constants";
import { BUILTIN_CRM_CONFIG, type CrmConfig } from "./config";

export type ContactStatus = (typeof CONTACT_STATUSES)[number];
/**
 * Az ügyfél egyetlen aktuális kapcsolati (Pipeline-) státuszának stabil kulcsa. v1.1-től a megengedett értékek az adatbázis
 * katalógusából jönnek (`CrmConfig.statuses`), ezért itt szöveg; az érvényességet a szerver a katalógus alapján ellenőrzi.
 */
export type CrmStatus = string;
export type ProcessType = (typeof PROCESS_TYPES)[number];
export type ProcessStatus = (typeof PROCESS_STATUS_DEFS)[number]["key"];
export type ClosureState = (typeof CLOSURE_STATES)[number];
export type NoResultReason = (typeof NO_RESULT_REASONS)[number];
export type OutreachChannel = (typeof OUTREACH_CHANNELS)[number];
export type ProcessSource = (typeof PROCESS_SOURCES)[number];
export type ActivityType = (typeof ACTIVITY_TYPES)[number];
export type CallOutcome = (typeof CALL_OUTCOMES)[number];
export type TaskStatus = (typeof TASK_STATUSES)[number];
/** Feladattípus / Input kulcsa (v1.1-től a katalógusból; lásd CrmConfig). */
export type TaskType = string;
export type TaskInputKey = string;
export type TaskOutputKey = (typeof TASK_OUTPUT_OPTIONS)[number]["key"];
/** v0.9: a feladat lezárásának minősítése (Sikeres / Sikertelen). */
export type TaskOutcome = (typeof TASK_OUTCOMES)[number];
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
  /** Feladat lezárásakor rögzített Output (eredmény) - az adott lezárási eseményhez kötve. */
  output?: string;
  /** v0.9: a lezárás minősítése (csak az új lezárásokon; a régieken hiányzik, nem kap kitalált értéket). */
  taskOutcome?: TaskOutcome;
  /** v0.9: feladat-módosítás jellege (újranyitás / átidőzítés) a „task_updated” eseményen. */
  taskChange?: "reopened" | "rescheduled";
  /** v0.9: átidőzítéskor a korábbi és az új határidő (null = nem volt / törölve). */
  fromDueAt?: string | null;
  toDueAt?: string | null;
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

/** Egy feladat-lezárás eredménye. Újranyitás után az előzmény megmarad, az újabb lezárás új bejegyzést fűz hozzá. */
export interface TaskOutput {
  /** v0.9: a lezárás minősítése (Sikeres / Sikertelen). Hiányzik a régi (v0.8-ig rögzített) lezárásokon. */
  outcome?: TaskOutcome;
  /** v0.6-v0.8: a legördülőből választott Output kulcsa (megőrzött adat; v0.9-től új lezárás nem tölti). */
  key?: TaskOutputKey;
  /**
   * Az Output szövege. v0.9: a munkatárs által kötelezően beírt, szabad szöveg (sortörésekkel). v0.6-v0.8: az „Egyéb” opcionális
   * megjegyzése (egyébként üres). v0.5 előtt: a régi, szabad szöveges Output.
   */
  text: string;
  closedAt: string;
  closedBy: string;
}

export interface Task {
  id: string;
  customerId: string;
  processId?: string;
  companyContactId?: string;
  /** A feladat neve: új feladatnál a kiválasztott feladattípus neve; régi feladatnál a korábbi szabad szöveg (változatlanul). */
  title: string;
  /** Feladattípus kulcsa (v0.5.1). Hiányzik a régebbi feladatokon: ők nem kapnak kitalált típust. */
  taskType?: TaskType;
  /** Régi, szabad szöveges Input / leírás (megőrzött adat; a v0.6 felület már nem ír ide). */
  description?: string;
  /** v0.6: a legördülőből választott Input kulcsa (opcionális). */
  inputKey?: TaskInputKey;
  /** v0.6: az „Egyéb” Input opcionális rövid megjegyzése. */
  inputNote?: string;
  /** Lezárási eredmények (Output) időrendben; a legutolsó az aktuális. Hiányzik a régi, elvégzett feladatokon. */
  outputs?: TaskOutput[];
  assigneeId: string;
  /** Opcionális határidő (v0.5). */
  dueAt?: string;
  /** Lezárt = `done` (v0.9: a Sikeres / Sikertelen gombbal, kötelező Outputtal); a régi `in_progress` nyitottnak számít. */
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
  /** v1.1: a CRM konfigurációs katalógusai (státuszok, feladattípusok, Input-opciók); a szerver az adatbázisból tölti. */
  config: CrmConfig;
  customers: Customer[];
  contacts: CompanyContact[];
  processes: CustomerProcess[];
  activities: Activity[];
  tasks: Task[];
  contactability: Contactability[];
}

/** A beépített (v1.0) katalógus mély másolata - tartományi tesztekhez és a fiktív seedhez; a szerver a saját, adatbázisból töltött konfigurációját adja. */
export const builtinConfig = (): CrmConfig => structuredClone(BUILTIN_CRM_CONFIG);

export const emptySnapshot = (config: CrmConfig = builtinConfig()): DataSnapshot => ({
  version: SNAPSHOT_VERSION, config, customers: [], contacts: [], processes: [], activities: [], tasks: [], contactability: [],
});
