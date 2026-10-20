/**
 * Szerveroldali funkciókapcsolók (v0.9). Csak környezeti változóból, alapértelmezetten kikapcsolva; a kliens csak az eredményt látja
 * (a `/api/auth/me` válaszban), a döntés mindig a szerveren születik.
 */
export interface Features {
  /** CRM-006: tesztfázisban létrehozott ügyfél logikai eltávolítása. `JG_TEST_CUSTOMER_DELETE_ENABLED=true` kapcsolja be. */
  testCustomerDelete: boolean;
  /**
   * CRM-014: az ügyféladat-import VÉGLEGESÍTÉSE (tartós mentés). `JG_CUSTOMER_IMPORT_ENABLED=true` kapcsolja be; alapértelmezetten
   * kikapcsolt, mert a forrásadatbázisok adatkezelési (jogalap-) ellenőrzése üzleti/adatvédelmi döntés, amelyet a bekapcsolás előtt
   * dokumentálni kell. Kikapcsolt állapotban az előnézet (validáció, duplikáció-ellenőrzés) működik, de adat nem kerül mentésre.
   */
  customerImport: boolean;
}

export function features(env: Record<string, string | undefined> = process.env): Features {
  return {
    testCustomerDelete: env.JG_TEST_CUSTOMER_DELETE_ENABLED?.trim().toLowerCase() === "true",
    customerImport: env.JG_CUSTOMER_IMPORT_ENABLED?.trim().toLowerCase() === "true",
  };
}

/** A törlés megerősítő szava (a felületen be kell gépelni, a szerver is ellenőrzi). */
export const DELETE_CONFIRMATION_WORD = "TÖRLÉS";
