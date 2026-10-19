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
 * Idempotens; adatot nem érint. Újrafuttatáskor a jelszó cserélődik (a régi azonnal érvénytelen).
 *
 * Jelszókezelés - két, EXPLICIT mód (`passwordMode`):
 *  - `scram` (alapértelmezett, általános PostgreSQL): a jelszó SCRAM-SHA-256 verifierként kerül az utasításba; a tiszta jelszó nem jut el a szerverre.
 *  - `plaintext` (Neon): a Neon vezérlőrétege kizárólag tiszta szöveges jelszót fogad el a CREATE/ALTER ROLE ... PASSWORD utasításban
 *    ("Neon only supports being given plaintext passwords"), a szerver hash-eli (SCRAM). Ez a mód a tiszta jelszót elküldi a szolgáltató
 *    adatbázis-szerverének, ezért: csak kifejezett kérésre, ellenőrzött TLS-kapcsolaton (`requireTls`: a meghajtó kliensoldalon kikényszeríti), korlátozott karakterkészlettel
 *    (nincs aposztróf és fordított perjel, így escape nélküli, egyértelmű SQL-literál), és a jelszó sehol nem naplózódik: a hibaüzenetből
 *    kiszűrjük, az eredeti hibaobjektumot nem adjuk tovább. Maradék kockázat: a jelszó a szolgáltatónál utasításnaplóba kerülhet; ezért
 *    generált, véletlen, csak erre a szerepkörre érvényes érték használandó, és szükség esetén cserélhető (újrafuttatás).
 */
export const RUNTIME_ROLE_NAME_RE = /^[a-z][a-z0-9_]{2,40}$/;

const ident = (name: string) => `"${name}"`;
/** Szabványos SQL-literál (standard_conforming_strings=on): az aposztróf duplázása; NUL nem engedett. A verifier base64/`$`/`:` karaktereket tartalmaz, aposztrófot nem. */
function literal(value: string): string {
  if (value.includes("\0")) throw new Error("Érvénytelen érték.");
  return `'${value.replace(/'/g, "''")}'`;
}

export type PasswordMode = "scram" | "plaintext";
export const PASSWORD_MODES: readonly PasswordMode[] = ["scram", "plaintext"];

export interface RuntimeRoleOptions {
  name: string;
  password: string;
  /** Jelszó-átadás módja; alapértelmezett: `scram`. A `plaintext` explicit, Neon-specifikus eltérés (lásd fent). */
  passwordMode?: PasswordMode;
  /** Ha igaz, a tiszta jelszó csak ellenőrzötten TLS-sel titkosított kapcsolaton küldhető (nem helyi adatbázisnál kötelezően beállítandó). */
  requireTls?: boolean;
}

