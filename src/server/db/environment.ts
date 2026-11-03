import { JG_ENVS, type JgEnv } from "../config";
import type { Tx } from "./types";

/**
 * Az adatbázis saját környezetjelölésének (meta.environment, a migráció rögzíti) kötelező ellenőrzése érzékeny üzemeltetői műveletek
 * (jogosultság-módosítás, mentés, visszaállítás) SAJÁT tranzakciójában, minden módosítás és adatolvasás előtt. Fail-closed: hiányzó,
 * érvénytelen vagy a kérttől eltérő jelölésnél a művelet megáll. A jelölést soha nem írja át (a JG_PRODUCTION_DB_HOSTS lista ezt nem
 * helyettesíti).
 */
export class EnvironmentMismatchError extends Error {}

export async function assertDbEnvironment(tx: Tx, expected: JgEnv): Promise<void> {
  if (!JG_ENVS.includes(expected)) throw new EnvironmentMismatchError("Érvénytelen kért környezet. A művelet megszakítva.");
  const rows = await tx.query<{ value: string }>("select value from meta where key = 'environment'");
  const actual = rows[0]?.value;
  if (rows.length !== 1 || !JG_ENVS.includes(actual as JgEnv)) {
    throw new EnvironmentMismatchError("Az adatbázis környezetjelölése hiányzik vagy érvénytelen (meta.environment). A művelet megszakítva.");
  }
  if (actual !== expected) throw new EnvironmentMismatchError(`Az adatbázis környezete (${actual}) eltér a kért környezettől (${expected}). A művelet megszakítva.`);
}
