/**
 * Adatvédelem (v1.3, GDPR): az érintetti kérelmek típusai, határidői és a hozzáférési kivonat adatkezelési tájékoztató blokkja.
 * Tiszta tartományi kód (kliens és szerver közös). A jogalap és a megőrzési rend a tulajdonos által 2026-11-25-én jóváhagyott szöveg
 * (docs/V1.3-DATA-PROTECTION.md 6. fejezet, docs/V1.3-LIA-JOGOS-ERDEK.md); módosítása csak az érdekmérlegelés és a dokumentáció frissítésével.
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
 * A hozzáférési kivonat (15. cikk (1)-(2)) adatkezelési tájékoztató blokkja (minden kivonatba bekerül).
 */
export const PROCESSING_INFO = {
  controller: "JG Investment Plus Kft.",
  purposes: [
    "Kapcsolatfelvétel és üzleti kapcsolattartás leendő és meglévő ügyfelekkel (CRM).",
    "A kapcsolatfelvétel és az ügyfélút nyomon követése (Pipeline-státusz, feladatok, érkezési csatorna).",
  ],
  legalBasis: "Jogos érdek (GDPR 6. cikk (1) f)): az üzleti kapcsolatfelvétel és -tartás a JG Investment Plus Kft. jogos érdeke, amely az elvégzett érdekmérlegelés szerint nem sérti aránytalanul az érintett érdekeit; szerződéses ügyfél esetén a szerződés megkötését megelőző lépések és a szerződés teljesítése (6. cikk (1) b)). Az érintett a jogos érdeken alapuló adatkezelés ellen bármikor tiltakozhat; közvetlen üzletszerzés elleni tiltakozás esetén az adatkezelés e célból megszűnik.",
  categories: [
    "Azonosító adatok: név, cégnév, kapcsolattartó neve és beosztása.",
    "Elérhetőség: telefonszám, e-mail-cím.",
    "Kapcsolati adatok: Pipeline-státusz, feladatok és azok eredménye (Output), jegyzetek, ügyféltörténet, érkezési csatorna, adatforrás.",
    "Adatvédelmi adatok: tiltakozás / megkeresési korlátozás ténye, az érintetti kérelmek nyilvántartása.",
  ],
  recipients: [
    "Adatfeldolgozók (tárhely és infrastruktúra): Vercel Inc. (alkalmazás-futtatás, EU - Frankfurt régió), Neon (PostgreSQL adatbázis, EU - Frankfurt régió), Google (munkatársi bejelentkezés; ügyféladatot nem kap).",
    "Harmadik félnek ügyféladat nem kerül továbbításra; marketingautomatizáció és profilalkotás nincs.",
  ],
  retention: "Érdeklődő / leendő ügyfél: az utolsó kapcsolattól számított 24 hónap; elvesztett / lezárt kapcsolat: 12 hónap; szerződéses ügyfél: a szerződéses viszony megszűnése után az irányadó elévülési, illetve ágazati megőrzési ideig; az eltávolított ügyféladat legfeljebb 6 hónapig, ezután végleges törlés. Az érintetti kérelmek nyilvántartása a lezárástól 5 évig; a tiltakozás / törlés tiszteletben tartásához szükséges tiltólista-lenyomat a szükségesség fennállásáig (évenkénti felülvizsgálattal). Mentések: legfeljebb 12 hónap.",
  source: "Az adat forrását az ügyfél „Adatforrás” mezője és - importnál - az importnapló (adatforrás megnevezése, célja, ellenőrzési státusza) rögzíti.",
  automatedDecisions: "Automatizált döntéshozatal és profilalkotás nincs.",
  rights: "Hozzáférés, helyesbítés, törlés, korlátozás, adathordozhatóság, tiltakozás; panasz a Nemzeti Adatvédelmi és Információszabadság Hatóságnál (NAIH, 1055 Budapest, Falk Miksa utca 9-11., ugyfelszolgalat@naih.hu).",
} as const;
