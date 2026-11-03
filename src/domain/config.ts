/**
 * CRM-konfiguráció (v1.1, SET-004-006): a Pipeline-státuszok, a feladattípusok és a feladat Input-opciók adatbázis-alapú katalógusa.
 *
 * Az egyetlen megbízható adatforrás az adatbázis (`crm_pipeline_statuses`, `crm_task_types`, `crm_task_input_options`, 0008). A szerver
 * minden kérésnél frissen olvassa (a snapshot része), a kliens ugyanezt a snapshotot kapja, így a kliens és a szerver ugyanazt a
 * konfigurációt használja. A `BUILTIN_CRM_CONFIG` a v1.0-ig kódba égetett lista pontos másolata: a migráció ezzel tölti fel a
 * katalógusokat (a teszt ellenőrzi az egyezést), és csak tartományi egységtesztek / fiktív seed használja - a futó alkalmazás nem
 * esik vissza rá, ha a katalógus nem olvasható (ilyenkor a kérés hibával áll meg, nem talál ki státuszt).
 *
 * Üzleti jelentés (`semantic`): a rendszer nem csak nevet és színt tárol. A védett jelentések (alapértelmezett, kimenő megkeresés,
 * szolgáltatói mérföldkő, elvesztett) kizárólag a hét rendszerstátuszhoz tartoznak, és sem a felületről, sem az alkalmazás
 * adatbázis-szerepköréből nem módosíthatók. Az admin által felvett új státusz mindig egyszerű, belső munkafolyamat-státusz.
 */

/** Hozzáférhető színpaletta (a design-tokenekből). A szín kizárólag megjelenítési metaadat, üzleti szabályt nem befolyásol. */
export const STATUS_COLORS = ["neutral", "info", "accent", "ok", "warn", "danger", "teal", "indigo"] as const;
export type StatusColor = (typeof STATUS_COLORS)[number];
export const STATUS_COLOR_LABELS: Record<StatusColor, string> = {
  neutral: "Szürke", info: "Kék", accent: "Padlizsán", ok: "Zöld", warn: "Borostyán", danger: "Piros", teal: "Kékeszöld", indigo: "Indigó",
};

export const STATUS_SEMANTICS = ["default", "outreach", "milestone", "lost", "workflow"] as const;
export type StatusSemantic = (typeof STATUS_SEMANTICS)[number];
export const STATUS_SEMANTIC_LABELS: Record<StatusSemantic, string> = {
  default: "Alapértelmezett (új ügyfél)",
  outreach: "Kimenő megkeresés (korlátozás mellett nem választható)",
  milestone: "Szolgáltatói mérföldkő (igazolás kötelező)",
  lost: "Lezárt / elvesztett",
  workflow: "Belső munkafolyamat-státusz",
};

/** Stabil technikai kulcs: kisbetű, szám, aláhúzás; soha nem módosul. */
export const CONFIG_KEY_RE = /^[a-z][a-z0-9_]{1,39}$/;
export const CONFIG_LABEL_MAX = 60;
export const CONFIG_DESCRIPTION_MAX = 300;

interface CatalogBase {
  key: string;
  label: string;
  sortOrder: number;
  isActive: boolean;
  /** A v1.0-ból átvett, védett elem (nem archiválható / jelentése nem módosítható). */
  isSystem: boolean;
  /** Optimista párhuzamosság-kezelés: minden módosítás növeli. */
  version: number;
}
export interface PipelineStatusDef extends CatalogBase {
  description?: string;
  color: StatusColor;
  semantic: StatusSemantic;
  requiresVerification: boolean;
  /** Compliance-releváns megnevezés: nem nevezhető át a felületről. */
  labelLocked: boolean;
}
export type TaskTypeDef = CatalogBase;
export interface TaskInputDef extends CatalogBase {
  allowsNote: boolean;
}

export interface CrmConfig {
  statuses: PipelineStatusDef[];
  taskTypes: TaskTypeDef[];
  taskInputs: TaskInputDef[];
}

const sys = { isActive: true, isSystem: true, version: 1 } as const;

