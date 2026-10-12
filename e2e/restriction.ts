/**
 * E2E segédszkript (csak teszthez): egy már meglévő (fiktív) tiltakozási nyilvántartást szimulál az adatbázisban, a CRM
 * felületén kívül - ahogy a korábbi rendszerből megőrzött adat is létezne. Használat: tsx e2e/restriction.ts <pglite-könyvtár> <ügyfél-azonosító>
 */
import { createPgliteDb } from "../src/server/db/pglite-driver";

async function main() {
  const [dir, customerId] = process.argv.slice(2);
  if (!dir || !customerId) throw new Error("Használat: restriction.ts <könyvtár> <ügyfél>");
  const db = await createPgliteDb(dir);
  await db.system((tx) =>
    tx.query(
      "insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) select $1, 'objection', 'Fiktív tiltakozás (E2E)', now(), id from users order by id limit 1",
      [customerId],
    ),
  );
  await db.close();
}
main().catch((e: Error) => {
  console.error(e.message);
  process.exit(1);
});
