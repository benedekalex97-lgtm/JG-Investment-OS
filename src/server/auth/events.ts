import type { Db } from "../db/types";

/**
 * Belépési napló (v1.5). Sikeres és sikertelen belépés, kilépés - a 0014 `auth_record_event` függvényén át (a táblát közvetlenül senki
 * nem írja). A rögzítés „legjobb szándékú”: hibája nem akadályozza a belépést vagy a kilépést (a hiba kódja személyes adat nélkül kerül a
 * szervernaplóba). IP-cím, teljes user-agent, token, Google-profiladat nem kerül a naplóba - csak a böngésző és az operációs rendszer
 * durva megnevezése.
 */
export type AuthEventKind = "login_success" | "login_failure" | "logout";
export type AuthMethod = "google" | "password";
export type AuthFailureReason = "not_allowed" | "cancelled" | "failed" | "invalid_credentials" | "rate_limited";

export interface AuthEventInput {
  event: AuthEventKind;
  method: AuthMethod;
  userId?: string | null;
  email?: string | null;
  reason?: AuthFailureReason;
  device?: string;
}

/** Durva eszköz-megnevezés a user-agentből: „Böngésző · Rendszer (mobil)”. Verziószámot, egyedi azonosítót nem tart meg. */
export function deviceOf(ua: string | null | undefined): string | undefined {
  if (!ua) return undefined;
  const os = /iPhone|iPad|iPod/.test(ua) ? "iOS"
    : /Android/.test(ua) ? "Android"
      : /Windows/.test(ua) ? "Windows"
        : /CrOS/.test(ua) ? "ChromeOS"
          : /Mac OS X|Macintosh/.test(ua) ? "macOS"
            : /Linux/.test(ua) ? "Linux" : "Ismeretlen rendszer";
  const browser = /Edg(e|A|iOS)?\//.test(ua) ? "Edge"
    : /OPR\/|Opera/.test(ua) ? "Opera"
      : /SamsungBrowser/.test(ua) ? "Samsung Internet"
        : /Firefox\/|FxiOS/.test(ua) ? "Firefox"
          : /Chrome\/|CriOS/.test(ua) ? "Chrome"
            : /Safari\//.test(ua) ? "Safari" : "Ismeretlen böngésző";
  const kind = /iPad|Tablet/.test(ua) ? " (tablet)" : /Mobi|iPhone|Android/.test(ua) ? " (mobil)" : "";
  return `${browser} · ${os}${kind}`;
}

const EMAIL_RE = /^[^\s@]{1,64}@[^\s@]{1,189}$/;
const cleanEmail = (e: string | null | undefined) => {
  const v = (e ?? "").trim().toLowerCase();
  return v && v.length <= 254 && EMAIL_RE.test(v) ? v : null;
};

export async function recordAuthEvent(db: Db, e: AuthEventInput): Promise<void> {
  try {
    await db.system((tx) => tx.query("select auth_record_event($1, $2, $3, $4, $5, $6)", [
      e.event, e.method, e.userId ?? null, cleanEmail(e.email), e.reason ?? null, e.device ?? null,
    ]));
  } catch (err) {
    const x = err as { code?: string; name?: string };
    console.error("[jg-os] auth_event:", x?.code ?? x?.name ?? "hiba");
  }
}