export function validateRuntimeRole(o: RuntimeRoleOptions): void {
  if (!RUNTIME_ROLE_NAME_RE.test(o.name) || o.name === APP_ROLE || o.name.startsWith("pg_")) throw new Error("Érvénytelen szerepkör-név (kisbetű/szám/aláhúzás, 3-41 karakter, nem jg_app).");
  if (o.password.length < 24) throw new Error("A futási szerepkör jelszava legalább 24 karakter legyen (generált, véletlen érték).");
  if (!/^[\x21-\x7e]+$/.test(o.password)) throw new Error("A futási szerepkör jelszava csak látható ASCII karakterekből álljon (szóköz nélkül).");
  const mode = o.passwordMode ?? "scram";
  if (!PASSWORD_MODES.includes(mode)) throw new Error("Ismeretlen jelszó-mód (scram vagy plaintext).");
  // Tiszta szöveges módban a jelszó közvetlenül kerül az SQL-literálba: aposztróf és fordított perjel nélkül nincs escape-kérdés.
  if (mode === "plaintext" && /['\\]/.test(o.password)) throw new Error("Tiszta szöveges módban a jelszó nem tartalmazhat aposztrófot vagy fordított perjelet (generált hex/base64 érték használandó).");
}

/** Hibaüzenet-tisztítás: a jelszó (és a verifier) sehol nem maradhat a szövegben; az eredeti hibaobjektum nem adódik tovább. */
export function redactedError(e: unknown, secrets: string[]): Error {
  let msg = String((e as { message?: string })?.message ?? e).replace(/\s+/g, " ");
  for (const s of secrets) if (s) msg = msg.split(s).join("***");
  return new Error(`${msg.slice(0, 300)}${(e as { code?: string })?.code ? ` (kód: ${(e as { code?: string }).code})` : ""}`);
}

/** A jelszót tartalmazó utasítás futtatása úgy, hogy hiba esetén a jelszó ne szivároghasson a hibaüzenetbe. */
async function execRedacted(tx: Tx, sql: string, secrets: string[]): Promise<void> {
  try {
    await tx.exec(sql);
  } catch (e) {
    throw redactedError(e, secrets);
  }
}

/** A szerepkör létrehozása/frissítése, jogosultságok és az auth-táblákra szóló RLS-szabályok. A tulajdonosi (`system`) kapcsolaton fut. */
export async function provisionRuntimeRole(db: Db, o: RuntimeRoleOptions): Promise<void> {
  validateRuntimeRole(o);
  const role = ident(o.name);
  const plaintext = (o.passwordMode ?? "scram") === "plaintext";
  // Tiszta jelszó csak ellenőrzött TLS-sel mehet ki: a meghajtó kliensoldalon kötelezően titkosít (rejectUnauthorized), és TLS-t nem
  // támogató szervernél a kapcsolat hibával megáll; itt azt ellenőrizzük, hogy a használt meghajtó ezt valóban kikényszeríti.
  if (plaintext && o.requireTls && db.tls !== true) throw new Error("A tiszta szöveges jelszó csak ellenőrzött TLS-kapcsolaton küldhető; ez a kapcsolat nem kényszerít TLS-t, a művelet megszakítva.");
  await db.system(async (tx: Tx) => {
    const existing = await tx.query<Record<string, boolean>>(
      "select rolsuper, rolcreatedb, rolcreaterole, rolbypassrls, rolreplication from pg_roles where rolname = $1", [o.name],
    );
    const verifier = plaintext ? "" : scramSha256Verifier(o.password);
    const passwordSql = literal(plaintext ? o.password : verifier);
    const secrets = [o.password, verifier, passwordSql];
    if (existing.length) {
      // PostgreSQL 16+: nem szuperfelhasználó (CREATEROLE) tulajdonos meglévő szerepkörön NEM adhat meg privilegizált attribútum-opciót
      // (NOSUPERUSER/NOCREATEDB/NOBYPASSRLS stb. - a jelenlét számít, nem az érték), ezért itt csak a megengedett opciókat állítjuk,
      // a tiltott attribútumokat pedig ellenőrizzük: ha bármelyik be van kapcsolva, nem folytatjuk (kézi javítás kell, nem kerüljük meg).
      const bad = Object.entries(existing[0]).filter(([, on]) => on).map(([k]) => k.replace(/^rol/, "").toUpperCase());
      if (bad.length) throw new Error(`A(z) ${o.name} szerepkör nem megengedett attribútummal rendelkezik (${bad.join(", ")}); a futási szerepkör nem lehet privilegizált. Kézi javítás szükséges.`);
      await execRedacted(tx, `alter role ${role} with login noinherit connection limit 20 password ${passwordSql}`, secrets);
    } else {
      await execRedacted(tx, `create role ${role} with login nosuperuser nocreatedb nocreaterole noinherit nobypassrls connection limit 20 password ${passwordSql}`, secrets);
    }
    // Az alkalmazás-szerepkörre válthat (SET LOCAL ROLE), de annak jogait nem örökli alapértelmezetten.
    await tx.exec(`grant ${APP_ROLE} to ${role} with inherit false, set true`);
    await tx.exec(`revoke create on schema public from ${role}`);
    await tx.exec(`grant usage on schema public to ${role}`);
    await tx.exec(`grant select on users to ${role}`);
    await tx.exec(`grant update (last_login_at) on users to ${role}`);
    await tx.exec(`grant select, insert, update, delete on sessions to ${role}`);
    await tx.exec(`grant select, insert, delete on login_attempts to ${role}`);
    await tx.exec(`grant select, insert on oauth_identities to ${role}`);
    await tx.exec(`grant select, insert, delete on oauth_flows to ${role}`);
    await tx.exec(`grant usage, select on sequence login_attempts_id_seq to ${role}`);
    await tx.exec(`grant select on meta, schema_migrations to ${role}`);
    // A hitelesítési táblák RLS-e alapból "mindent tilt"; a futási szerepkörnek kifejezett szabály kell (csak ezekre a táblákra).
    for (const t of ["users", "sessions", "login_attempts", "meta", "oauth_identities", "oauth_flows"]) {
      const policy = ident(`rt_${o.name}`);
      await tx.exec(`drop policy if exists ${policy} on ${t}`);
      await tx.exec(`create policy ${policy} on ${t} for all to ${role} using (true) with check (true)`);
    }
  });
}

