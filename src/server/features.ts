/**
 * Szerveroldali funkciókapcsolók (v0.9). Csak környezeti változóból, alapértelmezetten kikapcsolva; a kliens csak az eredményt látja
 * (a `/api/auth/me` válaszban), a döntés mindig a szerveren születik.
 */
export interface Features {
  /**
   * CRM-014: az ügyféladat-import VÉGLEGESÍTÉSE (tartós mentés). `JG_CUSTOMER_IMPORT_ENABLED=true` kapcsolja be; alapértelmezetten
   * kikapcsolt, mert a forrásadatbázisok adatkezelési (jogalap-) ellenőrzése üzleti/adatvédelmi döntés, amelyet a bekapcsolás előtt
   * dokumentálni kell. Kikapcsolt állapotban az előnézet (validáció, duplikáció-ellenőrzés) működik, de adat nem kerül mentésre.
   */
  customerImport: boolean;
}

export function features(env: Record<string, string | undefined> = process.env): Features {
  return {
    customerImport: env.JG_CUSTOMER_IMPORT_ENABLED?.trim().toLowerCase() === "true",
  };
}

/**
 * Az ügyféltörlés megerősítő szava (a felületen be kell gépelni, a szerver is ellenőrzi). v1.1.1-től a törléshez nem szerveroldali
 * kapcsoló (a korábbi JG_TEST_CUSTOMER_DELETE_ENABLED megszűnt), hanem a kiosztott `crm.customer.delete` jog kell.
 */
export const DELETE_CONFIRMATION_WORD = "TÖRLÉS";
