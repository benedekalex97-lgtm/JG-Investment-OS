-- JG Investment OS v1.3 (0012) -> v1.2.x SÉMA-visszagörgetés (2. szint). KIZÁRÓLAG külön jóváhagyás és friss titkosított mentés után, a
-- séma tulajdonosi kapcsolatával futtatandó (psql -v ON_ERROR_STOP=1 -f scripts/sql/v1.3-schema-rollback.sql; a szkript maga egy tranzakció).
-- Az 1. szintű (ajánlott) visszagörgetés csak az alkalmazáskódot állítja vissza v1.2.x-re: a v1.3 séma visszafelé kompatibilis (a v1.2 kód
-- nem olvassa és nem írja az új táblákat/oszlopokat), ezt a szkriptet ahhoz NEM kell futtatni.
--
-- Mit csinál: eltávolítja a 0012 objektumait (érintetti kérelmek, tiltólista, az anonimizálás jelölése és őr-triggere, az adatvédelmi
-- függvények), visszaállítja a 0010-es `customers_removal_guard()` és `app_admin_set_permission()` függvényt és a jogosultságok korábbi
-- listáját, és törli a 0012 bejegyzést a schema_migrations-ből. A v1.2 szkript (v1.2-schema-rollback.sql) csak EZUTÁN futtatható.
--
-- ADATVESZTÉS-VÉDELEM: az érintetti kérelmek nyilvántartása (elszámoltathatósági kötelezettség, GDPR 5. cikk (2)), a tiltólista és az
-- adatvédelmi jogok kiosztása a táblákkal együtt megszűnne, és az anonimizált ügyfelek jelölése is elveszne (a rekordjuk „Törölt ügyfél”
-- néven, eltávolítottként marad). Ha bármelyikből van adat, a szkript megáll, és semmi nem változik. Tudatos vállalásnál (a mentés
-- tartalmazza az adatot, és az érintetti nyilvántartás máshol megőrzött): PGOPTIONS="-c jg.rollback_discard_privacy=yes".
begin;

do $$
declare n bigint;
begin
  select (select count(*) from privacy_requests) + (select count(*) from privacy_suppressions) + (select count(*) from customers where erased_at is not null)
       + (select count(*) from user_permissions where permission in ('crm.privacy.manage','crm.privacy.erase')) into n;
  if n > 0 and coalesce(current_setting('jg.rollback_discard_privacy', true), '') <> 'yes' then
    raise exception 'v1.3 rollback: % adatvédelmi rekord (kérelem, tiltólista, anonimizálás vagy adatvédelmi jog) elveszne. Mentés után: PGOPTIONS="-c jg.rollback_discard_privacy=yes"', n;
  end if;
end $$;

drop function app_privacy_import_origin(text);
drop function app_privacy_erase_customer(text, text, jsonb);
drop function privacy_anonymize_customer(text, text);
drop function app_privacy_record_restriction(text, text, text, text, text, jsonb);
drop function privacy_add_suppressions(jsonb, text, text, text);
drop table privacy_suppressions;
drop table privacy_requests;
drop function privacy_requests_guard();

drop trigger customers_erasure_guard on customers;
drop function customers_erasure_guard();
alter table customers drop constraint customers_erased_chk;
alter table customers drop column erased_by;
alter table customers drop column erased_at;

-- A 0010-es eltávolítás-őr.
create or replace function customers_removal_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if nullif(current_setting('app.user_id', true), '') is null then return new; end if;
  if tg_op = 'INSERT' then
    if new.deleted_at is not null or new.deleted_by is not null then
      raise exception 'jg:forbidden_customer_delete' using errcode = '42501';
    end if;
    return new;
  end if;
  if (new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by)
     and not app_has_permission('crm.customer.delete') then
    raise exception 'jg:forbidden_customer_delete' using errcode = '42501';
  end if;
  return new;
end $$;

-- Jogosultságok: a (tudatos vállalással) megmaradt adatvédelmi jogsorok törlődnek, a lista a 0010 szerinti.
delete from user_permissions where permission in ('crm.privacy.manage','crm.privacy.erase');
alter table user_permissions drop constraint user_permissions_permission_chk;
alter table user_permissions add constraint user_permissions_permission_chk check (permission in (
  'crm.customer.import','crm.customer.export','crm.import.history.read','crm.settings.manage','crm.users.manage','crm.settings.audit.read',
  'crm.customer.delete'
));

create or replace function app_admin_set_permission(p_user text, p_permission text, p_grant boolean) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare caller text := app_current_user_id(); target users; n int;
begin
  if caller is null or not app_has_permission('crm.users.manage') then
    raise exception 'jg:forbidden' using errcode = '42501';
  end if;
  if p_permission is null or p_permission not in ('crm.customer.import','crm.customer.export','crm.import.history.read','crm.settings.manage','crm.users.manage','crm.settings.audit.read','crm.customer.delete') then
    raise exception 'jg:invalid_permission' using errcode = '22023';
  end if;
  if p_user is null or p_user = caller then
    raise exception 'jg:self' using errcode = '42501';
  end if;
  perform pg_advisory_xact_lock(hashtextextended('jg.user_permissions', 0));
  select * into target from users where users.id = p_user for update;
  if not found then raise exception 'jg:no_user' using errcode = '22023'; end if;
  if p_grant then
    if not target.active then raise exception 'jg:inactive_user' using errcode = '22023'; end if;
    insert into user_permissions (user_id, permission, granted_by) values (p_user, p_permission, 'app:' || caller)
      on conflict (user_id, permission) do update set granted_at = now(), granted_by = excluded.granted_by, revoked_at = null, revoked_by = null
      where user_permissions.revoked_at is not null;
    get diagnostics n = row_count;
    return case when n > 0 then 'granted' else 'unchanged' end;
  end if;
  if p_permission = 'crm.users.manage' and (
    select count(*) from user_permissions up join users u on u.id = up.user_id
    where up.permission = 'crm.users.manage' and up.revoked_at is null and u.active and up.user_id <> p_user
  ) = 0 then
    raise exception 'jg:last_admin' using errcode = '42501';
  end if;
  update user_permissions set revoked_at = now(), revoked_by = 'app:' || caller
    where user_id = p_user and permission = p_permission and revoked_at is null;
  get diagnostics n = row_count;
  return case when n > 0 then 'revoked' else 'unchanged' end;
end $$;
revoke all on function app_admin_set_permission(text, text, boolean) from public;
grant execute on function app_admin_set_permission(text, text, boolean) to jg_app;

delete from schema_migrations where id = '0012_crm_privacy';
commit;
