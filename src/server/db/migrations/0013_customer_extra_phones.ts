import type { Migration } from "../migrate";

/**
 * 0013 - több telefonszám ügyfelenként (v1.4). Kizárólag additív: egy új oszlop az ügyfeleken és az anonimizáló függvény új változata;
 * meglévő adat nem változik (a meglévő ügyfelek üres listát kapnak), a `customers.phone` (a fő telefonszám) érintetlen.
 *
 * - `customers.extra_phones text[] NOT NULL DEFAULT '{}'`: a fő telefonszám melletti további számok (legfeljebb 9, így ügyfelenként
 *   összesen 10). CHECK: nincs NULL elem, és minden elem (sortörés nélkül) a CRM telefonszám-szabályának megfelelő alakú (`^\+?[0-9 ()/-]{6,20}$`) -
 *   a felület és az API megkerülésével sem kerülhet be szabad szöveg. Az alkalmazás szerepkörének (jg_app) jogai nem változnak
 *   (a 0001 táblaszintű SELECT/INSERT/UPDATE joga az új oszlopra is vonatkozik; DELETE nincs).
 * - `privacy_anonymize_customer`: a végleges anonimizálás a további telefonszámokat is törli (üres lista). A függvény többi része
 *   bájtra azonos a 0012-es változattal; a jogai (csak a tulajdonos hívhatja, az alkalmazásfüggvényen át) változatlanok.
 *
 * A tiltólista-lenyomatot az alkalmazás számolja (minden telefonszámra, a további számokra is), a függvények szerződése nem változik.
 *
 * Visszagörgetés: scripts/sql/v1.4-schema-rollback.sql (csak külön jóváhagyással; az 1. szintű, ajánlott visszagörgetés az alkalmazáskód
 * visszaállítása - a v1.3 kód a megnövelt sémán is fut, mert az új oszlopot nem olvassa és nem írja; az alapérték miatt az általa
 * létrehozott ügyfél üres listát kap).
 */
const PHONE = "[+]?[0-9 ()/-]{6,20}";

const sql = `
alter table customers add column extra_phones text[] not null default '{}';
alter table customers add constraint customers_extra_phones_chk check (
  cardinality(extra_phones) <= 9
  and array_position(extra_phones, null) is null
  and (cardinality(extra_phones) = 0 or (
    array_to_string(extra_phones, chr(10)) ~ ('^${PHONE}(' || chr(10) || '${PHONE})*$')
    -- egy elem sem tartalmazhat sortörést (különben két számnak látszana)
    and cardinality(regexp_split_to_array(array_to_string(extra_phones, chr(10)), chr(10))) = cardinality(extra_phones)
  ))
);

-- A végleges anonimizálás a további telefonszámokat is törli (a 0012 változatához képest csak az extra_phones = '{}' új).
create or replace function privacy_anonymize_customer(p_customer text, p_actor text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c customers; ph constant text := '[Törölt tartalom]';
  n_contacts int; n_acts int; n_tasks int; n_results int; n_proc int; n_req int;
begin
  select * into c from customers where id = p_customer for update;
  if not found then raise exception 'jg:not_found' using errcode = '22023'; end if;
  if c.erased_at is not null then raise exception 'jg:already_erased' using errcode = '22023'; end if;
  if not exists (select 1 from users where id = p_actor) then raise exception 'jg:no_user' using errcode = '22023'; end if;
  update customers set
    first_name = case when type = 'individual' then 'Törölt' end,
    last_name = case when type = 'individual' then 'ügyfél' end,
    display_name = case when type = 'individual' then 'Törölt ügyfél' end,
    company_name = case when type = 'company' then 'Törölt ügyfél' end,
    notes = null, email = null, phone = null, extra_phones = '{}', source = '', acquisition_detail = null,
    deleted_at = coalesce(deleted_at, now()), deleted_by = coalesce(deleted_by, p_actor),
    erased_at = now(), erased_by = p_actor, updated_at = now()
  where id = p_customer;
  update company_contacts set first_name = 'Törölt', last_name = 'kapcsolattartó', position = null, email = null, phone = null, updated_at = now()
    where company_id = p_customer;
  get diagnostics n_contacts = row_count;
  update customer_restrictions set note = ph where customer_id = p_customer;
  update activities set summary = ph, meta = null, call_outcome = null where customer_id = p_customer;
  get diagnostics n_acts = row_count;
  update tasks set title = ph, description = null, input_note = null where customer_id = p_customer;
  get diagnostics n_tasks = row_count;
  update task_results set output_text = ph where task_id in (select id from tasks where customer_id = p_customer);
  get diagnostics n_results = row_count;
  update processes set title = ph, closure_reason_note = null, source = '' where customer_id = p_customer;
  get diagnostics n_proc = row_count;
  -- Az idempotencia-napló tárolt válaszai az ügyfél adatait tartalmazhatják: a válasz személyes adat nélküli jelölésre cserélődik.
  update request_log set response = '{"ok":false,"erased":true}'::jsonb where position(('"' || p_customer || '"') in response::text) > 0;
  get diagnostics n_req = row_count;
  -- Az érintetti nyilvántartásban csak az ügyfél-azonosító marad (a szabad szöveges érintett-megnevezés törlődik).
  update privacy_requests set subject_label = null where customer_id = p_customer and subject_label is not null;
  return jsonb_build_object('contacts', n_contacts, 'activities', n_acts, 'tasks', n_tasks, 'taskResults', n_results, 'processes', n_proc, 'requestLog', n_req);
end $$;
revoke all on function privacy_anonymize_customer(text, text) from public;
`;

export const migration0013: Migration = { id: "0013_customer_extra_phones", description: "Több telefonszám ügyfelenként: customers.extra_phones (legfeljebb 9 további szám), az anonimizálás ezeket is törli", sql };
