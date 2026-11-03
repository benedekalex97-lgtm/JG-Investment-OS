/**
 * Szigorú, minimális XML-tokenizáló a SpreadsheetML (XLSX) olvasásához. Nem érvényesítő parser: a dokumentumot elemekre és
 * szövegre bontja. Biztonság: DOCTYPE / ENTITY deklarációt elutasít (nincs XXE, nincs entitás-bővítés), csak az öt előre definiált
 * entitást és a numerikus karakterhivatkozásokat oldja fel; ismeretlen entitás hiba. Névtér-előtagot levág (x:c -> c).
 */
export class XmlError extends Error {}

export type XmlEvent =
  | { kind: "open"; name: string; attrs: Record<string, string>; selfClosing: boolean }
  | { kind: "close"; name: string }
  | { kind: "text"; text: string };

const ENT: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: '"', apos: "'" };

export function decodeEntities(s: string): string {
  if (!s.includes("&")) return s;
  if (/&(?!(?:#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|lt|gt|amp|quot|apos);)/.test(s)) throw new XmlError("bad_entity");
  return s.replace(/&(#[0-9]{1,7}|#[xX][0-9a-fA-F]{1,6}|lt|gt|amp|quot|apos);/g, (_m, e: string) => {
    if (e[0] !== "#") return ENT[e];
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    if (!Number.isFinite(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) throw new XmlError("bad_entity");
    return String.fromCodePoint(code);
  });
}

const localName = (n: string) => {
  const i = n.indexOf(":");
  return i >= 0 ? n.slice(i + 1) : n;
};

function parseAttrs(src: string): Record<string, string> {
  const out: Record<string, string> = {};
  const re = /([^\s=/]+)\s*=\s*("([^"]*)"|'([^']*)')/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(src))) {
    const raw = m[1];
    // Az r:id típusú névtérrel minősített attribútumot teljes nevén is megtartjuk (a kapcsolat-azonosítóhoz).
    const v = decodeEntities(m[3] ?? m[4] ?? "");
    out[raw] = v;
    if (raw.includes(":") && !raw.startsWith("xmlns")) out[localName(raw)] ??= v;
  }
  return out;
}

/** Az XML eseményei sorban. A `deadline` (ms időbélyeg) túllépésekor megszakít. */
export function* xmlEvents(xml: string, deadline = Infinity): Generator<XmlEvent> {
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw new XmlError("doctype");
  const re = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/?)([^\s/>]+)([^>]*?)(\/?)>|([^<]+)/g;
  let m: RegExpExecArray | null;
  let n = 0;
  let last = 0;
  while ((m = re.exec(xml))) {
    if (m.index !== last) throw new XmlError("malformed");
    last = re.lastIndex;
    if ((++n & 0x3fff) === 0 && Date.now() > deadline) throw new XmlError("timeout");
    if (m[1] !== undefined) yield { kind: "text", text: m[1] };
    else if (m[3] !== undefined) {
      const name = localName(m[3]);
      if (m[2] === "/") yield { kind: "close", name };
      else yield { kind: "open", name, attrs: parseAttrs(m[4] ?? ""), selfClosing: m[5] === "/" };
    } else if (m[6] !== undefined) yield { kind: "text", text: decodeEntities(m[6]) };
  }
  if (last !== xml.length) throw new XmlError("malformed");
}

/** XML-szöveg biztonságos kiírása (elem tartalma és attribútum). Vezérlőkaraktereket (XML 1.0-ban tiltott) eltávolít. */
export function escapeXml(s: string): string {
  return s
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}
