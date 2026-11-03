/**
 * CSV olvasása (RFC 4180 szerint, idézőjelezett mezőkkel és mezőn belüli sortöréssel) és írása (v1.0).
 *
 * Olvasás: a kódolás explicit (UTF-8 alapértelmezett, BOM-mal vagy anélkül; a régi magyar Excel-mentéshez Windows-1250 választható).
 * Nem UTF-8 bájtsorozatot UTF-8-ként NEM fogadunk el csendben (`bad_encoding`), és bináris (NUL bájtot tartalmazó) fájlt sem.
 * Elválasztó: pontosvessző, vessző vagy tabulátor - az első sor alapján felismerve (idézőjelen kívül számolva).
 */
export class CsvError extends Error {
  constructor(public readonly code: "bad_encoding" | "binary" | "unterminated_quote" | "too_many_rows" | "too_many_physical_rows" | "too_many_columns" | "cell_too_long" | "timeout") {
    super(code);
  }
}

export type CsvEncoding = "utf-8" | "windows-1250";
export const CSV_ENCODINGS: readonly CsvEncoding[] = ["utf-8", "windows-1250"];
/**
 * `maxRows`: nem üres sorok (a fejléccel együtt legfeljebb maxRows + 1). `maxPhysicalRows`: a fájl 1. sorától az utolsó nem üres sorig
 * terjedő FIZIKAI sorok száma (üres köztes sorokkal együtt) - a feldolgozási munka strukturális felső korlátja.
 */
export interface CsvLimits { maxRows: number; maxColumns: number; maxCellChars: number; deadline: number; maxPhysicalRows?: number }

export function decodeCsv(bytes: Uint8Array, encoding: CsvEncoding): string {
  if (bytes.includes(0)) throw new CsvError("binary");
  let b = bytes;
  if (b[0] === 0xef && b[1] === 0xbb && b[2] === 0xbf) {
    if (encoding !== "utf-8") throw new CsvError("bad_encoding");
    b = b.subarray(3);
  }
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(b);
  } catch {
    throw new CsvError("bad_encoding");
  }
}

export function detectDelimiter(text: string): ";" | "," | "\t" {
  const counts = { ";": 0, ",": 0, "\t": 0 } as Record<";" | "," | "\t", number>;
  let quoted = false;
  for (let i = 0; i < text.length && i < 64 * 1024; i++) {
    const ch = text[i];
    if (ch === '"') quoted = !quoted;
    else if (!quoted && (ch === "\n" || ch === "\r")) break;
    else if (!quoted && ch in counts) counts[ch as ";" | "," | "\t"]++;
  }
  const best = (Object.entries(counts) as [";" | "," | "\t", number][]).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ";";
}

/**
 * Sorok mezőkre bontva, az eredeti sorindexek megtartásával. A teljesen üres sorok a fájl végéről elmaradnak. Az üres sorok csak akkor
 * kerülnek a tömbbe, ha utánuk még nem üres sor következik, és a fizikai sorkorláton belül vannak (a túllépés hiba, nem csendes csonkolás).
 */
export function parseCsv(text: string, limits: CsvLimits, delimiter = detectDelimiter(text)): { rows: string[][]; delimiter: string } {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  let fieldStart = true;
  let nonEmpty = 0;
  let pendingEmpty = 0;
  const maxPhysical = limits.maxPhysicalRows ?? Infinity;
  const pushField = () => {
    if (field.length > limits.maxCellChars) throw new CsvError("cell_too_long");
    row.push(field);
    if (row.length > limits.maxColumns && row.some((v, i) => i >= limits.maxColumns && v.trim() !== "")) throw new CsvError("too_many_columns");
    field = "";
    fieldStart = true;
  };
  const pushRow = () => {
    pushField();
    while (row.length > limits.maxColumns && row[row.length - 1].trim() === "") row.pop();
    if (!row.some((v) => v.trim() !== "")) {
      // Üres sor: csak számoljuk; nem materializáljuk, amíg nem jön utána tartalom.
      pendingEmpty++;
      row = [];
      return;
    }
    nonEmpty++;
    if (nonEmpty > limits.maxRows + 1) throw new CsvError("too_many_rows");
    if (rows.length + pendingEmpty + 1 > maxPhysical) throw new CsvError("too_many_physical_rows");
    for (; pendingEmpty > 0; pendingEmpty--) rows.push([]);
    rows.push(row);
    row = [];
  };
  for (let i = 0; i < text.length; i++) {
    if ((i & 0xffff) === 0 && Date.now() > limits.deadline) throw new CsvError("timeout");
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && fieldStart) { quoted = true; fieldStart = false; continue; }
    if (ch === delimiter) { pushField(); continue; }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      pushRow();
      continue;
    }
    field += ch;
    fieldStart = false;
  }
  if (quoted) throw new CsvError("unterminated_quote");
  if (field !== "" || row.length) pushRow();
  return { rows, delimiter };
}

/** Egy CSV-mező kiírása (idézőjelezés, ha szükséges). A képletinjekció elleni védelmet a hívó (export) végzi. */
export function csvField(v: string, delimiter = ";"): string {
  return /["\r\n]/.test(v) || v.includes(delimiter) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** CSV-dokumentum: UTF-8 BOM (Excel helyes ékezetkezeléséhez), CRLF sorvég, pontosvessző elválasztó (magyar Excel). */
export function writeCsv(rows: string[][], delimiter = ";"): Buffer {
  const body = rows.map((r) => r.map((v) => csvField(v, delimiter)).join(delimiter)).join("\r\n") + "\r\n";
  return Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(body, "utf8")]);
}
