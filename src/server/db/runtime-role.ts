import { scramSha256Verifier } from "./scram";
import { APP_ROLE, type Db, type Tx } from "./types";

/**
 * Legkisebb jogosultságú FUTÁSI adatbázis-szerepkör (v0.6.2 javaslat, kézi, jóváhagyás utáni végrehajtásra).
 *
 * A migrációhoz és a felhasználókezeléshez a séma-tulajdonos szerepkör kell (CREATE/ALTER, szerepkör-létrehozás). A normál
 * alkalmazásfutáshoz viszont nem: a futási szerepkör
 *  - NEM tulajdonos, nem szuperfelhasználó, nem hozhat létre adatbázist/szerepkört, nincs BYPASSRLS, nincs sémamódosító joga;
 *  - a CRM-adatokhoz kizárólag a `jg_app` szerepkörön át fér hozzá (`SET LOCAL ROLE`, RLS-sel és hozzáfűző-jogokkal);
 *  - a hitelesítési táblákon csak a belépéshez/munkamenet-kezeléshez szükséges műveleteket végezheti:
 *      users: SELECT + UPDATE(last_login_at) (nincs jelszó-módosítás, nincs létrehozás, nincs törlés),
 *      sessions: SELECT/INSERT/UPDATE/DELETE, login_attempts: SELECT/INSERT/DELETE, meta és schema_migrations: SELECT.
 * A felhasználók létrehozása, jelszócsere és letiltás továbbra is a tulajdonosi kapcsolattal futó `npm run db` CLI feladata.
 * Idempotens; adatot nem érint. Újrafuttatáskor a jelszó cserélődik (a régi azonnal érvénytelen). A jelszó SCRAM-SHA-256 verifierként
 * kerül az adatbázisba (a tiszta jelszó nem jut el a szerverre, az utasításszövegbe és a naplókba), és sehol nem naplózódik.
 */
export const RUNTIME_ROLE_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

const ident = (name: string) => `"${name}"`;
/** Szabványos SQL-literál (standard_conforming_strings=on): az aposztróf duplázása; NUL nem engedett. A verifier base64/`$`/`:` karaktereket tartalmaz, aposztrófot nem. */
function literal(value: string): string {
  if (value.includes("\0")) throw new Error("Érvénytelen érték.");
  return `'${value.replace(/'/g, "''")}'`;
}

export interface RuntimeRoleOptions {
  name: string;
  password: string;
}

export function validateRuntimeRole(o: RuntimeRoleOptions): void {
  if (!RUNTIME_ROLE_NAME_RE.test(o.name) || o.name === APP_ROLE || o.name.startsWith("pg_")) throw new Error("Érvénytelen szerepkör-név (kisbetű/szám/aláhúzás, 3-41 karakter, nem jg_app).");
  if (o.password.length < 24) throw new Error("A futási szerepkör jelszava legalább 24 karakter legyen (generált, véletlen érték).");
  if (!/^[\x21-\x7e]+$/.test(o.password)) throw new Error("A futási szerepkör jelszava csak látható ASCII karakterekből álljon (szóköz nélkül).");
}

/** A szerepkör létrehozása/frissítése, jogosultságok és az auth-táblákra szóló RLS-szabályok. A tulajdonosi (`system`) kapcsolaton fut. */
export async function provisionRuntimeRole(db: Db, o: RuntimeRoleOptions): Promise<void> {
  validateRuntimeRole(o);
  const role = ident(o.name);
  await db.system(async (tx: Tx) => {
    const exists = await tx.query("select 1 from pg_roles where rolname = $1", [o.name]);
    const attrs = "login nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 20";
    const verifier = literal(scramSha256Verifier(o.password));
    if (exists.length) await tx.exec(`alter role ${role} with ${attrs} password ${verifier}`);
    else await tx.exec(`create role ${role} with ${attrs} password ${verifier}`);
    // Az alkalmazás-szerepkörre válthat (SET LOCAL ROLE), de annak jogait nem örökli alapértelmezetten.
    await tx.exec(`grant ${APP_ROLE} to ${role} with inherit false, set true`);
    await tx.exec(`revoke create on schema public from ${role}`);
    await tx.exec(`grant usage on schema public to ${role}`);
    await tx.exec(`grant select on users to ${role}`);
    await tx.exec(`grant update (last_login_at) on users to ${role}`);
    await tx.exec(`grant select, insert, update, delete on sessions to ${role}`);
    await tx.exec(`grant select, insert, delete on login_attempts to ${role}`);
    await tx.exec(`grant usage, select on sequence login_attempts_id_seq to ${role}`);
    await tx.exec(`grant select on meta, schema_migrations to ${role}`);
    // A hitelesítési táblák RLS-e alapból "mindent tilt"; a futási szerepkörnek kifejezett szabály kell (csak ezekre a táblákra).
    for (const t of ["users", "sessions", "login_attempts", "meta"]) {
      const policy = ident(`rt_${o.name}`);
      await tx.exec(`drop policy if exists ${policy} on ${t}`);
      await tx.exec(`create policy ${policy} on ${t} for all to ${role} using (true) with check (true)`);
    }
  });
}
