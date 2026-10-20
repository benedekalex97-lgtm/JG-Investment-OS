import { CRM_STATUS_LABELS, DEFAULT_CRM_STATUS } from "@/domain/constants";
import { writeXlsx } from "./files/xlsx";

/**
 * Letölthető importsablon (JG_CRM_Import_Template.xlsx): oszlopnevek (az automatikus felismerés pontosan ezeket ismeri fel),
 * mezőmagyarázatok, kötelezőség és KIZÁRÓLAG fiktív példasorok (example.test domain, 000-s telefonszámok). Valós ügyféladat nincs benne.
 */
export const TEMPLATE_HEADERS = [
  "Ügyféltípus", "Vezetéknév", "Keresztnév", "Cégnév", "Telefonszám", "E-mail",
  "Kapcsolattartó neve", "Kapcsolattartó beosztása", "Kapcsolattartó telefonszáma", "Kapcsolattartó e-mail-címe", "Megjegyzés", "Adatforrás",
];

export const TEMPLATE_EXAMPLES = [
  ["Magánszemély", "Minta", "Anna", "", "+36 30 000 0001", "minta.anna@example.test", "", "", "", "", "Fiktív példasor - töröld importálás előtt.", ""],
  ["Cég", "", "", "Példa Kft.", "+36 1 000 0002", "info@pelda-kft.example.test", "Teszt Elek", "ügyvezető", "+36 20 000 0003", "teszt.elek@pelda-kft.example.test", "", "Fiktív rendezvény (példa)"],
  ["Magánszemély", "Próba", "Béla", "", "06 70 000 0004", "", "", "", "", "", "", ""],
];

const GUIDE = [
  ["Mező", "Kötelező", "Leírás", "Elfogadott értékek / formátum"],
  ["Ügyféltípus", "Igen (ha az importnál nincs alapértelmezett típus)", "Magánszemély vagy Cég.", "Magánszemély, Cég"],
  ["Vezetéknév", "Magánszemélynél igen", "A magánszemély vezetékneve.", "Szöveg, legfeljebb 200 karakter"],
  ["Keresztnév", "Nem", "A magánszemély keresztneve.", "Szöveg, legfeljebb 200 karakter"],
  ["Cégnév", "Cégnél igen", "A cég neve. Magánszemélynél üresen hagyandó.", "Szöveg, legfeljebb 200 karakter"],
  ["Telefonszám", "Nem", "Az ügyfél telefonszáma. A +36 / 06 / 0036 előhívós magyar számok egységes alakra kerülnek.", "pl. +36 30 123 4567"],
  ["E-mail", "Nem", "Az ügyfél e-mail-címe.", "pl. nev@example.test"],
  ["Kapcsolattartó neve", "Nem (csak cégnél)", "A cég kapcsolattartójának neve, vezetéknév elöl.", "pl. Teszt Elek"],
  ["Kapcsolattartó beosztása", "Nem (csak cégnél)", "A kapcsolattartó beosztása.", "Szöveg, legfeljebb 120 karakter"],
  ["Kapcsolattartó telefonszáma", "Nem (csak cégnél)", "Csak a kapcsolattartó vezeték- és keresztnevével együtt adható meg.", "pl. +36 20 123 4567"],
  ["Kapcsolattartó e-mail-címe", "Nem (csak cégnél)", "Csak a kapcsolattartó vezeték- és keresztnevével együtt adható meg.", "pl. nev@ceg.example.test"],
  ["Megjegyzés", "Nem (csak magánszemélynél)", "Rövid megjegyzés. Különleges (pl. egészségügyi) adatot ne tartalmazzon.", "Szöveg, legfeljebb 2000 karakter"],
  ["Adatforrás", "Nem", "Soronkénti adatforrás. Ha üres, az importnál megadott adatforrás-megnevezés kerül az ügyfélhez.", "Szöveg, legfeljebb 200 karakter"],
  ["", "", "", ""],
  ["Fontos", "", `Minden importált ügyfél „${CRM_STATUS_LABELS[DEFAULT_CRM_STATUS]}” státusszal jön létre; a fájlban megadott más státusz nem kerül átvételre.`, ""],
  ["Fontos", "", "Az import nem jelöl ügyfelet megkereshetőnek, nem minősül hozzájárulásnak, és nem módosít meglévő ügyfelet, tiltakozást vagy megkeresési korlátozást.", ""],
  ["Fontos", "", "Képletet tartalmazó cella nem importálható. Makrós (.xlsm) munkafüzet nem tölthető fel.", ""],
];

export function importTemplate(now = new Date()): Buffer {
  return writeXlsx([
    { name: "Ügyfelek", rows: [TEMPLATE_HEADERS, ...TEMPLATE_EXAMPLES], boldHeader: true, widths: [14, 16, 16, 24, 18, 30, 22, 22, 24, 32, 36, 26] },
    { name: "Útmutató", rows: GUIDE, boldHeader: true, widths: [28, 34, 80, 34] },
  ], now);
}
