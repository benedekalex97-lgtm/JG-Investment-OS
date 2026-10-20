import { grantPermission, type CrmPermission } from "@/server/data/permissions";
import type { Db } from "@/server/db/types";
import type { Client } from "./helpers";

/** v1.0 adatkezelési teszt-segédek: jogosultság kiosztása (üzemeltetői úton) és multipart feltöltés. Kizárólag fiktív adat. */
export const OPERATOR = "Teszt Üzemeltető";

export async function grant(db: Db, email: string, ...permissions: CrmPermission[]) {
  for (const permission of permissions) await grantPermission(db, { email, permission, operator: OPERATOR, env: "local" });
}

const ORIGIN = "http://localhost:3000";

export interface Uploader {
  upload(path: string, file: Buffer | string, meta: unknown, headers?: Record<string, string>): Promise<{ status: number; body: Record<string, unknown> & { message?: string; error?: string } }>;
  postJson(path: string, body: unknown): Promise<Response>;
}

export function uploader(handle: (r: Request) => Promise<Response>, c: Client): Uploader {
  return {
    async upload(path, file, meta, headers = {}) {
      const form = new FormData();
      form.set("file", new Blob([typeof file === "string" ? Buffer.from(file, "utf8") : new Uint8Array(file)]), "import.bin");
      form.set("meta", JSON.stringify(meta));
      const res = await handle(new Request(`${ORIGIN}${path}`, { method: "POST", headers: { origin: ORIGIN, ...(c.cookie ? { cookie: c.cookie } : {}), ...headers }, body: form }));
      const text = await res.text();
      let body: Record<string, unknown> = {};
      try { body = JSON.parse(text); } catch { /* nem JSON */ }
      return { status: res.status, body };
    },
    postJson: (path, body) => c.post(path, body),
  };
}

/** CSV (pontosvesszős, UTF-8) fiktív sorokból. */
export const csv = (rows: string[][]) => rows.map((r) => r.map((v) => (/[;"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)).join(";")).join("\r\n") + "\r\n";

export const baseOptions = (mapping: (string | null)[], extra: Record<string, unknown> = {}) => ({
  fileType: "csv", mapping, defaultType: null, sourceName: "Fiktív teszt-adatbázis", purpose: "Integrációs teszt", sourceVerification: "verified", complianceDeclared: true, ...extra,
});
