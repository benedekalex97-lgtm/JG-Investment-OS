import { createCipheriv, createDecipheriv, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { sha256, tableChecksum, type Backup } from "./backup";

/**
 * Titkosított, integritásvédett mentésfájl (v1.0, CRM-019). Formátum („JG-OS sealed backup”, `.jgbackup`):
 *
 *   "JGOSBK1\n" (8 bájt) | fejléc hossza (uint32, BE) | fejléc (UTF-8 JSON) | IV (12 bájt) | GCM tag (16 bájt) | titkosított törzs
 *
 * - Törzs: a mentés JSON-dokumentuma gzip-pel tömörítve, AES-256-GCM-mel titkosítva. A fejléc a GCM hitelesített kiegészítő adata
 *   (AAD): a fejléc bármely módosítása a visszafejtést meghiúsítja.
 * - A fejléc CSAK biztonságos metaadatot tartalmaz (időpont, környezet, sémaverzió, táblánkénti sorszám és lenyomat, a kulcs
 *   azonosítója, a forrás-adatbázis ujjlenyomata): személyes adatot nem. Kulcs nélkül is olvasható (`backup:inspect`).
 * - Integritás: GCM hitelesítés + a teljes JSON SHA-256 lenyomata + táblánkénti SHA-256 lenyomat és sorszám (visszafejtés után
 *   összevetve a tartalommal).
 * - Kulcs: 32 bájtos véletlen kulcs (base64 vagy hex), a `JG_BACKUP_KEY` / `JG_BACKUP_KEY_FILE` változóból. A kulcs SOHA nem kerül
 *   a mentésfájlba; a kulcsazonosító a kulcs egyirányú lenyomata (a kulcs nem állítható vissza belőle).
 */
export const MAGIC = Buffer.from("JGOSBK1\n", "ascii");

export interface SealedHeader {
  format: "jg-os-backup-sealed";
  version: 1;
  cipher: "aes-256-gcm";
  compression: "gzip";
  keyId: string;
  createdAt: string;
  environment: string;
  migration: string;
  counts: Record<string, number>;
  tableSha256: Record<string, string>;
  contentSha256: string;
  plaintextBytes: number;
  source: { databaseFingerprint: string };
}

export class BackupIntegrityError extends Error {}

export function parseKey(raw: string | undefined): Buffer {
  const v = (raw ?? "").trim();
  let key: Buffer | undefined;
  if (/^[0-9a-fA-F]{64}$/.test(v)) key = Buffer.from(v, "hex");
  else if (/^[A-Za-z0-9+/_-]{43}=?$/.test(v)) key = Buffer.from(v.replace(/-/g, "+").replace(/_/g, "/"), "base64");
  if (!key || key.length !== 32) throw new BackupIntegrityError("A mentési kulcs 32 bájtos véletlen érték legyen (64 hex karakter vagy base64). Generálás: npm run db -- backup:keygen <fájl>");
  return key;
}
export const generateKey = () => randomBytes(32).toString("base64");
export const keyId = (key: Buffer) => createHash("sha256").update("jg-os-backup-key-id:").update(key).digest("hex").slice(0, 16);

/** Forrás-adatbázis ujjlenyomata (hoszt + adatbázisnév egyirányú lenyomata; jelszó és felhasználó nélkül). */
export function databaseFingerprint(connection: string): string {
  try {
    const u = new URL(connection);
    return sha256(`${u.hostname.toLowerCase()}/${u.pathname.replace(/^\//, "")}`).slice(0, 16);
  } catch {
    return sha256(`local:${connection}`).slice(0, 16);
  }
}

export function sealBackup(backup: Backup, key: Buffer, source: { databaseFingerprint: string }): Buffer {
  const plain = Buffer.from(JSON.stringify(backup), "utf8");
  const header: SealedHeader = {
    format: "jg-os-backup-sealed", version: 1, cipher: "aes-256-gcm", compression: "gzip", keyId: keyId(key),
    createdAt: backup.createdAt, environment: backup.environment, migration: backup.migration, counts: backup.counts,
    tableSha256: Object.fromEntries(Object.entries(backup.tables).map(([t, rows]) => [t, tableChecksum(rows)])),
    contentSha256: sha256(plain), plaintextBytes: plain.length, source,
  };
  const head = Buffer.from(JSON.stringify(header), "utf8");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  cipher.setAAD(head);
  const body = Buffer.concat([cipher.update(gzipSync(plain)), cipher.final()]);
  const len = Buffer.alloc(4);
  len.writeUInt32BE(head.length, 0);
  return Buffer.concat([MAGIC, len, head, iv, cipher.getAuthTag(), body]);
}

export const isSealed = (buf: Buffer) => buf.length > MAGIC.length && buf.subarray(0, MAGIC.length).equals(MAGIC);

/** A fejléc olvasása kulcs nélkül (inspect). Nem hitelesít: a hitelesítés a visszafejtéskor történik. */
export function readHeader(buf: Buffer): { header: SealedHeader; head: Buffer; offset: number } {
  if (!isSealed(buf) || buf.length < MAGIC.length + 4) throw new BackupIntegrityError("A fájl nem titkosított JG-OS mentés (hibás formátum).");
  const len = buf.readUInt32BE(MAGIC.length);
  const start = MAGIC.length + 4;
  if (len > 4 * 1024 * 1024 || start + len + 28 > buf.length) throw new BackupIntegrityError("A mentésfájl sérült (hibás fejléc).");
  const head = buf.subarray(start, start + len);
  let header: SealedHeader;
  try {
    header = JSON.parse(head.toString("utf8")) as SealedHeader;
  } catch {
    throw new BackupIntegrityError("A mentésfájl sérült (hibás fejléc).");
  }
  if (header.format !== "jg-os-backup-sealed" || header.version !== 1 || header.cipher !== "aes-256-gcm") throw new BackupIntegrityError("Ismeretlen mentésformátum.");
  return { header, head, offset: start + len };
}

/**
 * Visszafejtés és teljes integritás-ellenőrzés. Bármely eltérésnél (rossz kulcs, módosított fejléc vagy törzs, csonka fájl, eltérő
 * lenyomat vagy sorszám) hibával megáll - részleges eredményt nem ad vissza.
 */
export function openBackup(buf: Buffer, key: Buffer): { backup: Backup; header: SealedHeader } {
  const { header, head, offset } = readHeader(buf);
  if (header.keyId !== keyId(key)) throw new BackupIntegrityError("A megadott kulcs nem ehhez a mentéshez tartozik (eltérő kulcsazonosító).");
  const iv = buf.subarray(offset, offset + 12);
  const tag = buf.subarray(offset + 12, offset + 28);
  const body = buf.subarray(offset + 28);
  let plain: Buffer;
  try {
    const d = createDecipheriv("aes-256-gcm", key, iv);
    d.setAAD(head);
    d.setAuthTag(tag);
    plain = gunzipSync(Buffer.concat([d.update(body), d.final()]), { maxOutputLength: Math.max(1, header.plaintextBytes) });
  } catch {
    throw new BackupIntegrityError("A mentés integritás-ellenőrzése sikertelen (sérült vagy módosított fájl, vagy hibás kulcs).");
  }
  const digest = Buffer.from(sha256(plain), "hex");
  if (plain.length !== header.plaintextBytes || !timingSafeEqual(digest, Buffer.from(header.contentSha256, "hex"))) throw new BackupIntegrityError("A mentés lenyomata nem egyezik.");
  let backup: Backup;
  try {
    backup = JSON.parse(plain.toString("utf8")) as Backup;
  } catch {
    throw new BackupIntegrityError("A mentés tartalma nem olvasható.");
  }
  verifyAgainstHeader(backup, header);
  return { backup, header };
}

export function verifyAgainstHeader(backup: Backup, header: SealedHeader): void {
  if (backup.environment !== header.environment || backup.migration !== header.migration || backup.createdAt !== header.createdAt) throw new BackupIntegrityError("A mentés fejléce és tartalma nem egyezik.");
  const tables = Object.keys(backup.tables ?? {}).sort();
  if (tables.join() !== Object.keys(header.tableSha256).sort().join()) throw new BackupIntegrityError("A mentés táblalistája nem egyezik a fejléccel.");
  for (const t of tables) {
    const rows = backup.tables[t];
    if (!Array.isArray(rows) || rows.length !== header.counts[t] || backup.counts[t] !== header.counts[t]) throw new BackupIntegrityError(`Hibás sorszám a mentésben (${t}).`);
    if (tableChecksum(rows) !== header.tableSha256[t]) throw new BackupIntegrityError(`A tábla lenyomata nem egyezik (${t}).`);
  }
}

/** Biztonságos összefoglaló (inspect): csak metaadat, személyes adat nélkül. */
export function describeHeader(h: SealedHeader, fileBytes: number): string {
  const total = Object.values(h.counts).reduce((a, b) => a + b, 0);
  return [
    `Formátum: ${h.format} v${h.version} (${h.cipher}, ${h.compression})`,
    `Létrehozva: ${h.createdAt}`,
    `Környezet: ${h.environment} · sémaverzió: ${h.migration}`,
    `Kulcsazonosító: ${h.keyId} · forrás-ujjlenyomat: ${h.source?.databaseFingerprint ?? "-"}`,
    `Tartalom SHA-256: ${h.contentSha256}`,
    `Méret: ${fileBytes} bájt (titkosítva) · ${h.plaintextBytes} bájt (visszafejtve)`,
    `Sorok összesen: ${total}`,
    ...Object.entries(h.counts).map(([t, n]) => `  ${t}: ${n}`),
  ].join("\n");
}
