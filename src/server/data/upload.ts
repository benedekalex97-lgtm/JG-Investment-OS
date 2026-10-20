import { createHash } from "node:crypto";
import { CSV_ENCODINGS, CsvError, decodeCsv, parseCsv, type CsvEncoding } from "./files/csv";
import { XlsxError, XlsxWorkbook, type SheetInfo } from "./files/xlsx";
import type { DataLimits } from "./limits";

/**
 * A feltöltött importfájl értelmezése (CSV / XLSX). A fájl csak a kérés idejére, memóriában létezik: sehol nem tárolódik (sem
 * adatbázisban, sem lemezen, sem böngészőtárolóban); csak a típusa, mérete és SHA-256 lenyomata kerül az importnaplóba.
 * A deklarált típusnak és a tényleges tartalomnak egyeznie kell (az XLSX ZIP-fájl, a CSV nem lehet ZIP vagy bináris).
 */
export type FileType = "csv" | "xlsx";
export const FILE_TYPES: readonly FileType[] = ["csv", "xlsx"];

export class UploadError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
  }
}

export interface ParsedUpload {
  fileType: FileType;
  sha256: string;
  size: number;
  sheets: SheetInfo[];
  sheetIndex: number;
  encoding?: CsvEncoding;
  delimiter?: string;
  headers: string[];
  /** Adatsorok a fejléc után, eredeti sorszámmal (fejléc sora = headerRowNo). */
  rows: { rowNo: number; cells: string[] }[];
  headerRowNo: number;
  /** Képletes / hibaértékű cellák: `${rowNo}:${col}`. */
  formulaCells: Set<string>;
  errorCells: Set<string>;
}

const MESSAGES: Record<string, string> = {
  empty: "A fájl üres.",
  too_large: "A fájl túl nagy.",
  unsupported_type: "Nem támogatott fájlformátum. Csak .csv és .xlsx tölthető fel.",
  type_mismatch: "A fájl tartalma nem felel meg a kiterjesztésének (pl. átnevezett fájl).",
  not_xlsx: "A fájl nem érvényes Excel-munkafüzet (.xlsx).",
  macro: "Makrót tartalmazó munkafüzet nem tölthető fel. Mentsd .xlsx formátumban, makrók nélkül.",
  external: "A munkafüzet külső hivatkozást, adatkapcsolatot vagy beágyazott objektumot tartalmaz. Mentsd el csak az értékeket egy új .xlsx fájlba.",
  corrupt: "A fájl sérült vagy nem olvasható.",
  too_many_rows: "A fájl túl sok adatsort tartalmaz.",
  too_many_columns: "A fájl túl sok oszlopot tartalmaz.",
  cell_too_long: "A fájl túl hosszú cellaértéket tartalmaz.",
  timeout: "A fájl feldolgozása túl sokáig tartott. Bontsd kisebb részekre.",
  no_sheet: "A munkafüzetben nincs olvasható munkalap.",
  bad_encoding: "A fájl kódolása nem UTF-8. Mentsd UTF-8 kódolású CSV-ként, vagy válaszd a Windows-1250 kódolást.",
  binary: "A fájl bináris tartalmú, nem CSV.",
  unterminated_quote: "Sérült CSV: lezáratlan idézőjel.",
  no_header: "A fájlban nem található fejlécsor.",
  bad_sheet: "A kiválasztott munkalap nem létezik.",
};
export const uploadMessage = (code: string) => MESSAGES[code] ?? MESSAGES.corrupt;
const fail = (code: string): never => {
  throw new UploadError(code, uploadMessage(code));
};

export const sha256Hex = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");

export function parseUpload(bytes: Buffer, declared: string, opts: { encoding?: string; sheetIndex?: number }, limits: DataLimits, now = Date.now()): ParsedUpload {
  if (!FILE_TYPES.includes(declared as FileType)) fail("unsupported_type");
  const fileType = declared as FileType;
  if (!bytes.length) fail("empty");
  if (bytes.length > limits.maxFileBytes) fail("too_large");
  const isZip = bytes.length >= 4 && bytes.readUInt32LE(0) === 0x04034b50;
  if ((fileType === "xlsx") !== isZip) fail("type_mismatch");
  const deadline = now + limits.maxSeconds * 1000;
  const rl = { maxRows: limits.maxRows, maxColumns: limits.maxColumns, maxCellChars: limits.maxCellChars, deadline };
  let rows: string[][];
  let sheets: SheetInfo[] = [];
  let sheetIndex = 0;
  let encoding: CsvEncoding | undefined;
  let delimiter: string | undefined;
  const formula = new Set<string>(), error = new Set<string>();
  try {
    if (fileType === "xlsx") {
      const wb = new XlsxWorkbook(bytes, rl);
      sheets = wb.sheetInfo();
      sheetIndex = opts.sheetIndex ?? wb.defaultSheet();
      if (!Number.isInteger(sheetIndex) || sheetIndex < 0 || sheetIndex >= sheets.length) fail("bad_sheet");
      const data = wb.read(sheetIndex);
      rows = data.rows;
      for (const k of data.flags.formula) formula.add(k);
      for (const k of data.flags.error) error.add(k);
    } else {
      encoding = CSV_ENCODINGS.find((e) => e === (opts.encoding ?? "utf-8"));
      if (!encoding) fail("bad_encoding");
      const parsed = parseCsv(decodeCsv(bytes, encoding as CsvEncoding), rl);
      rows = parsed.rows;
      delimiter = parsed.delimiter;
    }
  } catch (e) {
    if (e instanceof UploadError) throw e;
    if (e instanceof XlsxError || e instanceof CsvError) fail(e.code);
    throw e;
  }
  const headerIdx = rows.findIndex((r) => r.some((v) => v.trim() !== ""));
  if (headerIdx < 0) fail("no_header");
  const headers = rows[headerIdx].map((h) => h.trim().slice(0, 200));
  // Képlet/hiba a fejlécben: a fejléc csak szöveg lehet.
  for (let c = 0; c < headers.length; c++) if (formula.has(`${headerIdx}:${c}`) || error.has(`${headerIdx}:${c}`)) fail("corrupt");
  const dataRows: ParsedUpload["rows"] = [];
  for (let i = headerIdx + 1; i < rows.length; i++) dataRows.push({ rowNo: i + 1, cells: rows[i] ?? [] });
  // A jelzők a 0-alapú sorindexről a sorszámra (rowNo) képezve.
  const shift = (s: Set<string>) => new Set([...s].map((k) => { const [r, c] = k.split(":").map(Number); return `${r + 1}:${c}`; }));
  return {
    fileType, sha256: sha256Hex(bytes), size: bytes.length, sheets, sheetIndex, encoding, delimiter, headers, rows: dataRows, headerRowNo: headerIdx + 1,
    formulaCells: shift(formula), errorCells: shift(error),
  };
}
