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
export interface DuplicateCandidate {
  /** null: az egyezés nem megjeleníthető (pl. eltávolított rekord) - adatai nem kerülnek ki. */
  customerId: string | null;
  name: string;
  typeLabel: string;
  level: DuplicateLevel;
  reasons: string[];
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
const strongPhone = (s?: string) => {
  const k = s ? phoneKey(s) : "";
  return k.length >= 6 ? k : "";
};
const strongEmail = (s?: string) => {
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
    const strong: string[] = [];
    const possible: string[] = [];
    if (email && strongEmail(c.email) === email) strong.push("Azonos e-mail-cím");
    if (phone && strongPhone(c.phone) === phone) strong.push("Azonos telefonszám");
    if (c.type === "company") {
      if (draft.type === "company" && ownName && nameKey(c.companyName, true) === ownName) possible.push("Azonos cégnév");
      for (const k of snap.contacts.filter((x) => x.companyId === c.id)) {
        const who = contactName(k);
        if (email && strongEmail(k.email) === email) strong.push(`Azonos e-mail-cím (kapcsolattartó: ${who})`);
        if (phone && strongPhone(k.phone) === phone) strong.push(`Azonos telefonszám (kapcsolattartó: ${who})`);
        if (personName && nameKey(`${k.lastName} ${k.firstName}`) === personName) possible.push(`Azonos kapcsolati személy neve (${who})`);
      }
    } else if (personName && nameKey(c.displayName) === personName) {
      possible.push(draft.type === "company" ? "A kapcsolati személy neve azonos egy magánszemély ügyfél nevével" : "Azonos név");
    }
    if (strong.length || possible.length) {
      out.push({ customerId: c.id, name: customerName(c), typeLabel: CUSTOMER_TYPE_LABELS[c.type], level: strong.length ? "strong" : "possible", reasons: [...strong, ...possible] });
    }
  }
  return out.sort((a, b) => Number(a.level === "possible") - Number(b.level === "possible") || a.name.localeCompare(b.name, "hu"));
}

/** Az eltávolított (logikailag törölt) rekordokkal való egyezés: csak a tény és az ok jelenik meg, a rekord adatai nem. */
export function maskRemoved(c: DuplicateCandidate): DuplicateCandidate {
  return { customerId: null, name: "Eltávolított ügyfélrekord (tesztfázis)", typeLabel: c.typeLabel, level: c.level, reasons: c.reasons.map((r) => r.replace(/ \([^)]*\)$/, "")) };
}
