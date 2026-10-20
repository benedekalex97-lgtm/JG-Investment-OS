import { escapeXml, xmlEvents, XmlError } from "./xml";
import { writeZip, ZipError, ZipReader } from "./zip";

/**
 * XLSX (Office Open XML táblázat) olvasása és írása - szigorúan a cellaértékekre korlátozva (v1.0, CRM-014 / CRM-017).
 *
 * Olvasás:
 *  - csak .xlsx munkafüzet (fő tartalomtípus: spreadsheetml.sheet.main); makrós (xlsm, vbaProject), sablon, külső hivatkozás
 *    (externalLinks), külső adatkapcsolat (connections), beágyazott objektum (embeddings, activeX) esetén elutasít;
 *  - képletet NEM értékel ki, és a képlet tárolt (gyorsítótárazott) eredményét sem fogadja el: a képletes cella külön jelölt;
 *  - hibaértékű cella (#N/A stb.) jelölt; számok szövegként (exponens nélkül) kerülnek ki;
 *  - sor-, oszlop-, cellahossz- és időkorlát; a ZIP-réteg a kibontott méretet korlátozza (tömörítési bomba).
 * Írás: csak szöveges (inlineStr) cellák - képlet soha; a szöveg így Excelben sem értelmeződik képletként.
 */
export class XlsxError extends Error {
  constructor(public readonly code: "not_xlsx" | "macro" | "external" | "corrupt" | "too_large" | "too_many_rows" | "too_many_physical_rows" | "too_many_columns" | "cell_too_long" | "timeout" | "no_sheet") {
    super(code);
  }
}

export interface SheetInfo { name: string; hidden: boolean }
export interface CellFlags { formula: Set<string>; error: Set<string> }
export interface SheetData { rows: string[][]; flags: CellFlags }
/** Lásd CsvLimits: `maxPhysicalRows` a munkalap 1. sorától az utolsó tartalmas sorig terjedő sorok felső korlátja (ritkás munkalap ellen). */
export interface ReadLimits { maxRows: number; maxColumns: number; maxCellChars: number; deadline: number; maxPhysicalRows?: number }

const MAIN_CT = "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml";
const FORBIDDEN_PREFIXES = ["xl/externalLinks/", "xl/embeddings/", "xl/activeX/", "xl/ctrlProps/"];
const FORBIDDEN_FILES = ["xl/vbaProject.bin", "xl/connections.xml", "xl/vbaProjectSignature.bin"];