/** A v1.0 kódba égetett listái változatlan kulccsal, megnevezéssel és sorrenddel (a 0008 migráció ezzel azonos sorokat szúr be). */
export const BUILTIN_CRM_CONFIG: CrmConfig = {
  statuses: [
    { ...sys, key: "waiting_for_contact", label: "Feldolgozásra vár", sortOrder: 10, color: "neutral", semantic: "default", requiresVerification: false, labelLocked: false },
    { ...sys, key: "contact", label: "Kapcsolatfelvétel", sortOrder: 20, color: "info", semantic: "outreach", requiresVerification: false, labelLocked: false },
    { ...sys, key: "relationship", label: "Kapcsolatépítés", sortOrder: 30, color: "info", semantic: "outreach", requiresVerification: false, labelLocked: false },
    { ...sys, key: "meeting", label: "Online/Személyes tárgyalás", sortOrder: 40, color: "accent", semantic: "workflow", requiresVerification: false, labelLocked: false },
    { ...sys, key: "account_opening", label: "Számlanyitás", sortOrder: 50, color: "accent", semantic: "workflow", requiresVerification: false, labelLocked: true },
    { ...sys, key: "capital_placed", label: "Tőke elhelyezve", sortOrder: 60, color: "ok", semantic: "milestone", requiresVerification: true, labelLocked: true },
    { ...sys, key: "lost", label: "Elvesztett", sortOrder: 70, color: "danger", semantic: "lost", requiresVerification: false, labelLocked: false },
  ],
  taskTypes: [
    { ...sys, key: "phone_call", label: "Telefonhívás", sortOrder: 10 },
    { ...sys, key: "email", label: "E-mail", sortOrder: 20 },
    { ...sys, key: "online_meeting", label: "Online tárgyalás", sortOrder: 30 },
    { ...sys, key: "in_person_meeting", label: "Személyes tárgyalás", sortOrder: 40 },
    { ...sys, key: "follow_up", label: "Utánkövetés", sortOrder: 50 },
    { ...sys, key: "other", label: "Egyéb", sortOrder: 60 },
  ],
  taskInputs: [
    { ...sys, key: "first_contact", label: "Első megkeresés", sortOrder: 10, allowsNote: false },
    { ...sys, key: "callback", label: "Visszahívás", sortOrder: 20, allowsNote: false },
    { ...sys, key: "scheduling", label: "Időpont-egyeztetés", sortOrder: 30, allowsNote: false },
    { ...sys, key: "information", label: "Tájékoztatás", sortOrder: 40, allowsNote: false },
    { ...sys, key: "follow_up", label: "Utánkövetés", sortOrder: 50, allowsNote: false },
    { ...sys, key: "other", label: "Egyéb", sortOrder: 60, allowsNote: true },
  ],
};

/** A v1.0 alapértelmezett státuszkulcsa: a régi, státusz nélküli ügyfél olvasáskor ebben a státuszban látszik (nem íródik át). */
export const DEFAULT_STATUS_KEY = "waiting_for_contact";

const byOrder = <T extends CatalogBase>(a: T, b: T) => a.sortOrder - b.sortOrder || a.key.localeCompare(b.key);
export const ordered = <T extends CatalogBase>(list: readonly T[]): T[] => [...list].sort(byOrder);
export const activeOf = <T extends CatalogBase>(list: readonly T[]): T[] => ordered(list.filter((x) => x.isActive));

export const findStatus = (cfg: CrmConfig, key: string | undefined) => (key ? cfg.statuses.find((s) => s.key === key) : undefined);
export const findTaskType = (cfg: CrmConfig, key: string | undefined) => (key ? cfg.taskTypes.find((s) => s.key === key) : undefined);
export const findTaskInput = (cfg: CrmConfig, key: string | undefined) => (key ? cfg.taskInputs.find((s) => s.key === key) : undefined);

/** A megjelenítendő név; ismeretlen (pl. kivezetett) kulcsnál maga a kulcs - nincs adatvesztés, nincs kitalált név. */
export const statusLabel = (cfg: CrmConfig, key: string): string => findStatus(cfg, key)?.label ?? key;
export const taskTypeLabel = (cfg: CrmConfig, key: string): string => findTaskType(cfg, key)?.label ?? key;
export const taskInputLabel = (cfg: CrmConfig, key: string): string => findTaskInput(cfg, key)?.label ?? key;
export const statusColor = (cfg: CrmConfig, key: string): StatusColor => findStatus(cfg, key)?.color ?? "neutral";

/** Az alapértelmezett (új ügyfél) státusz kulcsa a katalógusból; a rendszerstátusz kulcsa nem változhat. */
export const defaultStatusKey = (cfg: CrmConfig): string => cfg.statuses.find((s) => s.semantic === "default")?.key ?? DEFAULT_STATUS_KEY;
export const isOutreachStatus = (cfg: CrmConfig, key: string) => findStatus(cfg, key)?.semantic === "outreach";
/** Igazolást igénylő (szolgáltatói mérföldkő) státusz. Ismeretlen kulcs: nem mérföldkő, de választani sem lehet (lásd isSelectableStatus). */
export const isMilestoneStatus = (cfg: CrmConfig, key: string) => {
  const s = findStatus(cfg, key);
  return Boolean(s && (s.semantic === "milestone" || s.requiresVerification));
};
/** Új ügyfélhez vagy státuszváltásként csak aktív, a katalógusban szereplő státusz választható. */
export const isSelectableStatus = (cfg: CrmConfig, key: string) => findStatus(cfg, key)?.isActive === true;
