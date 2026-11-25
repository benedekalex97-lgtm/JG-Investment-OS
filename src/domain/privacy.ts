/**
 * Adatvédelem (v1.3, GDPR): az érintetti kérelmek típusai, határidői és a hozzáférési kivonat adatkezelési tájékoztató blokkja.
 * Tiszta tartományi kód (kliens és szerver közös). A jogi minősítéseket (jogalap, megőrzési idő) az adatvédelmi felelős véglegesíti:
 * a lenti szövegek a rendszer TÉNYLEGES technikai működését írják le, a jogi rész jóváhagyásig „egyeztetés alatt” jelölést kap.
 */
export const PRIVACY_REQUEST_KINDS = ["access", "portability", "rectification", "erasure", "restriction", "objection"] as const;
export type PrivacyRequestKind = (typeof PRIVACY_REQUEST_KINDS)[number];
export const PRIVACY_REQUEST_STATUSES = ["open", "in_progress", "completed", "rejected"] as const;
export type PrivacyRequestStatus = (typeof PRIVACY_REQUEST_STATUSES)[number];
export const PRIVACY_CHANNELS = ["email", "phone", "letter", "in_person", "other"] as const;
export type PrivacyChannel = (typeof PRIVACY_CHANNELS)[number];

export const PRIVACY_KIND_LABELS: Record<PrivacyRequestKind, string> = {
  access: "Hozzáférés (15. cikk)",
  portability: "Adathordozhatóság (20. cikk)",
  rectification: "Helyesbítés (16. cikk)",
  erasure: "Törlés (17. cikk)",
  restriction: "Korlátozás (18. cikk)",
  objection: "Tiltakozás (21. cikk)",
};
export const PRIVACY_STATUS_LABELS: Record<PrivacyRequestStatus, string> = { open: "Nyitott", in_progress: "Folyamatban", completed: "Teljesítve", rejected: "Elutasítva" };
export const PRIVACY_CHANNEL_LABELS: Record<PrivacyChannel, string> = { email: "E-mail", phone: "Telefon", letter: "Levél", in_person: "Személyesen", other: "Egyéb" };

/** A GDPR 12. cikk (3): a kérelemre indokolatlan késedelem nélkül, legfeljebb egy hónapon belül; további két hónappal meghosszabbítható. */
export const addMonths = (d: Date, months: number): Date => {
  const r = new Date(d.getTime());
  const day = r.getUTCDate();
  r.setUTCDate(1);
  r.setUTCMonth(r.getUTCMonth() + months);
  const last = new Date(Date.UTC(r.getUTCFullYear(), r.getUTCMonth() + 1, 0)).getUTCDate();
  r.setUTCDate(Math.min(day, last));
  return r;
};
export const requestDueAt = (receivedAt: Date) => addMonths(receivedAt, 1);
export const extendedDueAt = (receivedAt: Date) => addMonths(receivedAt, 3);

export type DueState = "closed" | "overdue" | "due_soon" | "ok";
/** Határidő-állapot: lejárt, 7 napon belül esedékes, rendben (lezárt kérelemnél nincs). */
export function dueState(status: PrivacyRequestStatus, dueAt: string, now: Date): DueState {
  if (status === "completed" || status === "rejected") return "closed";
  const ms = new Date(dueAt).getTime() - now.getTime();
  if (ms < 0) return "overdue";
  return ms <= 7 * 24 * 3600_000 ? "due_soon" : "ok";
}

/** A végleges anonimizálás megerősítő szövege (a felhasználónak pontosan be kell írnia). */
export const ERASE_CONFIRMATION_WORD = "VÉGLEGES TÖRLÉS";

/**
 * A hozzáférési kivonat (15. cikk (1)-(2)) adatkezelési tájékoztató blokkja. A tényadatok (adatkategóriák, címzettek/adatfeldolgozók,
 * technikai megőrzés) a rendszer működését írják le; a jogalapot és a végleges megőrzési időt az adatvédelmi felelős hagyja jóvá.
 */
export const PROCESSING_INFO = {
  controller: "JG Investment Plus Kft.",
  purposes: [
    "Kapcsolatfelvétel és üzleti kapcsolattartás leendő és meglévő ügyfelekkel (CRM).",
    "A kapcsolatfelvétel és az ügyfélút nyomon követése (Pipeline-státusz, feladatok, érkezési csatorna).",
  ],
  legalBasis: "Egyeztetés alatt (adatvédelmi felelős): jogos érdek (6. cikk (1) f) és/vagy szerződéskötést megelőző lépések (6. cikk (1) b).",
  categories: [
    "Azonosító adatok: név, cégnév, kapcsolattartó neve és beosztása.",
    "Elérhetőség: telefonszám, e-mail-cím.",
    "Kapcsolati adatok: Pipeline-státusz, feladatok és azok eredménye (Output), jegyzetek, ügyféltörténet, érkezési csatorna, adatforrás.",
    "Adatvédelmi adatok: tiltakozás / megkeresési korlátozás ténye, az érintetti kérelmek nyilvántartása.",
  ],
  recipients: [
    "Adatfeldolgozók (tárhely és infrastruktúra): Vercel Inc. (alkalmazás-futtatás), Neon (PostgreSQL adatbázis, EU - Frankfurt régió), Google (munkatársi bejelentkezés; ügyféladatot nem kap).",
    "Harmadik félnek ügyféladat nem kerül továbbításra; marketingautomatizáció és profilalkotás nincs.",
  ],
  retention: "Egyeztetés alatt (adatvédelmi felelős). Technikai működés: inaktív ügyfelek felülvizsgálata alapértelmezetten 24 hónap után; az eltávolított ügyfél végleges anonimizálása kérelemre vagy felülvizsgálat alapján; mentések a mentési megőrzési rend szerint.",
  source: "Az adat forrását az ügyfél „Adatforrás” mezője és - importnál - az importnapló (adatforrás megnevezése, célja, ellenőrzési státusza) rögzíti.",
  automatedDecisions: "Automatizált döntéshozatal és profilalkotás nincs.",
  rights: "Hozzáférés, helyesbítés, törlés, korlátozás, adathordozhatóság, tiltakozás; panasz a Nemzeti Adatvédelmi és Információszabadság Hatóságnál (NAIH, 1055 Budapest, Falk Miksa utca 9-11., ugyfelszolgalat@naih.hu).",
} as const;
