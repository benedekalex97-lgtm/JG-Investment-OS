import type { JgEnv } from "../config";
import { assertDbEnvironment } from "../db/environment";
import type { Db, Tx } from "../db/types";
import { opsLog } from "../ops-log";
import { validateOperator } from "../data/permissions";
import type { RetentionSettings } from "./privacy";

/**
 * Üzemeltetői adatvédelmi műveletek (v1.3) - kizárólag a tulajdonosi kapcsolattal futó CLI-ből (`npm run db -- retention:* | privacy:*`).
 *
 * Technikai megőrzés (GDPR 5. cikk (1) c) és e)): a rövid életű, személyes adatnak minősülő technikai rekordok (lejárt munkamenetek,
 * befejezetlen Google-belépési folyamatok, belépési kísérletek, a régi idempotencia-napló tárolt válaszai) a céljuk megszűnése után
 * törlődnek. Üzleti adatot (ügyfél, feladat, Output, előzmény, auditnapló, importnapló, változásnapló, érintetti nyilvántartás) NEM
 * töröl - azok sorsáról a felülvizsgálat (Beállítások › Adatvédelem › Megőrzés) és az érintetti kérelmek alapján ember dönt.
 */
export interface TechnicalRetentionCounts { sessions: number; oauthFlows: number; loginAttempts: number; requestLog: number; authEvents: number }

const CATEGORIES: { key: keyof TechnicalRetentionCounts; table: string; where: (s: RetentionSettings) => string }[] = [
  // Lejárt vagy 1 napnál régebben inaktív munkamenet (a tétlenségi lejárat 8 óra - ezek már nem használhatók).
  { key: "sessions", table: "sessions", where: () => "expires_at < now() or last_seen_at < now() - interval '1 day'" },
  { key: "oauthFlows", table: "oauth_flows", where: () => "expires_at < now() - interval '1 hour'" },
  { key: "loginAttempts", table: "login_attempts", where: () => "at < now() - interval '1 day'" },
  { key: "requestLog", table: "request_log", where: (s) => `created_at < now() - interval '${Math.trunc(s.requestLogDays)} days'` },
  // v1.5: a belépési napló 12 hónapig őrződik (biztonsági célú elszámoltathatóság), utána törlődik.
  { key: "authEvents", table: "auth_events", where: () => "at < now() - interval '12 months'" },
];

async function count(tx: Tx, settings: RetentionSettings): Promise<TechnicalRetentionCounts> {
  const out = {} as TechnicalRetentionCounts;
  for (const c of CATEGORIES) {
    const [r] = await tx.query<{ n: string }>(`select count(*) as n from ${c.table} where ${c.where(settings)}`);
    out[c.key] = Number(r.n);
  }
  return out;
}

/** Előnézet (írás nélkül) vagy - `apply` esetén - a lejárt technikai rekordok törlése egy tranzakcióban, üzemeltetői naplóval. */
export async function technicalRetention(db: Db, opts: { env: JgEnv; settings: RetentionSettings; apply: boolean; operator?: string }): Promise<{ applied: boolean; counts: TechnicalRetentionCounts }> {
  const operator = opts.apply ? validateOperator(opts.operator) : undefined;
  return db.system(async (tx) => {
    await assertDbEnvironment(tx, opts.env);
    const counts = await count(tx, opts.settings);
    if (!opts.apply) return { applied: false, counts };
    for (const c of CATEGORIES) await tx.query(`delete from ${c.table} where ${c.where(opts.settings)}`);
    await opsLog(tx, { operation: "retention.technical", environment: opts.env, operator: operator!, detail: { ...counts, requestLogDays: opts.settings.requestLogDays } });
    return { applied: true, counts };
  });
}

/**
 * Törlési napló (ledger): az anonimizált ügyfelek azonosítói (személyes adat nélkül). Egy régebbi mentés visszaállítása után a
 * `privacy:reapply` ezzel ismétli meg az anonimizálást, hogy a mentésben még meglévő, de időközben törölt adat ne éledjen fel.
 */
export async function erasureLedger(db: Db, env: JgEnv): Promise<{ format: "jg-os-erasure-ledger"; version: 1; environment: JgEnv; createdAt: string; customerIds: string[] }> {
  return db.system(async (tx) => {
    await assertDbEnvironment(tx, env);
    const rows = await tx.query<{ id: string }>("select id from customers where erased_at is not null order by erased_at, id");
    return { format: "jg-os-erasure-ledger", version: 1, environment: env, createdAt: new Date().toISOString(), customerIds: rows.map((r) => r.id) };
  });
}

const ID_RE = /^[A-Za-z0-9_-]{1,120}$/;

/** A ledger szerinti anonimizálás megismétlése (idempotens: a már anonimizált vagy hiányzó ügyfelet kihagyja). Egy tranzakció. */
export async function reapplyErasures(db: Db, opts: { env: JgEnv; customerIds: string[]; operatorEmail: string; operator: string }): Promise<{ erased: string[]; alreadyErased: number; missing: number }> {
  const operator = validateOperator(opts.operator);
  if (!opts.customerIds.every((id) => typeof id === "string" && ID_RE.test(id))) throw new Error("A törlési napló érvénytelen azonosítót tartalmaz.");
  return db.system(async (tx) => {
    await assertDbEnvironment(tx, opts.env);
    const op = await tx.query<{ id: string }>("select id from users where email = $1 and active", [opts.operatorEmail.trim().toLowerCase()]);
    if (!op.length) throw new Error("Az üzemeltető e-mail-címe nem aktív CRM-felhasználóé.");
    const erased: string[] = [];
    let alreadyErased = 0;
    let missing = 0;
    for (const id of opts.customerIds) {
      const [c] = await tx.query<{ erased_at: unknown }>("select erased_at from customers where id = $1", [id]);
      if (!c) { missing++; continue; }
      if (c.erased_at !== null) { alreadyErased++; continue; }
      await tx.query("select privacy_anonymize_customer($1, $2)", [id, op[0].id]);
      await tx.query("insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail) values ($1, 'privacy.erase_reapplied', 'customer', $2, $2, $3::jsonb)", [op[0].id, id, JSON.stringify({ via: "cli" })]);
      erased.push(id);
    }
    await opsLog(tx, { operation: "privacy.reapply", environment: opts.env, operator, detail: { erased: erased.length, alreadyErased, missing } });
    return { erased, alreadyErased, missing };
  });
}
