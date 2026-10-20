/**
 * Alkalmazás-időzóna (v0.9, CRM-010): a „ma”, a „lejárt” és a „következő 7 nap” a magyar felhasználói napot jelenti, nem a szerver vagy a
 * böngésző UTC/helyi napját. A határidő a választott nap déli 12:00-ja (Budapest), így nyári/téli időszámítás mellett sem csúszik át.
 */
export const APP_TIME_ZONE = "Europe/Budapest";

const dayFmt = new Intl.DateTimeFormat("en-CA", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const partsFmt = new Intl.DateTimeFormat("en-US", { timeZone: APP_TIME_ZONE, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" });

/** A nap kulcsa (ÉÉÉÉ-HH-NN) budapesti idő szerint. */
export function dayKey(at: Date | string | number): string {
  return dayFmt.format(new Date(at));
}

/** Napkulcs eltolása egész napokkal (naptári aritmetika, időzónától független). */
export function addDays(key: string, days: number): string {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A budapesti idő eltérése az UTC-től (perc) egy adott pillanatban. */
function offsetMinutes(t: number): number {
  const p = Object.fromEntries(partsFmt.formatToParts(new Date(t)).map((x) => [x.type, x.value]));
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return Math.round((asUtc - t) / 60000);
}

/** ÉÉÉÉ-HH-NN → az adott budapesti nap déli 12:00-ja ISO formában; érvénytelen bemenetre üres szöveg. */
export function noonIsoOfDay(key: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return "";
  const guess = Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12, 0, 0);
  if (Number.isNaN(guess)) return "";
  const iso = new Date(guess - offsetMinutes(guess) * 60000).toISOString();
  return dayKey(iso) === key ? iso : "";
}
