/**
 * Adatkezelési (import/export) kliens-hívások (v1.0). A fájl csak a böngésző memóriájában él a varázsló idejére: nincs localStorage,
 * sessionStorage vagy IndexedDB. Minden jogosultságot a szerver ellenőriz; a kliens csak megjeleníti az eredményt.
 */
export const DATA_MESSAGES = {
  network: "Nincs kapcsolat a szerverrel. Próbáld újra.",
  server: "A művelet nem sikerült. Próbáld újra, vagy fordulj a rendszerüzemeltetőhöz.",
  forbidden: "Ehhez a művelethez nincs jogosultságod.",
  session: "A munkamenet lejárt, jelentkezz be újra.",
  exportFailed: "Az exportálás nem sikerült. Próbáld újra, vagy fordulj a rendszerüzemeltetőhöz.",
} as const;

export type ApiResult<T> = { ok: true; value: T } | { ok: false; status: number; message: string };

async function parse<T>(res: Response): Promise<ApiResult<T>> {
  let body: Record<string, unknown> = {};
  try {
    body = (await res.json()) as Record<string, unknown>;
  } catch {
    /* nem JSON */
  }
  if (res.ok) return { ok: true, value: body as T };
  const fallback = res.status === 401 ? DATA_MESSAGES.session : res.status === 403 ? DATA_MESSAGES.forbidden : DATA_MESSAGES.server;
  return { ok: false, status: res.status, message: typeof body.message === "string" ? body.message : fallback };
}

export async function upload<T>(path: string, file: File, meta: unknown): Promise<ApiResult<T>> {
  const form = new FormData();
  form.set("file", file, "import");
  form.set("meta", JSON.stringify(meta));
  try {
    return await parse<T>(await fetch(path, { method: "POST", body: form, credentials: "same-origin", cache: "no-store" }));
  } catch {
    return { ok: false, status: 0, message: DATA_MESSAGES.network };
  }
}

export async function postJson<T>(path: string, body: unknown): Promise<ApiResult<T>> {
  try {
    return await parse<T>(await fetch(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", cache: "no-store" }));
  } catch {
    return { ok: false, status: 0, message: DATA_MESSAGES.network };
  }
}

export async function getJson<T>(path: string): Promise<ApiResult<T>> {
  try {
    return await parse<T>(await fetch(path, { credentials: "same-origin", cache: "no-store" }));
  } catch {
    return { ok: false, status: 0, message: DATA_MESSAGES.network };
  }
}

/** A böngésző letölti a kapott fájlt (blob), az URL-ben nincs adat; az objektum-URL azonnal felszabadul. */
export function saveBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const filenameOf = (res: Response, fallback: string) => /filename="([^"]+)"/.exec(res.headers.get("content-disposition") ?? "")?.[1] ?? fallback;

/** Fájl letöltése a szerverről (GET vagy JSON-törzsű POST). */
export async function download(path: string, body?: unknown): Promise<ApiResult<{ filename: string; count: number | null }>> {
  let res: Response;
  try {
    res = await fetch(path, body === undefined
      ? { credentials: "same-origin", cache: "no-store" }
      : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body), credentials: "same-origin", cache: "no-store" });
  } catch {
    return { ok: false, status: 0, message: DATA_MESSAGES.network };
  }
  if (!res.ok) return (await parse(res)) as ApiResult<never>;
  const filename = filenameOf(res, "letoltes");
  saveBlob(await res.blob(), filename);
  const count = res.headers.get("x-jg-export-count");
  return { ok: true, value: { filename, count: count === null ? null : Number(count) } };
}

/** CSV-hibajegyzék (sor, állapot, mező, üzenet) - cellaértékek (személyes adat) nélkül; képletinjekció ellen védve. */
export function errorReportCsv(rows: { rowNo: number; state: string; issues: { level: string; field?: string; message: string }[] }[], stateLabel: (s: string) => string, fieldLabel: (f?: string) => string): Blob {
  const safe = (v: string) => (/^[=+\-@\t\r\n]/.test(v) ? `'${v}` : v);
  const q = (v: string) => (/[;"\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
  const lines = [["Sor", "Állapot", "Szint", "Mező", "Üzenet"]];
  for (const r of rows) for (const i of r.issues) lines.push([String(r.rowNo), stateLabel(r.state), i.level === "error" ? "Hiba" : "Figyelmeztetés", fieldLabel(i.field), i.message]);
  return new Blob(["﻿" + lines.map((l) => l.map((v) => q(safe(v))).join(";")).join("\r\n") + "\r\n"], { type: "text/csv;charset=utf-8" });
}
