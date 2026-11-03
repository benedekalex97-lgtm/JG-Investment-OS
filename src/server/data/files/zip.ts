import { deflateRawSync, inflateRawSync } from "node:zlib";

/**
 * Minimális, szigorú ZIP-olvasó és -író az XLSX-hez (v1.0). Nincs külső függőség.
 *
 * Olvasás - védelem tömörítési bomba és hibás szerkezet ellen:
 *  - csak a központi könyvtárból (central directory) dolgozik; ZIP64, titkosított, többlemezes és ismeretlen tömörítésű bejegyzést elutasít;
 *  - bejegyzésszám-korlát; minden kicsomagolás előre megadott felső határral (`maxOutputLength`, a zlib megszakítja a túllépést),
 *    a kibontott méretnek egyeznie kell a deklarálttal, és a CRC-32-nek is;
 *  - a kibontott összméret is korlátos (a hívó által megadott keret).
 * Fájlrendszerbe soha nem ír (nincs útvonal-bejárási kockázat).
 */
export class ZipError extends Error {}

export interface ZipEntry {
  name: string;
  method: number;
  crc: number;
  compressedSize: number;
  size: number;
  dataStart: number;
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export interface ZipLimits { maxEntries: number; maxEntryBytes: number; maxTotalBytes: number }
export const DEFAULT_ZIP_LIMITS: ZipLimits = { maxEntries: 500, maxEntryBytes: 60 * 1024 * 1024, maxTotalBytes: 120 * 1024 * 1024 };

export class ZipReader {
  readonly entries = new Map<string, ZipEntry>();
  private extracted = 0;

  constructor(private readonly buf: Buffer, private readonly limits: ZipLimits = DEFAULT_ZIP_LIMITS) {
    if (buf.length < 22 || buf.readUInt32LE(0) !== 0x04034b50) throw new ZipError("not_zip");
    // A központi könyvtár vége (EOCD): a fájl végén, legfeljebb 64 KiB megjegyzéssel.
    let eocd = -1;
    for (let i = buf.length - 22; i >= Math.max(0, buf.length - 22 - 0xffff); i--) {
      if (buf.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new ZipError("corrupt");
    const disk = buf.readUInt16LE(eocd + 4), cdDisk = buf.readUInt16LE(eocd + 6);
    const count = buf.readUInt16LE(eocd + 10), cdSize = buf.readUInt32LE(eocd + 12), cdOffset = buf.readUInt32LE(eocd + 16);
    if (disk !== 0 || cdDisk !== 0) throw new ZipError("unsupported");
    if (count === 0xffff || cdSize === 0xffffffff || cdOffset === 0xffffffff) throw new ZipError("unsupported");
    if (count > limits.maxEntries) throw new ZipError("too_many_entries");
    if (cdOffset + cdSize > eocd) throw new ZipError("corrupt");
    let p = cdOffset;
    for (let i = 0; i < count; i++) {
      if (p + 46 > eocd || buf.readUInt32LE(p) !== 0x02014b50) throw new ZipError("corrupt");
      const flags = buf.readUInt16LE(p + 8), method = buf.readUInt16LE(p + 10), crc = buf.readUInt32LE(p + 16);
      const compressedSize = buf.readUInt32LE(p + 20), size = buf.readUInt32LE(p + 24);
      const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
      const local = buf.readUInt32LE(p + 42);
      if (p + 46 + nameLen > eocd) throw new ZipError("corrupt");
      const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
      if (flags & 0x1) throw new ZipError("encrypted");
      if (compressedSize === 0xffffffff || size === 0xffffffff || local === 0xffffffff) throw new ZipError("unsupported");
      if (method !== 0 && method !== 8) throw new ZipError("unsupported");
      if (local + 30 > buf.length || buf.readUInt32LE(local) !== 0x04034b50) throw new ZipError("corrupt");
      const dataStart = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
      if (dataStart + compressedSize > buf.length) throw new ZipError("corrupt");
      if (this.entries.has(name)) throw new ZipError("corrupt");
      this.entries.set(name, { name, method, crc, compressedSize, size, dataStart });
      p += 46 + nameLen + extraLen + commentLen;
    }
  }

  has(name: string) {
    return this.entries.has(name);
  }

  /** Egy bejegyzés kibontása korlátozott mérettel. Hiányzó bejegyzés: undefined. */
  read(name: string, maxBytes = this.limits.maxEntryBytes): Buffer | undefined {
    const e = this.entries.get(name);
    if (!e) return undefined;
    const limit = Math.min(maxBytes, this.limits.maxEntryBytes);
    if (e.size > limit) throw new ZipError("too_large");
    if (this.extracted + e.size > this.limits.maxTotalBytes) throw new ZipError("too_large");
    const raw = this.buf.subarray(e.dataStart, e.dataStart + e.compressedSize);
    let out: Buffer;
    if (e.method === 0) out = Buffer.from(raw);
    else {
      try {
        out = inflateRawSync(raw, { maxOutputLength: Math.max(1, e.size) });
      } catch (err) {
        throw new ZipError((err as { code?: string }).code === "ERR_BUFFER_TOO_LARGE" ? "too_large" : "corrupt");
      }
    }
    if (out.length !== e.size || crc32(out) !== e.crc) throw new ZipError("corrupt");
    this.extracted += out.length;
    return out;
  }

  text(name: string, maxBytes?: number): string | undefined {
    const b = this.read(name, maxBytes);
    return b === undefined ? undefined : b.toString("utf8");
  }
}

/** ZIP írása (deflate). A `date` a bejegyzések időbélyege (determinisztikus kimenethez). */
export function writeZip(files: { name: string; data: Uint8Array | string }[], date = new Date()): Buffer {
  const dosTime = ((date.getHours() & 0x1f) << 11) | ((date.getMinutes() & 0x3f) << 5) | ((date.getSeconds() >> 1) & 0x1f);
  const dosDate = (((date.getFullYear() - 1980) & 0x7f) << 9) | (((date.getMonth() + 1) & 0xf) << 5) | (date.getDate() & 0x1f);
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const f of files) {
    const data = typeof f.data === "string" ? Buffer.from(f.data, "utf8") : Buffer.from(f.data);
    const comp = deflateRawSync(data);
    const name = Buffer.from(f.name, "utf8");
    const crc = crc32(data);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0); lh.writeUInt16LE(20, 4); lh.writeUInt16LE(0x0800, 6); lh.writeUInt16LE(8, 8);
    lh.writeUInt16LE(dosTime, 10); lh.writeUInt16LE(dosDate, 12); lh.writeUInt32LE(crc, 14); lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(data.length, 22); lh.writeUInt16LE(name.length, 26); lh.writeUInt16LE(0, 28);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0); ch.writeUInt16LE(20, 4); ch.writeUInt16LE(20, 6); ch.writeUInt16LE(0x0800, 8); ch.writeUInt16LE(8, 10);
    ch.writeUInt16LE(dosTime, 12); ch.writeUInt16LE(dosDate, 14); ch.writeUInt32LE(crc, 16); ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(data.length, 24); ch.writeUInt16LE(name.length, 28); ch.writeUInt32LE(offset, 42);
    locals.push(lh, name, comp);
    centrals.push(ch, name);
    offset += lh.length + name.length + comp.length;
  }
  const cd = Buffer.concat(centrals);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(files.length, 8); end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, cd, end]);
}
