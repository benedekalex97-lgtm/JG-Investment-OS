import { phoneKey } from "./logic";

/**
 * Több telefonszám ügyfelenként (v1.4). Az ügyfélnek egy FŐ telefonszáma van (`phone` - ezt hívja a „Hívás” gomb, ez kerül a
 * „Telefonszám” export-oszlopba), mellette legfeljebb 9 TOVÁBBI szám (`extraPhones`). A kapcsolattartók telefonszáma változatlanul egy.
 *
 * Bevitelkor (űrlap, import) a számok vesszővel, pontosvesszővel vagy sortöréssel választhatók el; szóközzel nem, mert a szóköz a
 * telefonszám formázásának része („+36 20 123 4567”). Az ismétlődő számok (a formázástól független `phoneKey` szerint) kiesnek.
 */
export const EXTRA_PHONES_MAX = 9;
const SEPARATOR = /[,;\r\n]+/;

/** Elválasztott telefonszám-lista szétbontása (üres elemek nélkül). */
export const splitPhoneList = (v: string): string[] => v.split(SEPARATOR).map((s) => s.trim()).filter(Boolean);

/** Ismétlődés nélküli lista (az első előfordulás marad); az `exclude` számai (pl. a fő szám) kimaradnak. */
export function uniquePhones(list: readonly string[], exclude: readonly (string | undefined)[] = []): string[] {
  const seen = new Set(exclude.filter((p): p is string => Boolean(p)).map(phoneKey));
  const out: string[] = [];
  for (const p of list) {
    const k = phoneKey(p);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(p);
  }
  return out;
}

/** Az ügyfél összes telefonszáma: a fő szám, majd a további számok. */
export const customerPhones = (c: { phone?: string; extraPhones?: readonly string[] }): string[] => [...(c.phone ? [c.phone] : []), ...(c.extraPhones ?? [])];

/** Nyers (ellenőrizetlen) bemenet további számai - a tiltólista- és egyezésvizsgálathoz, a séma-ellenőrzés előtt. */
export const extraPhonesFromInput = (v: unknown): string[] =>
  typeof v === "string" ? splitPhoneList(v) : Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim()).filter(Boolean) : [];
