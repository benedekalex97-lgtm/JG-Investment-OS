-- JG Investment OS v1.4 (0013) -> v1.3 SÉMA-visszagörgetés (2. szint). KIZÁRÓLAG külön jóváhagyás és friss titkosított mentés után, a
-- séma tulajdonosi kapcsolatával futtatandó (psql -v ON_ERROR_STOP=1 -f scripts/sql/v1.4-schema-rollback.sql; a szkript maga egy tranzakció).
-- Az 1. szintű (ajánlott) visszagörgetés csak az alkalmazáskódot állítja vissza v1.3-ra: a v1.4 séma visszafelé kompatibilis (a v1.3 kód
-- nem olvassa és nem írja az új oszlopot), ezt a szkriptet ahhoz NEM kell futtatni.
--
-- Mit csinál: eltávolítja a 0013 objektumait (a `customers.extra_phones` oszlopot és CHECK-jét), visszaállítja az anonimizáló függvény
-- 0012-es változatát, és törli a 0013 bejegyzést a schema_migrations-ből. A v1.3 szkript (v1.3-schema-rollback.sql) csak EZUTÁN futtatható.
--
-- ADATVESZTÉS-VÉDELEM: a rögzített további telefonszámok az oszloppal együtt megszűnnének. Ha bármely ügyfélnél van további telefonszám,
-- a szkript megáll, és semmi nem változik. Ha a tulajdonos ezt tudatosan vállalja (a mentés tartalmazza az adatot), a kapcsolat
-- beállításával engedélyezhető: PGOPTIONS="-c jg.rollback_discard_extra_phones=yes".
begin;

do $$
declare n bigint;
begin
  select count(*) into n from customers where cardinality(extra_phones) > 0;
  if n > 0 and coalesce(current_setting('jg.rollback_discard_extra_phones', true), '') <> 'yes' then
    raise exception 'v1.4 rollback: % ügyfélnél van további telefonszám; a visszagörgetés elveszítené. Mentés után: PGOPTIONS="-c jg.rollback_discard_extra_phones=yes"', n;
  end if;
end $$;

-- A 0012-es anonimizáló függvény (a további telefonszámokat nem ismeri).
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
    notes = null, email = null, phone = null, source = '', acquisition_detail = null,
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

alter table customers drop constraint customers_extra_phones_chk;
alter table customers drop column extra_phones;

delete from schema_migrations where id = '0013_customer_extra_phones';
commit;
