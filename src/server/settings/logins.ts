import { z } from "zod";
import type { Tx } from "../db/types";

/**
 * Belépési napló olvasása (v1.5) - csak `crm.settings.audit.read` joggal: a jogot a hívó friss jogellenőrzése ÉS az `auth_events` RLS-e
 * is megköveteli. A felhasználó neve a mostani névjegyzékből, az e-mail a belépés idejéből (a naplóban tárolt értékből) jön.
 */
export interface LoginEntry {
  id: number;
  at: string;
  event: "login_success" | "login_failure" | "logout";
  method: "google" | "password";
  userId: string | null;
  userName: string | null;
  email: string | null;
  reason: string | null;
  device: string | null;
}

export const loginsQuery = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  event: z.enum(["login_success", "login_failure", "logout"]).optional(),
  userId: z.string().trim().regex(/^[A-Za-z0-9_-]{1,80}$/).optional(),
}).strict();

const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : new Date(String(v)).toISOString());

export async function listLogins(tx: Tx, q: z.infer<typeof loginsQuery>, users: { id: string; name: string }[]): Promise<{ entries: LoginEntry[]; nextBefore: number | null }> {
  const params: unknown[] = [q.limit + 1];
  const conds: string[] = [];
  const add = (sql: string, value: unknown) => { params.push(value); conds.push(sql.replace("?", `$${params.length}`)); };
  if (q.before) add("id < ?", q.before);
  if (q.event) add("event = ?", q.event);
  if (q.userId) add("user_id = ?", q.userId);
  const where = conds.length ? ` where ${conds.join(" and ")}` : "";
  const rows = await tx.query<Record<string, unknown>>(
    `select id, at, event, method, user_id, email, reason, device from auth_events${where} order by id desc limit $1`, params,
  );
  const nameOf = new Map(users.map((u) => [u.id, u.name]));
  const page = rows.slice(0, q.limit);
  return {
    entries: page.map((r) => {
      const userId = (r.user_id as string | null) ?? null;
      return {
        id: Number(r.id), at: iso(r.at), event: r.event as LoginEntry["event"], method: r.method as LoginEntry["method"],
        userId, userName: userId ? (nameOf.get(userId) ?? null) : null, email: (r.email as string | null) ?? null,
        reason: (r.reason as string | null) ?? null, device: (r.device as string | null) ?? null,
      };
    }),
    nextBefore: rows.length > q.limit ? Number(page[page.length - 1].id) : null,
  };
}
