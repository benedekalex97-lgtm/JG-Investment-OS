import { z } from "zod";
import { CUSTOMER_TYPE_LABELS, RESTRICTION_LABELS } from "@/domain/constants";
import { CONFIG_KEY_RE, findStatus, statusLabel, type CrmConfig } from "@/domain/config";
import { contactName, customerName, otherContactsOf, primaryContactOf, searchCustomers, statusOf } from "@/domain/logic";
import type { Customer, DataSnapshot } from "@/domain/types";
import { loadSnapshot } from "../crm/store";
import type { Tx } from "../db/types";
import { writeCsv } from "./files/csv";
import { writeXlsx } from "./files/xlsx";

/**
 * Szűrt ügyfélexport (v1.0, CRM-017). NEM teljes adatbázismentés: kizárólag az aktív (nem logikailag törölt) ügyfelek engedélyezett
 * ügyfél- és kapcsolattartói mezői. Nem kerül bele: ügyféljegyzet, feladat/Output, előzmény, auditnapló, felhasználói adat,
 * jelszó-hash, OAuth-azonosító, rendszertitok. A szűrés a CRM meglévő keresőlogikáját használja (searchCustomers).
 *
 * Képletinjekció elleni védelem (CSV/Excel injection):
 *  - XLSX: minden cella szöveges (inlineStr), képlet nem kerül a fájlba -> az érték változatlan, és az Excel nem értékeli ki;
 *  - CSV: a =, +, -, @ (és teljes szélességű változataik), tabulátor, kocsivissza és sortörés kezdetű értékek elé aposztróf kerül
 *    (OWASP ajánlás), így a táblázatkezelő szövegként kezeli. Az eredeti érték a vezető aposztróf elhagyásával visszanyerhető.
 */
export const exportFilters = z.object({
  query: z.string().max(200).optional(),
  type: z.enum(["individual", "company"]).optional(),
  /** A katalógus kulcsa (archivált státusz szerint is szűrhető: az ügyfelei továbbra is exportálhatók). Ismeretlen kulcs: 0 találat. */
  crmStatus: z.string().regex(CONFIG_KEY_RE).optional(),
  source: z.string().max(200).optional(),
}).strict();
export type ExportFilters = z.infer<typeof exportFilters>;
export const exportBody = z.object({ format: z.enum(["csv", "xlsx"]), filters: exportFilters }).strict();

const foldSource = (s: string) => s.trim().toLowerCase();

/** Ismeretlen (a katalógusban nem szereplő) státuszkulcs a szűrőben: érvénytelen kérés (400), nem üres találat. */
export class ExportFilterError extends Error {}

export function filterCustomers(snap: DataSnapshot, f: ExportFilters): Customer[] {
  if (f.crmStatus && !findStatus(snap.config, f.crmStatus)) throw new ExportFilterError("Ismeretlen státusz a szűrőben.");
  const list = searchCustomers(snap, { query: f.query, type: f.type ?? "", crmStatus: f.crmStatus ?? "" });
  const src = f.source ? foldSource(f.source) : "";
  return (src ? list.filter((c) => foldSource(c.source) === src) : list)
    .sort((a, b) => customerName(a).localeCompare(customerName(b), "hu") || a.id.localeCompare(b.id));
}

