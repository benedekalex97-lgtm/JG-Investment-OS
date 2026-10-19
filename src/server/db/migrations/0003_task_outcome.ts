import type { Migration } from "../migrate";

/**
 * 0003 - feladat-lezárás minősítése (v0.9). Kizárólag additív: egy új, NULL-ozható oszlop a `task_results` táblán.
 *
 * - `outcome`: a lezárás minősítése ('success' = Sikeres, 'failure' = Sikertelen), a szabad szöveges Outputtól (`output_text`)
 *   elkülönítve. A meglévő (v0.8-ig rögzített) sorok értéke NULL marad: nem kapnak utólag kitalált minősítést, a régi
 *   `output_key` / `output_text` értékek változatlanok.
 * - A minősített (új) lezárásnál az Output nem lehet üres (védelem a tartományi és API-szintű ellenőrzés mellett). A feltétel csak
 *   akkor vizsgálja a szöveget, ha `outcome` meg van adva, ezért a régi sorokat és a v0.8 alkalmazás írásait nem érinti.
 * - Jogosultság: a `jg_app` meglévő tábla-szintű SELECT/INSERT joga az új oszlopra is vonatkozik; UPDATE/DELETE továbbra sincs.
 *
 * Visszafelé kompatibilis: a v0.8 alkalmazás a bővített sémán változatlanul fut (a `select *` eredményében a plusz oszlopot figyelmen
 * kívül hagyja, beszúráskor NULL kerül bele).
 */
const sql = `
alter table task_results add column outcome text;
alter table task_results add constraint task_results_outcome_chk check (outcome is null or outcome in ('success','failure'));
alter table task_results add constraint task_results_outcome_output_chk check (outcome is null or length(btrim(output_text, E' \\t\\r\\n')) > 0);
`;

export const migration0003: Migration = { id: "0003_task_outcome", description: "Feladat-lezárás minősítése (Sikeres/Sikertelen) a szabad szöveges Outputtól elkülönítve", sql };