export const colIndex = (ref: string): number => {
  const m = /^([A-Z]{1,3})/.exec(ref);
  if (!m) return -1;
  let n = 0;
  for (const ch of m[1]) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
};
export const colName = (i: number): string => {
  let s = "";
  for (let n = i + 1; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
};

/** Szám szövegként, exponens és lebegőpontos zaj nélkül (pl. telefonszám 36301234567). */
export function numberText(v: string): string {
  const t = v.trim();
  if (/^-?\d+(\.\d+)?$/.test(t)) return t.replace(/\.0+$/, "");
  const n = Number(t);
  if (!Number.isFinite(n)) return t;
  if (Number.isInteger(n) && Math.abs(n) < 1e21) return BigInt(n).toString();
  return String(n);
}

export class XlsxWorkbook {
  private readonly zip: ZipReader;
  readonly sheets: { name: string; hidden: boolean; path: string }[] = [];
  private shared: string[] | null = null;

  constructor(bytes: Buffer, private readonly limits: ReadLimits) {
    try {
      this.zip = new ZipReader(bytes);
    } catch (e) {
      if (e instanceof ZipError) throw new XlsxError(e.message === "too_large" || e.message === "too_many_entries" ? "too_large" : "not_xlsx");
      throw e;
    }
    try {
      this.init();
    } catch (e) {
      throw this.wrap(e);
    }
  }

  private wrap(e: unknown): Error {
    if (e instanceof XlsxError) return e;
    if (e instanceof ZipError) return new XlsxError(e.message === "too_large" ? "too_large" : "corrupt");
    if (e instanceof XmlError) return new XlsxError(e.message === "timeout" ? "timeout" : "corrupt");
    return new XlsxError("corrupt");
  }

  private init() {
    for (const name of this.zip.entries.keys()) {
      if (FORBIDDEN_FILES.includes(name) || /vbaProject/i.test(name)) throw new XlsxError("macro");
      if (FORBIDDEN_PREFIXES.some((p) => name.startsWith(p))) throw new XlsxError("external");
    }
    const ct = this.zip.text("[Content_Types].xml", 1024 * 1024);
    if (!ct) throw new XlsxError("not_xlsx");
    if (/macroEnabled/i.test(ct)) throw new XlsxError("macro");
    let mainPath = "";
    for (const ev of xmlEvents(ct, this.limits.deadline)) {
      if (ev.kind === "open" && ev.name === "Override" && ev.attrs.ContentType === MAIN_CT) mainPath = (ev.attrs.PartName ?? "").replace(/^\//, "");
    }
    if (mainPath !== "xl/workbook.xml") throw new XlsxError("not_xlsx");
    const wb = this.zip.text("xl/workbook.xml", 4 * 1024 * 1024);
    const rels = this.zip.text("xl/_rels/workbook.xml.rels", 4 * 1024 * 1024);
    if (!wb || !rels) throw new XlsxError("corrupt");
    const targets = new Map<string, string>();
    for (const ev of xmlEvents(rels, this.limits.deadline)) {
      if (ev.kind === "open" && ev.name === "Relationship") {
        if (ev.attrs.TargetMode === "External") throw new XlsxError("external");
        const t = ev.attrs.Target ?? "";
        targets.set(ev.attrs.Id ?? "", t.startsWith("/") ? t.slice(1) : `xl/${t}`);
      }
    }
    for (const ev of xmlEvents(wb, this.limits.deadline)) {
      if (ev.kind === "open" && ev.name === "sheet") {
        const rid = ev.attrs["r:id"] ?? ev.attrs.id ?? "";
        const path = targets.get(rid);
        if (!path || !this.zip.has(path)) throw new XlsxError("corrupt");
        this.sheets.push({ name: (ev.attrs.name ?? "").slice(0, 100), hidden: (ev.attrs.state ?? "visible") !== "visible", path });
      }
    }
    if (!this.sheets.length) throw new XlsxError("no_sheet");
  }

  sheetInfo(): SheetInfo[] {
    return this.sheets.map(({ name, hidden }) => ({ name, hidden }));
  }

  /** Az alapértelmezett munkalap: az első látható. */
  defaultSheet(): number {
    const i = this.sheets.findIndex((s) => !s.hidden);
    return i >= 0 ? i : 0;
  }

  private sharedStrings(): string[] {
    if (this.shared) return this.shared;
    const out: string[] = [];
    const xml = this.zip.text("xl/sharedStrings.xml", 40 * 1024 * 1024);
    if (xml) {
      let cur: string[] | null = null;
      let inT = false, skip = 0;
      for (const ev of xmlEvents(xml, this.limits.deadline)) {
        if (ev.kind === "open") {
          if (ev.name === "si") cur = [];
          else if (ev.name === "rPh" || ev.name === "phoneticPr") { if (!ev.selfClosing) skip++; }
          else if (ev.name === "t" && !ev.selfClosing) inT = true;
        } else if (ev.kind === "close") {
          if (ev.name === "si") { out.push((cur ?? []).join("")); cur = null; }
          else if (ev.name === "rPh") skip--;
          else if (ev.name === "t") inT = false;
        } else if (inT && skip === 0 && cur) cur.push(ev.text);
      }
    }
    this.shared = out;
    return out;
  }

  /** Egy munkalap cellaértékei (szövegként), eredeti sorindexekkel; csak tartalmas sorok és az azok közötti (korlátos) üres sorhelyek. */
  read(sheetIndex: number): SheetData {
    try {
      return this.readSheet(sheetIndex);
    } catch (e) {
      throw this.wrap(e);
    }
  }

  private readSheet(sheetIndex: number): SheetData {
    const sheet = this.sheets[sheetIndex];
    if (!sheet) throw new XlsxError("no_sheet");
    const xml = this.zip.text(sheet.path, 60 * 1024 * 1024);
    if (xml === undefined) throw new XlsxError("corrupt");
    const shared = this.sharedStrings();
    const { maxRows, maxColumns, maxCellChars, deadline } = this.limits;
    const maxPhysical = this.limits.maxPhysicalRows ?? Infinity;
    const rows: string[][] = [];
    const flags: CellFlags = { formula: new Set(), error: new Set() };
    let rowIdx = -1, nextRow = 0;
    let row: string[] = [];
    let col = -1, nextCol = 0, type = "", value: string[] = [], inV = false, inIs = false, inT = false, hasFormula = false, skip = 0;
    let nonEmptyRows = 0;
    // Tartalmas sor: van nem üres, képletes vagy hibaértékű cellája. Üres (pl. csak formázott) sor nem tárolódik; a köztes üres
    // sorhelyek csak a fizikai sorkorláton belül, egy következő tartalmas sor előtt jönnek létre (ritkás munkalap nem foglal korlátlanul).
    const flush = () => {
      if (rowIdx < 0 || row.length === 0) return;
      nonEmptyRows++;
      if (nonEmptyRows > maxRows + 1) throw new XlsxError("too_many_rows");
      if (rowIdx + 1 > maxPhysical) throw new XlsxError("too_many_physical_rows");
      while (rows.length < rowIdx) rows.push([]);
      rows[rowIdx] = row;
    };
    for (const ev of xmlEvents(xml, deadline)) {
      if (ev.kind === "open") {
        switch (ev.name) {
          case "row": {
            const r = ev.attrs.r ? Number(ev.attrs.r) - 1 : nextRow;
            if (!Number.isInteger(r) || r < 0 || r < nextRow) throw new XlsxError("corrupt");
            if (r > 1_048_575) throw new XlsxError("corrupt");
            rowIdx = r; nextRow = r + 1; row = []; nextCol = 0;
            if (ev.selfClosing) { flush(); rowIdx = -1; }
            break;
          }
          case "c": {
            col = ev.attrs.r ? colIndex(ev.attrs.r) : nextCol;
            if (col < 0) throw new XlsxError("corrupt");
            nextCol = col + 1; type = ev.attrs.t ?? "n"; value = []; hasFormula = false;
            if (ev.selfClosing) col = -1;
            break;
          }
          case "f": hasFormula = true; if (!ev.selfClosing) skip++; break;
          case "v": if (!ev.selfClosing) inV = true; break;
          case "is": inIs = true; break;
          case "rPh": if (!ev.selfClosing) skip++; break;
          case "t": if (inIs && !ev.selfClosing) inT = true; break;
        }
      } else if (ev.kind === "close") {
        switch (ev.name) {
          case "row": flush(); rowIdx = -1; break;
          case "c": {
            if (col < 0 || rowIdx < 0) break;
            const raw = value.join("");
            let text = "";
            if (type === "s") {
              const i = Number(raw);
              if (!Number.isInteger(i) || i < 0 || i >= shared.length) throw new XlsxError("corrupt");
              text = shared[i];
            } else if (type === "inlineStr" || type === "str") text = raw;
            else if (type === "b") text = raw === "1" ? "IGAZ" : raw === "0" ? "HAMIS" : raw;
            else if (type === "e") text = raw;
            else text = raw === "" ? "" : numberText(raw);
            const ref = `${rowIdx}:${col}`;
            if (hasFormula) { flags.formula.add(ref); text = ""; }
            if (type === "e") { flags.error.add(ref); text = ""; }
            if (text.length > maxCellChars) throw new XlsxError("cell_too_long");
            if (text !== "" || flags.formula.has(ref) || flags.error.has(ref)) {
              if (col >= maxColumns) throw new XlsxError("too_many_columns");
              while (row.length < col) row.push("");
              row[col] = text;
            }
            col = -1;
            break;
          }
          case "f": skip--; break;
          case "v": inV = false; break;
          case "is": inIs = false; break;
          case "rPh": skip--; break;
          case "t": inT = false; break;
        }
      } else if (col >= 0 && skip === 0 && (inV || (inIs && inT))) value.push(ev.text);
    }
    return { rows, flags };
  }
}

// ------------------------------------------------------------------------- írás

export interface WriteSheet { name: string; rows: string[][]; widths?: number[]; boldHeader?: boolean }

const sheetName = (n: string) => n.replace(/[\\/?*[\]:]/g, " ").slice(0, 31) || "Munkalap";

function sheetXml(s: WriteSheet): string {
  const cols = s.widths?.length ? `<cols>${s.widths.map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`).join("")}</cols>` : "";
  const pane = s.boldHeader ? `<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>` : "";
  const body = s.rows.map((r, ri) => `<row r="${ri + 1}">${r.map((v, ci) => {
    const style = s.boldHeader && ri === 0 ? ` s="1"` : "";
    return `<c r="${colName(ci)}${ri + 1}" t="inlineStr"${style}><is><t xml:space="preserve">${escapeXml(v ?? "")}</t></is></c>`;
  }).join("")}</row>`).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">${pane}${cols}<sheetData>${body}</sheetData></worksheet>`;
}

