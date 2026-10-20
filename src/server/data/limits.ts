/**
 * Konfigurálható, konzervatív import/export korlátok (v1.0). Csak szerveroldali környezeti változóból; minden érték felülről is korlátos.
 *
 * A fájlméret alapértéke 4 MB (nem 10 MB): a Vercel szerver nélküli függvényei legfeljebb 4,5 MB-os kéréstörzset fogadnak, a feltöltés
 * pedig a szerveren dolgozódik fel. Nagyobb határ csak más futtatókörnyezetben, dokumentáltan állítható (felső korlát: 10 MB).
 */
export interface DataLimits {
  maxFileBytes: number;
  maxRows: number;
  maxColumns: number;
  maxCellChars: number;
  maxSeconds: number;
  /** Előnézet (fájlfeldolgozás) óránként, felhasználónként. */
  previewsPerHour: number;
  /** Export óránként, felhasználónként. */
  exportsPerHour: number;
  /** Az előnézet ennyi percig véglegesíthető. */
  previewTtlMinutes: number;
}

const int = (v: string | undefined, def: number, min: number, max: number) => {
  const n = Number.parseInt(v ?? "", 10);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : def;
};

export function dataLimits(env: Record<string, string | undefined> = process.env): DataLimits {
  return {
    maxFileBytes: int(env.JG_IMPORT_MAX_FILE_BYTES, 4_000_000, 1_000, 10_000_000),
    maxRows: int(env.JG_IMPORT_MAX_ROWS, 5000, 1, 20_000),
    maxColumns: int(env.JG_IMPORT_MAX_COLUMNS, 50, 1, 200),
    maxCellChars: int(env.JG_IMPORT_MAX_CELL_CHARS, 2000, 100, 32_767),
    maxSeconds: int(env.JG_IMPORT_MAX_SECONDS, 20, 1, 120),
    previewsPerHour: int(env.JG_IMPORT_PREVIEWS_PER_HOUR, 30, 1, 1000),
    exportsPerHour: int(env.JG_EXPORT_PER_HOUR, 30, 1, 1000),
    previewTtlMinutes: int(env.JG_IMPORT_PREVIEW_TTL_MINUTES, 120, 5, 24 * 60),
  };
}
