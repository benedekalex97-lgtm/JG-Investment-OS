import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { exportBackup, restoreBackup } from "@/server/backup";
import { createPgDb } from "@/server/db/pg-driver";
import type { Db, Tx } from "@/server/db/types";
import { addPilotUsers, makeTestDb, type TestDb } from "./helpers";

/**
 * F1 (review): a mentés MINDEN táblája ugyanabból az adatbázis-pillanatképből olvasódik. Valódi PostgreSQL, két külön kapcsolat: a
 * mentés tranzakciója a `customers` és a `tasks` olvasása között determinisztikusan megvárja, hogy egy MÁSIK kapcsolat létrehozzon és
 * véglegesítsen egy új ügyfelet és hozzá egy feladatot. READ COMMITTED mellett a feladat bekerülne a mentésbe az ügyfele nélkül.
 * Csak JG_TEST_DATABASE_URL (eldobható, izolált PostgreSQL) mellett fut; fiktív adat.
 */
describe.skipIf(!process.env.JG_TEST_DATABASE_URL)("mentés: egységes pillanatkép párhuzamos írás mellett (valódi PostgreSQL)", () => {
  let src: TestDb;
  let other: Db;
  let ownerId = "";
  beforeAll(async () => {
    src = await makeTestDb("pg");
    ownerId = (await addPilotUsers(src.db)).a.id;
    other = createPgDb(src.url as string);
    await src.db.system((tx) => tx.query("insert into customers (id, type, display_name, first_name, last_name, owner_id, created_at, updated_at) values ('cust-regi', 'individual', 'Régi Rozália', 'Rozália', 'Régi', $1, now(), now())", [ownerId]));
  });
  afterAll(async () => { await other.close(); await src.cleanup(); });

  /** A mentés tranzakciójának lekérdezései; a `customers` kiolvasása UTÁN, a következő tábla előtt a másik kapcsolat commitol. */
  function interleaved(db: Db, between: () => Promise<void>, probe?: (tx: Tx) => Promise<void>): Db {
    let fired = false;
    const wrap = (tx: Tx): Tx => ({
      exec: (sql) => tx.exec(sql),
      async query<T>(sql: string, params?: unknown[]) {
        const rows = await tx.query<T>(sql, params);
        if (!fired && /^select \* from customers\b/.test(sql)) { fired = true; await between(); if (probe) await probe(tx); }
        return rows;
      },
    });
    return { ...db, system: (fn) => db.system((tx) => fn(wrap(tx))) };
  }

  it("a mentés közben véglegesített ügyfél + feladat egyik része sem kerül a mentésbe; a mentés visszaállítható", async () => {
    let committed = false;
    const backup = await exportBackup(interleaved(src.db, async () => {
      await other.system(async (tx) => {
        await tx.query("insert into customers (id, type, display_name, first_name, last_name, owner_id, created_at, updated_at) values ('cust-kozben', 'individual', 'Közbeni Kornél', 'Kornél', 'Közbeni', $1, now(), now())", [ownerId]);
        await tx.query("insert into tasks (id, customer_id, title, assignee_id, status, created_at) values ('task-kozben', 'cust-kozben', 'Telefonhívás', $1, 'open', now())", [ownerId]);
      });
      committed = true;
    }), "local");
    expect(committed).toBe(true);
    // A párhuzamos tranzakció valóban véglegesítődött a forrásban.
    const live = await src.db.system((tx) => tx.query<{ n: string }>("select (select count(*) from customers where id = 'cust-kozben') + (select count(*) from tasks where id = 'task-kozben') as n"));
    expect(Number(live[0].n)).toBe(2);
    // A mentésben a pillanatkép állapota: a régi ügyfél igen, a közben létrejött ügyfél és feladat nem.
    const customerIds = new Set(backup.tables.customers.map((c) => c.id));
    expect([...customerIds]).toEqual(["cust-regi"]);
    expect(backup.tables.tasks.map((t) => t.id)).toEqual([]);
    for (const t of backup.tables.tasks) expect(customerIds.has(t.customer_id)).toBe(true);
    // Külön, üres adatbázisba visszaállítva a kapcsolatok és a tartalom ép.
    const dst = await makeTestDb("pg");
    try {
      const counts = await restoreBackup(dst.db, JSON.parse(JSON.stringify(backup)), "local");
      expect(counts).toMatchObject({ customers: 1, tasks: 0, users: 2 });
      const again = JSON.parse(JSON.stringify(await exportBackup(dst.db, "local")));
      expect(again.tables).toEqual(JSON.parse(JSON.stringify(backup.tables)));
    } finally { await dst.cleanup(); }
  });

  it("a mentés tranzakciója REPEATABLE READ és READ ONLY; az általános driver-tranzakciók izolációja változatlan", async () => {
    const setting = (tx: Tx) => tx.query<{ iso: string; ro: string }>("select current_setting('transaction_isolation') as iso, current_setting('transaction_read_only') as ro");
    expect((await src.db.system(setting))[0]).toEqual({ iso: "read committed", ro: "off" });
    let inside: { iso: string; ro: string } | null = null;
    await exportBackup(interleaved(src.db, async () => undefined, async (tx) => { inside = (await setting(tx))[0]; }), "local");
    expect(inside).toEqual({ iso: "repeatable read", ro: "on" });
  });
});
