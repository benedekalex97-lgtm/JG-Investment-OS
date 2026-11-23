import type { Migration } from "../migrate";

/**
 * 0011 - ügyfelek érkezési csatornája (v1.2). Kizárólag additív: egy új katalógustábla és két új oszlop az ügyfeleken; meglévő adat nem
 * változik, nem törlődik, és a `customers.source` (az adat EREDETE, szabad szöveg) érintetlen marad - az érkezési csatorna ettől független adat.
 *
 * - `crm_acquisition_channels`: a 0008 katalógusokkal azonos minta (stabil kulcs, megnevezés, leírás, sorrend, aktív/archivált,
 *   rendszerelem-jelölés, verzió, ki/mikor). Kezdő elemek: 11 szerkeszthető csatorna + az `ismeretlen` RENDSZERELEM (nem archiválható).
 * - `customers.acquisition_channel` (NOT NULL, alapérték `ismeretlen`, idegen kulcs a katalógusra): a meglévő ügyfelek az alapértéket kapják
 *   (a PostgreSQL az alapértéket az oszlop hozzáadásakor tölti ki, a sorok tartalma nem íródik át). `customers.acquisition_detail`: opcionális,
 *   legfeljebb 200 karakter, vezérlőkarakter nélkül.
 *
 * Védelmek az adatbázisban (nem csak a felületen):
 * - A katalógus jogai, RLS-e (FORCE), őr- és napló-trigger: ugyanazok, mint a 0008-ban (a `crm_catalog_guard()` közös); az alkalmazás
 *   szerepköre oszlopszintű joggal csak a megnevezést, leírást, sorrendet, aktív állapotot írhatja, törlési joga nincs, írni csak
 *   `crm.settings.manage` joggal lehet. A napló-trigger függvénye (`crm_catalog_audit`) az új entitástípust is ismeri.
 * - Az ügyfelek táblájának jogai nem változnak (a 0001 táblaszintű SELECT/INSERT/UPDATE joga az új oszlopokra is vonatkozik; DELETE nincs).
 * - Új hozzárendelés csak AKTÍV csatornára (trigger, a felület és az API megkerülésével sem). Az archivált csatornán lévő ügyfél többi
 *   adata ettől függetlenül menthető (a trigger csak a ténylegesen megváltozó hivatkozást vizsgálja; az ON CONFLICT ágat a BEFORE UPDATE ág kezeli).
 * - `settings_audit.entity_type` bővül az `acquisition_channel` értékkel (a CHECK egy tranzakcióban, ugyanazzal a zárt-lista jelentéssel cserélődik).
 *
 * Visszagörgetés: scripts/sql/v1.2-schema-rollback.sql (csak külön jóváhagyással; az 1. szintű, ajánlott visszagörgetés az alkalmazáskód
 * visszaállítása - a v1.1 kód a megnövelt sémán is fut, mert nem ír és nem olvas új oszlopot).
 */
