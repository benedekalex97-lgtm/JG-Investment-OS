import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { Db } from "../db/types";
import { authMode } from "./mode";
import { dummyHash, hashPassword, passwordPolicyError, verifyPassword } from "./password";

export interface AuthUser {
  id: string;
  name: string;
  email: string;
}

/** Munkamenet: 7 nap abszolút, 8 óra tétlenségi lejárat. A süti HttpOnly, SameSite=Lax; HTTPS-en `__Host-` előtaggal és Secure jelzéssel. */
const ABSOLUTE_MS = 7 * 24 * 3600_000;
const IDLE_MS = 8 * 3600_000;
const TOUCH_MS = 5 * 60_000;
const EMAIL_LIMIT = 5;
const IP_LIMIT = 30;
const WINDOW_MS = 15 * 60_000;

const sha = (s: string) => createHash("sha256").update(s).digest("hex");
export const isSecure = (req: Request) => new URL(req.url).protocol === "https:" || req.headers.get("x-forwarded-proto") === "https";
export const cookieName = (secure: boolean) => (secure ? "__Host-jg_session" : "jg_session");

function readCookie(req: Request, name: string): string | undefined {
  for (const part of (req.headers.get("cookie") ?? "").split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return decodeURIComponent(part.slice(i + 1).trim());
  }
  return undefined;
}
export const sessionCookie = (token: string, secure: boolean) =>
  `${cookieName(secure)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${ABSOLUTE_MS / 1000}${secure ? "; Secure" : ""}`;
export const clearCookie = (secure: boolean) => `${cookieName(secure)}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${secure ? "; Secure" : ""}`;