/** Az aktív ügyfelek adatforrás-értékei (a szűrő választólistájához). */
export function sourcesOf(snap: DataSnapshot): string[] {
  return [...new Set(snap.customers.map((c) => c.source.trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b, "hu")).slice(0, 300);
}

const DANGEROUS = /^[=+\-@＝＋－＠\t\r\n]/;
/** CSV-cella képletinjekció ellen: veszélyes kezdőkarakternél aposztróf előtag. */
export const neutralizeCsv = (v: string) => (DANGEROUS.test(v) ? `'${v}` : v);

export const CUSTOMER_COLUMNS = [
  "Ügyfélazonosító", "Ügyféltípus", "Ügyfélnév", "Vezetéknév", "Keresztnév", "Cégnév", "Telefonszám", "E-mail",
  "Elsődleges kapcsolattartó", "Kapcsolattartó beosztása", "Kapcsolattartó telefonszáma", "Kapcsolattartó e-mail-címe", "További kapcsolattartók száma",
  "Pipeline-státusz", "Adatforrás", "Megkeresési korlátozás", "Létrehozva",
] as const;
export const CONTACT_COLUMNS = ["Ügyfélazonosító", "Cégnév", "Kapcsolattartó azonosító", "Vezetéknév", "Keresztnév", "Beosztás", "Telefonszám", "E-mail", "Elsődleges"] as const;

export function customerRows(snap: DataSnapshot, list: Customer[]): string[][] {
  return list.map((c) => {
    const primary = c.type === "company" ? primaryContactOf(snap, c.id) : undefined;
    const others = c.type === "company" ? otherContactsOf(snap, c.id).length : 0;
    return [
      c.id, CUSTOMER_TYPE_LABELS[c.type], customerName(c),
      c.type === "individual" ? c.lastName : "", c.type === "individual" ? c.firstName : "", c.type === "company" ? c.companyName : "",
      c.phone ?? "", c.email ?? "",
      primary ? contactName(primary) : "", primary?.position ?? "", primary?.phone ?? "", primary?.email ?? "", c.type === "company" ? String(others) : "",
      statusLabel(snap.config, statusOf(c)), c.source, c.restriction ? RESTRICTION_LABELS[c.restriction.kind] : "", c.createdAt.slice(0, 10),
    ];
  });
}

export function contactRows(snap: DataSnapshot, list: Customer[]): string[][] {
  const ids = new Set(list.filter((c) => c.type === "company").map((c) => c.id));
  const nameOf = new Map(list.map((c) => [c.id, customerName(c)]));
  return snap.contacts
    .filter((k) => ids.has(k.companyId))
    .sort((a, b) => (nameOf.get(a.companyId) ?? "").localeCompare(nameOf.get(b.companyId) ?? "", "hu") || Number(b.isPrimaryContact) - Number(a.isPrimaryContact) || a.id.localeCompare(b.id))
    .map((k) => [k.companyId, nameOf.get(k.companyId) ?? "", k.id, k.lastName, k.firstName, k.position ?? "", k.phone ?? "", k.email ?? "", k.isPrimaryContact ? "Igen" : "Nem"]);
}

export function describeFilters(f: ExportFilters, config?: CrmConfig): string {
  const parts: string[] = [];
  if (f.crmStatus) parts.push(`Pipeline-státusz: ${config ? statusLabel(config, f.crmStatus) : f.crmStatus}`);
  if (f.type) parts.push(`Ügyféltípus: ${CUSTOMER_TYPE_LABELS[f.type]}`);
  if (f.source) parts.push(`Adatforrás: ${f.source}`);
  if (f.query?.trim()) parts.push("Szöveges keresés: igen");
  return parts.length ? parts.join("; ") : "Minden aktív ügyfél";
}

export interface ExportFile { body: Buffer; contentType: string; filename: string; count: number; config: CrmConfig }

const stamp = (d: Date) => {
  const p = new Intl.DateTimeFormat("sv-SE", { timeZone: "Europe/Budapest", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" }).format(d);
  return p.replace(" ", "_").replace(":", "");
};

/** Az export elkészítése a kérés (RLS-es) tranzakciójában; az adat csak a válaszba kerül, sehol nem tárolódik. */
export async function buildExport(tx: Tx, format: "csv" | "xlsx", filters: ExportFilters, now: Date): Promise<ExportFile> {
  const snap = await loadSnapshot(tx);
  const list = filterCustomers(snap, filters);
  const header = [...CUSTOMER_COLUMNS];
  const rows = customerRows(snap, list);
  const name = `JG_CRM_Ugyfelek_${stamp(now)}`;
  if (format === "csv") {
    return { body: writeCsv([header, ...rows].map((r) => r.map(neutralizeCsv))), contentType: "text/csv; charset=utf-8", filename: `${name}.csv`, count: list.length, config: snap.config };
  }
  const info = [
    ["Megnevezés", "Érték"],
    ["Exportálva", new Intl.DateTimeFormat("hu-HU", { timeZone: "Europe/Budapest", dateStyle: "long", timeStyle: "short" }).format(now)],
    ["Szűrés", describeFilters(filters, snap.config)],
    ["Ügyfelek száma", String(list.length)],
    ["Figyelmeztetés", "A fájl személyes adatot tartalmaz. Csak jogosult célra használd, ne továbbítsd, és a felhasználás után töröld."],
  ];
  const body = writeXlsx([
    { name: "Ügyfelek", rows: [header, ...rows], boldHeader: true, widths: [22, 14, 28, 16, 16, 28, 18, 28, 26, 20, 20, 28, 12, 22, 22, 18, 12] },
    { name: "Kapcsolattartók", rows: [[...CONTACT_COLUMNS], ...contactRows(snap, list)], boldHeader: true, widths: [22, 28, 22, 16, 16, 20, 18, 28, 10] },
    { name: "Exportinformáció", rows: info, boldHeader: true, widths: [20, 90] },
  ], now);
  return { body, contentType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", filename: `${name}.xlsx`, count: list.length, config: snap.config };
}

export async function exportCount(tx: Tx, filters: ExportFilters): Promise<{ count: number; sources: string[] }> {
  const snap = await loadSnapshot(tx);
  return { count: filterCustomers(snap, filters).length, sources: sourcesOf(snap) };
}