/** Munkafüzet írása kizárólag szöveges cellákkal. Képlet nem kerülhet bele. */
export function writeXlsx(sheets: WriteSheet[], date = new Date()): Buffer {
  const names = sheets.map((s) => sheetName(s.name));
  const ct = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/xl/workbook.xml" ContentType="${MAIN_CT}"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>${names.map((_n, i) => `<Override PartName="/xl/worksheets/sheet${i + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`).join("")}<Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/></Types>`;
  const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/></Relationships>`;
  const workbook = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>${names.map((n, i) => `<sheet name="${escapeXml(n)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join("")}</sheets></workbook>`;
  const wbRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${names.map((_n, i) => `<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`).join("")}<Relationship Id="rId${names.length + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`;
  const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts><fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills><borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="2"><xf numFmtId="49" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="49" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1" applyNumberFormat="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>`;
  const core = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:creator>JG Investment OS</dc:creator><dcterms:created xsi:type="dcterms:W3CDTF">${date.toISOString().replace(/\.\d+Z$/, "Z")}</dcterms:created></cp:coreProperties>`;
  return writeZip([
    { name: "[Content_Types].xml", data: ct },
    { name: "_rels/.rels", data: rootRels },
    { name: "docProps/core.xml", data: core },
    { name: "xl/workbook.xml", data: workbook },
    { name: "xl/_rels/workbook.xml.rels", data: wbRels },
    { name: "xl/styles.xml", data: styles },
    ...sheets.map((s, i) => ({ name: `xl/worksheets/sheet${i + 1}.xml`, data: sheetXml(s) })),
  ], date);
}