const sql = `
create table crm_acquisition_channels (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null check (length(btrim(label)) between 1 and 60 and label = btrim(label)),
  description text check (description is null or length(description) <= 300),
  sort_order integer not null check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  is_system boolean not null default false,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  created_by text references users(id),
  updated_at timestamptz not null default now(),
  updated_by text references users(id),
  archived_at timestamptz,
  constraint crm_acquisition_channels_archive_chk check (is_active = (archived_at is null)),
  constraint crm_acquisition_channels_system_active_chk check (not is_system or is_active)
);
create unique index crm_acquisition_channels_label_idx on crm_acquisition_channels (lower(label));

insert into crm_acquisition_channels (key, label, description, sort_order, is_system) values
  ('weboldal', 'Weboldal (közvetlen kapcsolatfelvétel)', null, 10, false),
  ('google_kereses', 'Google-keresés', null, 20, false),
  ('google_cegprofil', 'Google Cégprofil', null, 30, false),
  ('facebook', 'Facebook', null, 40, false),
  ('linkedin', 'LinkedIn', null, 50, false),
  ('bemutatkozo_level', 'Bemutatkozó levél', null, 60, false),
  ('ajanlas', 'Ajánlás (ügyfél vagy ismerős)', null, 70, false),
  ('szemelyes_ismeretseg', 'Személyes ismeretség', null, 80, false),
  ('kh_ertekpapir', 'K&H Értékpapír közvetítése', null, 90, false),
  ('rendezveny', 'Rendezvény, előadás', null, 100, false),
  ('egyeb', 'Egyéb', null, 110, false),
  ('ismeretlen', 'Ismeretlen', 'A régi és az importált ügyfelek alapértéke; rendszerelem, nem archiválható.', 120, true);

-- A napló-trigger függvénye az új entitástípust is ismeri (a 0008 változata a "task_input" ágra esett volna vissza).
create or replace function crm_catalog_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare
  actor text := app_current_user_id();
  o jsonb := case when tg_op = 'UPDATE' then to_jsonb(old) else '{}'::jsonb end;
  n jsonb := to_jsonb(new);
  f text;
  diff jsonb := '{}'::jsonb;
  act text;
  kind text := case tg_table_name when 'crm_pipeline_statuses' then 'pipeline_status' when 'crm_task_types' then 'task_type'
    when 'crm_acquisition_channels' then 'acquisition_channel' else 'task_input' end;
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
alter table settings_audit add constraint settings_audit_entity_type_check check (entity_type in ('pipeline_status','task_type','task_input','acquisition_channel','user_permission','settings'));

create trigger crm_acquisition_channels_guard before insert or update on crm_acquisition_channels for each row execute function crm_catalog_guard();
create trigger crm_acquisition_channels_audit after insert or update on crm_acquisition_channels for each row execute function crm_catalog_audit();
alter table crm_acquisition_channels enable row level security;
alter table crm_acquisition_channels force row level security;
create policy catalog_read on crm_acquisition_channels for select to jg_app using (app_user_ok());
create policy catalog_insert on crm_acquisition_channels for insert to jg_app with check (app_has_permission('crm.settings.manage'));
create policy catalog_update on crm_acquisition_channels for update to jg_app using (app_has_permission('crm.settings.manage')) with check (app_has_permission('crm.settings.manage'));
grant select on crm_acquisition_channels to jg_app;
grant insert (key, label, description, sort_order) on crm_acquisition_channels to jg_app;
grant update (label, description, sort_order, is_active) on crm_acquisition_channels to jg_app;

-- Ügyfél-mezők: a meglévő ügyfelek az alapértéket ("ismeretlen") kapják; adat nem íródik át.
alter table customers add column acquisition_channel text not null default 'ismeretlen' constraint customers_acquisition_channel_fk references crm_acquisition_channels(key);
alter table customers add column acquisition_detail text constraint customers_acquisition_detail_chk check (
  acquisition_detail is null or (length(btrim(acquisition_detail)) between 1 and 200 and acquisition_detail = btrim(acquisition_detail) and acquisition_detail !~ '[[:cntrl:]]')
);
create index customers_acquisition_channel_idx on customers(acquisition_channel);

-- Új hozzárendelés csak aktív csatornára (a hívó jogosultságával fut: a katalógust az RLS minden aktív felhasználónak megmutatja).
create or replace function crm_acquisition_active_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if tg_op = 'INSERT' and exists (select 1 from customers c where c.id = new.id) then return new; end if;
  if (tg_op = 'INSERT' or new.acquisition_channel is distinct from old.acquisition_channel)
     and not exists (select 1 from crm_acquisition_channels s where s.key = new.acquisition_channel and s.is_active) then
    raise exception 'jg:inactive_channel' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger customers_acquisition_active before insert or update of acquisition_channel on customers for each row execute function crm_acquisition_active_guard();
`;

export const migration0011: Migration = { id: "0011_crm_acquisition_channels", description: "Érkezési csatorna katalógus (védett, naplózott) és az ügyfelek acquisition_channel / acquisition_detail mezői", sql };
