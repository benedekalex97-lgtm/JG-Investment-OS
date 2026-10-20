import { APP_TIME_ZONE, dayKey, noonIsoOfDay } from "@/domain/time";

// v0.9: minden megjelenített dátum és idő a magyar felhasználói időzónában (Europe/Budapest), a böngésző beállításától függetlenül.
const dateFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit" });
const dateTimeFmt = new Intl.DateTimeFormat("hu-HU", { timeZone: APP_TIME_ZONE, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit" });

export const formatDate = (iso?: string) => (iso ? dateFmt.format(new Date(iso)) : "—");
export const formatDateTime = (iso?: string) => (iso ? dateTimeFmt.format(new Date(iso)) : "—");

const pad = (n: number) => String(n).padStart(2, "0");
/** ISO → `datetime-local` input érték (helyi idő). */
export function toInputValue(iso?: string): string {
  if (!iso) return "";
  const d = new Date(iso);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
/** `datetime-local` input érték → ISO (üres marad üres). */
export function fromInputValue(v: string): string {
  if (!v) return "";
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? "" : d.toISOString();
}
export const nowInputValue = () => toInputValue(new Date().toISOString());

/** ISO → `date` input érték (a budapesti nap). */
export function toDateInputValue(iso?: string): string {
  return iso ? dayKey(iso) : "";
}
/** `date` input érték → ISO (a nap déli 12:00-ja budapesti idő szerint, így sosem esik át másik napra); üres marad üres. */
export function fromDateInputValue(v: string): string {
  return noonIsoOfDay(v);
}
