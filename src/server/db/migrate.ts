import { createHash } from "node:crypto";
import type { JgEnv } from "../config";
import { migration0001 } from "./migrations/0001_init";
import { migration0002 } from "./migrations/0002_google_auth";
import { migration0003 } from "./migrations/0003_task_outcome";
import { migration0004 } from "./migrations/0004_test_customer_soft_delete";
import { migration0005 } from "./migrations/0005_crm_data_permissions";
import { migration0006 } from "./migrations/0006_crm_import_jobs";
import type { Db } from "./types";

export interface Migration {
  id: string;
  description: string;
  sql: string;
}

/** Verziózott migrációk időrendben. Új migráció csak a lista végére kerülhet; alkalmazott migráció nem módosítható (ellenőrzőösszeg). */
export const MIGRATIONS: readonly Migration[] = [migration0001, migration0002, migration0003, migration0004, migration0005, migration0006];
export const LATEST_MIGRATION = MIGRATIONS[MIGRATIONS.length - 1].id;

export const checksum = (m: Migration) => createHash("sha256").update(m.sql).digest("hex");

/**
 * Destruktív utasítások felismerése. Az alapértelmezés additív migráció; destruktív csak kifejezett jelöléssel
 * (`-- allow-destructive: <indok>`) és a végrehajtáskor külön engedéllyel (JG_ALLOW_DESTRUCTIVE_MIGRATION=<migrációs azonosító>) futhat.
 */
const DESTRUCTIVE = [
  /\bdrop\s+(table|column|schema|database|view|type|role|policy|trigger|function)\b/i,
  /\btruncate\b/i,
  /\bdelete\s+from\b/i,
  /\balter\s+table\b[^;]*\bdrop\s+column\b/i,
  /\balter\s+column\b[^;]*\btype\b/i,
  /\bdisable\s+row\s+level\s+security\b/i,
  /\bno\s+force\s+row\s+level\s+security\b/i,
];
export function lintMigration(m: Migration): { destructive: string[]; allowed: boolean } {
  const code = m.sql.replace(/--[^\n]*/g, "");
  const destructive = DESTRUCTIVE.filter((re) => re.test(code)).map((re) => re.source);
  return { destructive, allowed: /--\s*allow-destructive:\s*\S+/i.test(m.sql) };
}

export interface MigrateOptions {
  /** A környezet-címke, amelyet az adatbázis `meta.environment` értéke ellen ellenőrzünk (üres adatbázisnál rögzítjük). */
  env: JgEnv;
  /** Destruktív migráció engedélyezett azonosítója (JG_ALLOW_DESTRUCTIVE_MIGRATION). */
  allowDestructive?: string;
  migrations?: readonly Migration[];
}
export interface MigrateResult { applied: string[]; alreadyApplied: string[] }

const LOCK_KEY = 727274;

/** A migrációk futtatása: tranzakciónként, zárral, ellenőrzőösszeg-védelemmel. Soha nem töröl és nem seedel adatot. */
export async function migrate(db: Db, opts: MigrateOptions): Promise<MigrateResult> {
  const list = opts.migrations ?? MIGRATIONS;
  const applied: string[] = [];
  const already: string[] = [];
  for (const m of list) {
    const lint = lintMigration(m);
    if (lint.destructive.length && !lint.allowed) throw new Error(`A(z) ${m.id} migráció destruktív utasítást tartalmaz jóváhagyás-jelölés nélkül.`);
    if (lint.destructive.length && opts.allowDestructive !== m.id) throw new Error(`A(z) ${m.id} destruktív migráció futtatásához JG_ALLOW_DESTRUCTIVE_MIGRATION=${m.id} szükséges.`);
  }
  await db.system(async (tx) => {
    await tx.exec("create table if not exists schema_migrations (id text primary key, checksum text not null, applied_at timestamptz not null default now())");
  });
  for (const m of list) {
    await db.system(async (tx) => {
      await tx.query("select pg_advisory_xact_lock($1)", [LOCK_KEY]);
      const rows = await tx.query<{ checksum: string }>("select checksum from schema_migrations where id = $1", [m.id]);
      if (rows.length) {
        if (rows[0].checksum !== checksum(m)) throw new Error(`A(z) ${m.id} migráció már alkalmazva van, de a tartalma megváltozott. Alkalmazott migráció nem módosítható.`);
        already.push(m.id);
        return;
      }
      await tx.exec(m.sql);
      await tx.query("insert into schema_migrations (id, checksum) values ($1, $2)", [m.id, checksum(m)]);
      applied.push(m.id);
    });
  }
  await db.system(async (tx) => {
    const cur = await tx.query<{ value: string }>("select value from meta where key = 'environment'");
    if (!cur.length) await tx.query("insert into meta (key, value) values ('environment', $1)", [opts.env]);
    else if (cur[0].value !== opts.env) throw new Error(`Az adatbázis környezete (${cur[0].value}) eltér a megadott JG_ENV-től (${opts.env}). A migráció megszakítva.`);
  });
  return { applied, alreadyApplied: already };
}

export type SchemaState = { ok: true } | { ok: false; reason: "schema_missing" | "schema_outdated" | "environment_mismatch" };

/** Az alkalmazás indulási ellenőrzése: nem migrál, csak megállapítja, hogy a séma és a környezet megfelel-e. */
export async function checkSchema(db: Db, env: JgEnv): Promise<SchemaState> {
  return db.system(async (tx) => {
    const t = await tx.query<{ ok: boolean }>("select to_regclass('public.schema_migrations') is not null as ok");
    if (!t[0]?.ok) return { ok: false, reason: "schema_missing" } as const;
    const have = new Set((await tx.query<{ id: string }>("select id from schema_migrations")).map((r) => r.id));
    if (!MIGRATIONS.every((m) => have.has(m.id))) return { ok: false, reason: "schema_outdated" } as const;
    const e = await tx.query<{ value: string }>("select value from meta where key = 'environment'");
    if (!e.length || e[0].value !== env) return { ok: false, reason: "environment_mismatch" } as const;
    return { ok: true } as const;
  });
}

