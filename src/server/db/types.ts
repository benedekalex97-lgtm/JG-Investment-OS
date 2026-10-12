/** Minimális SQL-futtató felület; a `pg` (éles) és a PGlite (helyi/teszt) meghajtó is ezt valósítja meg. */
export interface Tx {
  /** Paraméterezett lekérdezés ($1, $2, ...), a sorokat adja vissza. */
  query<T = Record<string, unknown>>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Paraméter nélküli, több utasításos SQL (migrációk). */
  exec(sql: string): Promise<void>;
}

/** Az alkalmazás szerepköre: a CRM-táblákhoz RLS-sel védett, korlátozott jogosultságú szerepkör (lásd 0001_init). */
export const APP_ROLE = "jg_app";

export interface Db {
  readonly kind: "pg" | "pglite";
  /** Tranzakció a kapcsolódási (tulajdonos) szerepkörrel: hitelesítési táblák, migráció. NEM adható át felhasználói kérés adatműveletéhez. */
  system<T>(fn: (tx: Tx) => Promise<T>): Promise<T>;
  /** Tranzakció korlátozott `jg_app` szerepkörrel és a hitelesített felhasználó azonosítójával: az RLS csak aktív felhasználónak enged. */
  asUser<T>(userId: string, fn: (tx: Tx) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