export const normalizeEmail = (e: string) => e.trim().toLowerCase();
export const clientIp = (req: Request) => (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "unknown";

export type LoginResult =
  | { ok: true; token: string; user: AuthUser }
  | { ok: false; status: 401 | 429 };

export async function login(db: Db, emailRaw: string, password: string, ip: string): Promise<LoginResult> {
  const email = normalizeEmail(emailRaw);
  const keys = [`email:${sha(email)}`, `ip:${ip}`];
  const blocked = await db.system(async (tx) => {
    await tx.query("delete from login_attempts where at < now() - interval '1 day'");
    const [e] = await tx.query<{ n: string }>("select count(*) as n from login_attempts where key = $1 and success = false and at > now() - ($2 || ' milliseconds')::interval", [keys[0], String(WINDOW_MS)]);
    const [i] = await tx.query<{ n: string }>("select count(*) as n from login_attempts where key = $1 and success = false and at > now() - ($2 || ' milliseconds')::interval", [keys[1], String(WINDOW_MS)]);
    return Number(e.n) >= EMAIL_LIMIT || Number(i.n) >= IP_LIMIT;
  });
  if (blocked) return { ok: false, status: 429 };

  const found = await db.system((tx) => tx.query<{ id: string; name: string; email: string; password_hash: string }>("select id, name, email, password_hash from users where email = $1 and active", [email]));
  const user = found[0];
  const valid = await verifyPassword(password, user?.password_hash ?? (await dummyHash()));
  const success = Boolean(user) && valid;
  const token = success ? randomBytes(32).toString("base64url") : "";
  await db.system(async (tx) => {
    for (const k of keys) await tx.query("insert into login_attempts (key, success) values ($1, $2)", [k, success]);
    if (success) {
      await tx.query("insert into sessions (token_hash, user_id, expires_at) values ($1, $2, now() + ($3 || ' milliseconds')::interval)", [sha(token), user.id, String(ABSOLUTE_MS)]);
      await tx.query("update users set last_login_at = now() where id = $1", [user.id]);
    }
  });
  return success ? { ok: true, token, user: { id: user.id, name: user.name, email: user.email } } : { ok: false, status: 401 };
}

export async function userFromRequest(db: Db, req: Request): Promise<AuthUser | null> {
  const token = readCookie(req, cookieName(isSecure(req)));
  if (!token || token.length > 200) return null;
  const hash = sha(token);
  return db.system(async (tx) => {
    const rows = await tx.query<{ id: string; name: string; email: string; last_seen_at: Date }>(
      `select u.id, u.name, u.email, s.last_seen_at from sessions s join users u on u.id = s.user_id
       where s.token_hash = $1 and u.active and s.expires_at > now() and s.last_seen_at > now() - ($2 || ' milliseconds')::interval and ($3::text is null or s.auth_method = $3)`,
      [hash, String(IDLE_MS), authMode() === "google" ? "google" : null],
    );
    const u = rows[0];
    if (!u) return null;
    if (Date.now() - new Date(u.last_seen_at).getTime() > TOUCH_MS) await tx.query("update sessions set last_seen_at = now() where token_hash = $1", [hash]);
    return { id: u.id, name: u.name, email: u.email };
  });
}

export async function logout(db: Db, req: Request): Promise<void> {
  const token = readCookie(req, cookieName(isSecure(req)));
  if (token) await db.system((tx) => tx.query("delete from sessions where token_hash = $1", [sha(token)]));
}

/** Pilot-felhasználó létrehozása (parancssori szkript); a jelszó csak a hash formájában kerül az adatbázisba. */
export async function createUser(db: Db, input: { email: string; name: string; password: string }): Promise<AuthUser> {
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("Érvénytelen e-mail-cím.");
  if (!input.name.trim()) throw new Error("A név kötelező.");
  const policy = passwordPolicyError(input.password);
  if (policy) throw new Error(policy);
  const id = `u-${randomUUID().slice(0, 8)}`;
  const password_hash = await hashPassword(input.password);
  await db.system((tx) => tx.query("insert into users (id, email, name, password_hash) values ($1, $2, $3, $4)", [id, email, input.name.trim(), password_hash]));
  return { id, name: input.name.trim(), email };
}

export async function setPassword(db: Db, emailRaw: string, password: string): Promise<void> {
  const policy = passwordPolicyError(password);
  if (policy) throw new Error(policy);
  const hash = await hashPassword(password);
  const n = await db.system(async (tx) => {
    const r = await tx.query<{ id: string }>("update users set password_hash = $2 where email = $1 returning id", [normalizeEmail(emailRaw), hash]);
    if (r.length) await tx.query("delete from sessions where user_id = $1", [r[0].id]);
    return r.length;
  });
  if (!n) throw new Error("Nincs ilyen felhasználó.");
}

export async function setActive(db: Db, emailRaw: string, active: boolean): Promise<void> {
  const n = await db.system(async (tx) => {
    const r = await tx.query<{ id: string }>("update users set active = $2 where email = $1 returning id", [normalizeEmail(emailRaw), active]);
    if (r.length && !active) await tx.query("delete from sessions where user_id = $1", [r[0].id]);
    return r.length;
  });
  if (!n) throw new Error("Nincs ilyen felhasználó.");
}

export async function listUsers(db: Db): Promise<{ id: string; name: string }[]> {
  return db.system((tx) => tx.query<{ id: string; name: string }>("select id, name from users order by name"));
}


/** Google logins keep the existing server-side session model and customer ownership IDs. */
export async function createGoogleSession(db: Db, userId: string): Promise<{ token: string; user: AuthUser } | null> {
  return db.system(async (tx) => {
    const users = await tx.query<AuthUser>("select id, name, email from users where id = $1 and active for update", [userId]);
    if (!users[0]) return null;
    const token = randomBytes(32).toString("base64url");
    await tx.query("insert into sessions (token_hash,user_id,expires_at,auth_method) values ($1,$2,now() + ($3 || ' milliseconds')::interval,'google')", [sha(token), userId, String(ABSOLUTE_MS)]);
    await tx.query("update users set last_login_at = now() where id = $1", [userId]);
    return { token, user: users[0] };
  });
}
