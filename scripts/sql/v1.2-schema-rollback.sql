-- JG Investment OS v1.2 (0011) -> v1.1.x SÉMA-visszagörgetés (2. szint). KIZÁRÓLAG külön jóváhagyás és friss titkosított mentés után, a
-- séma tulajdonosi kapcsolatával futtatandó (psql -v ON_ERROR_STOP=1 -f scripts/sql/v1.2-schema-rollback.sql; a szkript maga egy tranzakció).
-- Az 1. szintű (ajánlott) visszagörgetés csak az alkalmazáskódot állítja vissza v1.1.x-re: a v1.2 séma visszafelé kompatibilis (a v1.1 kód
-- nem olvassa és nem írja az új oszlopokat, a meglévő ügyfelek alapértékkel maradnak), ezt a szkriptet ahhoz NEM kell futtatni.
--
-- Mit csinál: eltávolítja a 0011 objektumait (az `acquisition_channel` / `acquisition_detail` oszlopokat, a csatorna-katalógust, az aktív-
-- csatorna triggert), visszaállítja a katalógus-napló függvényét és a `settings_audit.entity_type` korábbi listáját, és törli a 0011
-- bejegyzést a schema_migrations-ből. A v1.1 szkript (v1.1-schema-rollback.sql) csak EZUTÁN futtatható.
--
-- ADATVESZTÉS-VÉDELEM: a rögzített érkezési csatorna és részlet az oszlopokkal együtt megszűnne. Ha bármely ügyfélnél az `ismeretlen`-től
-- eltérő csatorna vagy részlet van rögzítve, a szkript megáll, és semmi nem változik. Ha a tulajdonos ezt tudatosan vállalja (a mentés
-- tartalmazza az adatot), a kapcsolat beállításával engedélyezhető: PGOPTIONS="-c jg.rollback_discard_channels=yes".
--
-- Ami MEGMARAD: az ügyféltörténetben a már rögzített "acquisition_change" bejegyzések (hozzáfűző napló; a v1.1 kód ismeretlen típusnál a
-- típuskulcsot mutatja), és a settings_audit naplóban a csatorna-katalógus módosításai (nem módosítható napló; a régi CHECK ezért
-- NOT VALID: az új sorokra érvényes, a meglévőket nem vizsgálja és nem törli).
begin;

do $$
declare n bigint;
begin
  select count(*) into n from customers where acquisition_channel <> 'ismeretlen' or acquisition_detail is not null;
  if n > 0 and coalesce(current_setting('jg.rollback_discard_channels', true), '') <> 'yes' then
    raise exception 'v1.2 rollback: % ügyfélnél van rögzített érkezési csatorna/részlet; a visszagörgetés elveszítené. Mentés után: PGOPTIONS="-c jg.rollback_discard_channels=yes"', n;
  end if;
end $$;

drop trigger customers_acquisition_active on customers;
drop function crm_acquisition_active_guard();
drop index customers_acquisition_channel_idx;
alter table customers drop constraint customers_acquisition_detail_chk;
alter table customers drop column acquisition_detail;
alter table customers drop column acquisition_channel;

drop table crm_acquisition_channels;

-- A 0008-as napló-függvény (az érkezési csatorna ágát nem ismeri).
create or replace function crm_catalog_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor text := app_current_user_id();
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  n jsonb := to_jsonb(new);
  f text;
  diff jsonb := '{}'::jsonb;
  act text;
  kind text := case tg_table_name when 'crm_pipeline_statuses' then 'pipeline_status' when 'crm_task_types' then 'task_type' else 'task_input' end;
begin
  foreach f in array array['label','description','color','sort_order','is_active','allows_note'] loop
    if n ? f and (tg_op = 'INSERT' or (o -> f) is distinct from (n -> f)) then
      diff := diff || jsonb_build_object(f, jsonb_build_object('from', case when tg_op = 'INSERT' then null else o -> f end, 'to', n -> f));
    end if;
  end loop;
  if diff = '{}'::jsonb then return null; end if;
  act := case
    when tg_op = 'INSERT' then 'create'
    when diff ? 'is_active' then case when (n ->> 'is_active')::boolean then 'reactivate' else 'archive' end
    when (select count(*) from jsonb_object_keys(diff)) = 1 and diff ? 'label' then 'rename'
    when (select count(*) from jsonb_object_keys(diff)) = 1 and diff ? 'sort_order' then 'reorder'
    when (select count(*) from jsonb_object_keys(diff)) = 1 and diff ? 'color' then 'recolor'
    else 'update' end;
  insert into settings_audit (via, actor_user_id, actor_label, action, entity_type, entity_key, changes)
  values (case when actor is null then 'cli' else 'app' end, actor, case when actor is null then left(coalesce(nullif(current_setting('jg.operator', true), ''), 'cli'), 120) end,
          kind || '.' || act, kind, new.key, diff);
  return null;
end $$;
revoke all on function crm_catalog_audit() from public;

alter table settings_audit drop constraint settings_audit_entity_type_check;
alter table settings_audit add constraint settings_audit_entity_type_check check (entity_type in ('pipeline_status','task_type','task_input','user_permission','settings')) not valid;

delete from schema_migrations where id = '0011_crm_acquisition_channels';
commit;
