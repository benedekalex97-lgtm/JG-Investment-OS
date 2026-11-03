import { CUSTOMER_TYPE_LABELS } from "./constants";
import { contactName, customerName, fold, normalizeEmail, phoneKey } from "./logic";
import type { DataSnapshot } from "./types";

/**
 * Duplikált ügyfelek felismerése (v0.9, CRM-013): determinisztikus, tesztelhető egyezésvizsgálat - nincs fuzzy- vagy AI-alapú pontozás.
 * A normalizálás a kereséssel közös (`phoneKey`, `normalizeEmail`, `fold`). Két szint:
 *  - erős: azonos e-mail-cím vagy azonos telefonszám (az ügyfélé vagy egy céges kapcsolattartóé);
 *  - lehetséges: azonos név / cégnév (kisbetű, ékezet, írásjel, szórend és cégforma-rövidítés nélkül), vagy azonos kapcsolati személy.
 * Csak figyelmeztet: nem von össze, nem töröl és nem ír felül adatot; a döntés a felhasználóé.
 */
export type DuplicateLevel = "strong" | "possible";
/** Az egyezés oka strukturáltan: a maszkolás ebből (és nem a megjelenített szövegből) dolgozik. */
export type DuplicateReasonCode = "email" | "phone" | "contact_email" | "contact_phone" | "company_name" | "name" | "contact_name" | "contact_name_matches_individual";
/** Személyes adat nélküli, rögzített okszövegek (eltávolított rekordhoz). */
const GENERIC_REASON: Record<DuplicateReasonCode, string> = {
  email: "Azonos e-mail-cím", contact_email: "Azonos e-mail-cím",
  phone: "Azonos telefonszám", contact_phone: "Azonos telefonszám",
  company_name: "Azonos cégnév", name: "Azonos név", contact_name: "Azonos kapcsolati személy neve", contact_name_matches_individual: "Azonos név",
};
export interface DuplicateCandidate {
  /** null: az egyezés nem megjeleníthető (pl. eltávolított rekord) - adatai nem kerülnek ki. */
  customerId: string | null;
  name: string;
  typeLabel: string;
  level: DuplicateLevel;
  /** Megjelenített okok (aktív ügyfélnél a kapcsolattartó nevével). */
  reasons: string[];
  /** Az okok kódjai, a `reasons`-szel azonos sorrendben. */
  codes: DuplicateReasonCode[];
}
export interface CustomerDraft {
  type: "individual" | "company";
  name?: string;
  companyName?: string;
  contactName?: string;
  phone?: string;
  email?: string;
}

const LEGAL_FORMS = new Set(["kft", "zrt", "nyrt", "rt", "bt", "kkt", "ev", "kht", "nonprofit", "ltd", "gmbh", "inc", "llc"]);

/** Név-kulcs: kisbetű, ékezet nélkül, írásjelek nélkül, szavak ábécérendben (a „Kovács Anna” = „Anna Kovács”). */
export function nameKey(s: string, company = false): string {
  const tokens = fold(s).replace(/[.,;:'"()&/+-]+/g, " ").split(/\s+/).filter(Boolean);
  return tokens.filter((t) => !company || !LEGAL_FORMS.has(t)).sort().join(" ");
}
/** Telefon-kulcs erős egyezéshez: legalább 6 számjegy (rövid töredék nem azonosít). */
export const strongPhone = (s?: string) => {
  const k = s ? phoneKey(s) : "";
  return k.length >= 6 ? k : "";
};
export const strongEmail = (s?: string) => {
  const e = s ? normalizeEmail(s) : "";
  return e.includes("@") ? e : "";
};

export function findDuplicates(snap: Pick<DataSnapshot, "customers" | "contacts">, draft: CustomerDraft): DuplicateCandidate[] {
  const email = strongEmail(draft.email);
  const phone = strongPhone(draft.phone);
  const ownName = draft.type === "company" ? nameKey(draft.companyName ?? "", true) : nameKey(draft.name ?? "");
  const personName = draft.type === "company" ? nameKey(draft.contactName ?? "") : ownName;
  const out: DuplicateCandidate[] = [];
  for (const c of snap.customers) {
    type Hit = { code: DuplicateReasonCode; text: string };
    const strong: Hit[] = [];
    const possible: Hit[] = [];
    if (email && strongEmail(c.email) === email) strong.push({ code: "email", text: "Azonos e-mail-cím" });
    if (phone && strongPhone(c.phone) === phone) strong.push({ code: "phone", text: "Azonos telefonszám" });
    if (c.type === "company") {
      if (draft.type === "company" && ownName && nameKey(c.companyName, true) === ownName) possible.push({ code: "company_name", text: "Azonos cégnév" });
      for (const k of snap.contacts.filter((x) => x.companyId === c.id)) {
        const who = contactName(k);
        if (email && strongEmail(k.email) === email) strong.push({ code: "contact_email", text: `Azonos e-mail-cím (kapcsolattartó: ${who})` });
        if (phone && strongPhone(k.phone) === phone) strong.push({ code: "contact_phone", text: `Azonos telefonszám (kapcsolattartó: ${who})` });
        if (personName && nameKey(`${k.lastName} ${k.firstName}`) === personName) possible.push({ code: "contact_name", text: `Azonos kapcsolati személy neve (${who})` });
      }
    } else if (personName && nameKey(c.displayName) === personName) {
      possible.push(draft.type === "company"
        ? { code: "contact_name_matches_individual", text: "A kapcsolati személy neve azonos egy magánszemély ügyfél nevével" }
        : { code: "name", text: "Azonos név" });
    }
    const all = [...strong, ...possible];
    if (all.length) {
      out.push({ customerId: c.id, name: customerName(c), typeLabel: CUSTOMER_TYPE_LABELS[c.type], level: strong.length ? "strong" : "possible", reasons: all.map((h) => h.text), codes: all.map((h) => h.code) });
    }
  }
  return out.sort((a, b) => Number(a.level === "possible") - Number(b.level === "possible") || a.name.localeCompare(b.name, "hu"));
}

/**
 * Az eltávolított (logikailag törölt) rekorddal való egyezés: csak a tény és az általános ok jelenik meg. A megjelenített okszöveget
 * (amely nevet tartalmazhat) egyáltalán nem használjuk: az okok kizárólag a kódokból és egy rögzített szövegtáblából épülnek fel,
 * így a név tartalma (pl. zárójelek) nem okozhat szivárgást. Nincs név, e-mail, telefonszám és ügyfélazonosító; ismeretlen kód nem kerül ki.
 */
export function maskRemoved(c: DuplicateCandidate): DuplicateCandidate {
  const codes = [...new Set(c.codes)].filter((code): code is DuplicateReasonCode => Object.hasOwn(GENERIC_REASON, code));
  const reasons = [...new Set(codes.map((code) => GENERIC_REASON[code]))];
  return { customerId: null, name: "Eltávolított ügyfélrekord", typeLabel: c.typeLabel === "Cég" ? "Cég" : "Magánszemély", level: c.level, reasons, codes };
}
