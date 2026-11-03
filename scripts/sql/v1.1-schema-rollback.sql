-- JG Investment OS v1.1 -> v1.0 SÉMA-visszagörgetés (2. szint). KIZÁRÓLAG külön jóváhagyás, friss titkosított mentés és a
-- docs/V1.1-ADMIN-SETTINGS.md 19. fejezetének ellenőrzőlistája után, a séma tulajdonosi kapcsolatával futtatandó
-- (psql -v ON_ERROR_STOP=1 -f scripts/sql/v1.1-schema-rollback.sql; a szkript maga egy tranzakció).
-- Az 1. szintű (ajánlott) visszagörgetés csak az alkalmazáskódot állítja vissza v1.0-ra: a v1.1 séma visszafelé kompatibilis, ezt
-- a szkriptet ahhoz NEM kell futtatni.
--
-- Mit csinál: visszaállítja a 0001 CHECK-kényszereit (customers/tasks.crm_status), eltávolítja a 0007-0009 objektumait, és a
-- user_permissions táblát a v1.0 jelentésére hozza (a v1.0 függvény nem ismeri a visszavonás-jelölést, ezért a visszavont és a v1.1
-- adminjog-sorokat törli). A settings_audit naplót eldobja - előtte a mentés tartalmazza.
-- Előfeltétel (ellenőrzi, különben megszakad, és semmi nem változik): nincs ügyfél/feladat a hét eredeti státuszon kívüli státuszban,
-- és nincs feladat a v1.1-ben felvett (nem rendszer, nem a migrációkor megőrzött) feladattípussal vagy Input-opcióval.
begin;

do $$
declare bad bigint;
begin
  select count(*) into bad from customers where crm_status is not null and crm_status not in ('waiting_for_contact','contact','relationship','meeting','account_opening','capital_placed','lost');
  if bad > 0 then raise exception 'v1.1 rollback: % ügyfél egyedi (v1.1) státuszban van; a séma nem görgethető vissza.', bad; end if;
  select count(*) into bad from tasks where crm_status is not null and crm_status not in ('waiting_for_contact','contact','relationship','meeting','account_opening','capital_placed','lost');
  if bad > 0 then raise exception 'v1.1 rollback: % feladat egyedi (v1.1) státuszhoz tartozik.', bad; end if;
  select count(*) into bad from tasks t join crm_task_types c on c.key = t.task_type where not c.is_system and c.created_by is not null;
  if bad > 0 then raise exception 'v1.1 rollback: % feladat v1.1-ben felvett feladattípust használ.', bad; end if;
  select count(*) into bad from tasks t join crm_task_input_options c on c.key = t.input_key where not c.is_system and c.created_by is not null;
  if bad > 0 then raise exception 'v1.1 rollback: % feladat v1.1-ben felvett Input-opciót használ.', bad; end if;
end $$;

-- 0009
drop trigger customers_assign_active on customers;
drop trigger tasks_assign_active on tasks;
drop function crm_assign_active_guard();
alter table customers drop constraint customers_crm_status_fk;
alter table tasks drop constraint tasks_crm_status_fk;
alter table tasks drop constraint tasks_task_type_fk;
alter table tasks drop constraint tasks_input_key_fk;
drop index tasks_crm_status_idx;
drop index tasks_task_type_idx;
drop index tasks_input_key_idx;
alter table customers add constraint customers_crm_status_check check (crm_status in ('waiting_for_contact','contact','relationship','meeting','account_opening','capital_placed','lost'));
alter table tasks add constraint tasks_crm_status_check check (crm_status in ('waiting_for_contact','contact','relationship','meeting','account_opening','capital_placed','lost'));

-- 0008
drop table crm_pipeline_statuses;
drop table crm_task_types;
drop table crm_task_input_options;
drop function crm_catalog_guard();
drop function crm_catalog_audit();

-- 0007
drop function app_settings_audit_reject(text, text, text, text);
drop function app_admin_overview();
drop function app_admin_set_permission(text, text, boolean);
drop function app_admin_users();
drop trigger user_permissions_audit on user_permissions;
drop function user_permissions_audit();
drop table settings_audit;
drop function settings_audit_immutable();
drop function app_current_user_id();
create or replace function app_has_permission(p text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from users u join user_permissions up on up.user_id = u.id
    where u.id = nullif(current_setting('app.user_id', true), '') and u.active and up.permission = p
  )
$$;
delete from user_permissions where revoked_at is not null or permission not in ('crm.customer.import','crm.customer.export','crm.import.history.read');
alter table user_permissions drop constraint user_permissions_revoke_chk;
alter table user_permissions drop column revoked_at;
alter table user_permissions drop column revoked_by;
alter table user_permissions drop constraint user_permissions_permission_chk;
alter table user_permissions add constraint user_permissions_permission_check check (permission in ('crm.customer.import','crm.customer.export','crm.import.history.read'));

delete from schema_migrations where id in ('0007_crm_settings_permissions','0008_crm_config_catalogs','0009_dynamic_crm_statuses');
commit;
