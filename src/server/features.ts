/**
 * Szerveroldali funkciókapcsolók (v0.9). Csak környezeti változóból, alapértelmezetten kikapcsolva; a kliens csak az eredményt látja
 * (a `/api/auth/me` válaszban), a döntés mindig a szerveren születik.
 */
export interface Features {
  /** CRM-006: tesztfázisban létrehozott ügyfél logikai eltávolítása. `JG_TEST_CUSTOMER_DELETE_ENABLED=true` kapcsolja be. */
  testCustomerDelete: boolean;
}

export function features(env: Record<string, string | undefined> = process.env): Features {
  return { testCustomerDelete: env.JG_TEST_CUSTOMER_DELETE_ENABLED?.trim().toLowerCase() === "true" };
}

/** A törlés megerősítő szava (a felületen be kell gépelni, a szerver is ellenőrzi). */
export const DELETE_CONFIRMATION_WORD = "TÖRLÉS";
