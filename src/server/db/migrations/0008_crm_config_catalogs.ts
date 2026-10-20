import type { Migration } from "../migrate";

/**
 * 0008 - CRM konfigurációs katalógusok (v1.1, SET-004 / SET-005 / SET-006). Kizárólag additív: három új tábla, a v1.0 kódba égetett
 * listák PONTOS másolatával feltöltve (kulcs, megnevezés, sorrend változatlan; a teszt a `BUILTIN_CRM_CONFIG`-gal veti össze).
 *
 * - `crm_pipeline_statuses`: stabil kulcs, megnevezés, leírás, szín (zárt paletta), sorrend, aktív/archivált, rendszerstátusz-jelölés,
 *   üzleti jelentés (`semantic_type`), igazolási követelmény, megnevezés-zár, verzió (optimista párhuzamosság-kezelés), ki/mikor.
 * - `crm_task_types`, `crm_task_input_options` (+ `allows_note`): ugyanez a minta, egyszerűbben.
 * - A feladatokon a v1.0-ig már rögzített, a listában nem szereplő típus/Input kulcsok (ha vannak) ARCHIVÁLT, nem rendszer elemként
 *   kerülnek a katalógusba (megnevezés = a kulcs), így a régi feladatok változatlanok maradnak, és a 0009 idegen kulcsa érvényes.
 *
 * Védelmek az adatbázisban (nem csak a felületen):
 * - Az alkalmazás szerepköre (`jg_app`) oszlopszintű joggal csak a megnevezést, leírást, színt, sorrendet, aktív állapotot (és az
 *   Input megjegyzés-szabályát) írhatja; kulcsot, rendszerjelölést, üzleti jelentést, igazolási követelményt nem. Törlési joga nincs.
 * - RLS (FORCE): olvasni minden aktív felhasználó, írni csak `crm.settings.manage` joggal lehet.
 * - Őr-trigger: a kulcs és a védett mezők nem változnak; rendszerelem nem archiválható; zárolt megnevezés nem írható át; a verzió,
 *   a módosítás ideje és a módosító (az `app.user_id`-ból) automatikus; az archiválás ideje az aktív állapotból következik.
 * - Napló-trigger: minden tényleges változás a `settings_audit`-ba kerül (régi/új értékek a megjelenítési mezőkről), ugyanabban a
 *   tranzakcióban - napló nélkül nem véglegesíthető konfigurációváltozás.
 */
const sql = `
create table crm_pipeline_statuses (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null check (length(btrim(label)) between 1 and 60 and label = btrim(label)),
  description text check (description is null or length(description) <= 300),
  color text not null default 'neutral' check (color in ('neutral','info','accent','ok','warn','danger','teal','indigo')),
  sort_order integer not null check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  is_system boolean not null default false,
  semantic_type text not null default 'workflow' check (semantic_type in ('default','outreach','milestone','lost','workflow')),
  requires_verification boolean not null default false,
  label_locked boolean not null default false,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  created_by text references users(id),
  updated_at timestamptz not null default now(),
  updated_by text references users(id),
  archived_at timestamptz,
  constraint crm_pipeline_statuses_archive_chk check (is_active = (archived_at is null)),
  constraint crm_pipeline_statuses_custom_chk check (is_system or (semantic_type = 'workflow' and not requires_verification and not label_locked)),
  constraint crm_pipeline_statuses_verification_chk check (requires_verification = (semantic_type = 'milestone')),
  constraint crm_pipeline_statuses_default_active_chk check (semantic_type <> 'default' or is_active)
);
create unique index crm_pipeline_statuses_one_default_idx on crm_pipeline_statuses ((true)) where semantic_type = 'default';
create unique index crm_pipeline_statuses_label_idx on crm_pipeline_statuses (lower(label));

create table crm_task_types (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null check (length(btrim(label)) between 1 and 60 and label = btrim(label)),
  sort_order integer not null check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  is_system boolean not null default false,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  created_by text references users(id),
  updated_at timestamptz not null default now(),
  updated_by text references users(id),
  archived_at timestamptz,
  constraint crm_task_types_archive_chk check (is_active = (archived_at is null))
);
create unique index crm_task_types_label_idx on crm_task_types (lower(label));

create table crm_task_input_options (
  key text primary key check (key ~ '^[a-z][a-z0-9_]{1,39}$'),
  label text not null check (length(btrim(label)) between 1 and 60 and label = btrim(label)),
  sort_order integer not null check (sort_order between 0 and 100000),
  is_active boolean not null default true,
  is_system boolean not null default false,
  allows_note boolean not null default false,
  version integer not null default 1 check (version >= 1),
  created_at timestamptz not null default now(),
  created_by text references users(id),
  updated_at timestamptz not null default now(),
  updated_by text references users(id),
  archived_at timestamptz,
  constraint crm_task_input_options_archive_chk check (is_active = (archived_at is null))
);
create unique index crm_task_input_options_label_idx on crm_task_input_options (lower(label));

-- A v1.0 kódba égetett listák (változatlan kulcs, megnevezés, sorrend). A létrehozás ideje a migráció ideje.
insert into crm_pipeline_statuses (key, label, color, sort_order, is_system, semantic_type, requires_verification, label_locked) values
  ('waiting_for_contact', 'Feldolgozásra vár', 'neutral', 10, true, 'default', false, false),
  ('contact', 'Kapcsolatfelvétel', 'info', 20, true, 'outreach', false, false),
  ('relationship', 'Kapcsolatépítés', 'info', 30, true, 'outreach', false, false),
  ('meeting', 'Online/Személyes tárgyalás', 'accent', 40, true, 'workflow', false, false),
  ('account_opening', 'Számlanyitás', 'accent', 50, true, 'workflow', false, true),
  ('capital_placed', 'Tőke elhelyezve', 'ok', 60, true, 'milestone', true, true),
  ('lost', 'Elvesztett', 'danger', 70, true, 'lost', false, false);

insert into crm_task_types (key, label, sort_order, is_system) values
  ('phone_call', 'Telefonhívás', 10, true),
  ('email', 'E-mail', 20, true),
  ('online_meeting', 'Online tárgyalás', 30, true),
  ('in_person_meeting', 'Személyes tárgyalás', 40, true),
  ('follow_up', 'Utánkövetés', 50, true),
  ('other', 'Egyéb', 60, true);

insert into crm_task_input_options (key, label, sort_order, is_system, allows_note) values
  ('first_contact', 'Első megkeresés', 10, true, false),
  ('callback', 'Visszahívás', 20, true, false),
  ('scheduling', 'Időpont-egyeztetés', 30, true, false),
  ('information', 'Tájékoztatás', 40, true, false),
  ('follow_up', 'Utánkövetés', 50, true, false),
  ('other', 'Egyéb', 60, true, true);

-- Korábban rögzített, a listában nem szereplő kulcsok megőrzése archivált elemként (nincs átsorolás, nincs adatmódosítás).
insert into crm_task_types (key, label, sort_order, is_active, archived_at)
  select k, k, 1000 + row_number() over (order by k), false, now()
  from (select distinct task_type as k from tasks where task_type is not null and task_type not in (select key from crm_task_types)) x
  where k ~ '^[a-z][a-z0-9_]{1,39}$';
insert into crm_task_input_options (key, label, sort_order, is_active, archived_at)
  select k, k, 1000 + row_number() over (order by k), false, now()
  from (select distinct input_key as k from tasks where input_key is not null and input_key not in (select key from crm_task_input_options)) x
  where k ~ '^[a-z][a-z0-9_]{1,39}$';

-- Őr-trigger: védett mezők, rendszerelemek, verzió és ki/mikor (a jg_app nem írhatja közvetlenül).
create or replace function crm_catalog_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare actor text := nullif(current_setting('app.user_id', true), '');
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    new.updated_at := new.created_at;
    new.created_by := coalesce(actor, new.created_by);
    new.updated_by := new.created_by;
    new.archived_at := case when new.is_active then null else now() end;
    return new;
  end if;
  if new.key is distinct from old.key or new.is_system is distinct from old.is_system or new.created_at is distinct from old.created_at
     or new.created_by is distinct from old.created_by then
    raise exception 'jg:protected_field' using errcode = '42501';
  end if;
  if tg_table_name = 'crm_pipeline_statuses' then
    if new.semantic_type is distinct from old.semantic_type or new.requires_verification is distinct from old.requires_verification
       or new.label_locked is distinct from old.label_locked then
      raise exception 'jg:protected_field' using errcode = '42501';
    end if;
    if old.label_locked and new.label is distinct from old.label then
      raise exception 'jg:label_locked' using errcode = '42501';
    end if;
  end if;
  if old.is_system and not new.is_active then
    raise exception 'jg:system_archive' using errcode = '42501';
  end if;
  if row(new.*) is not distinct from row(old.*) then
    return new;
  end if;
  new.archived_at := case when new.is_active then null when old.is_active then now() else old.archived_at end;
  new.version := old.version + 1;
  new.updated_at := now();
  new.updated_by := coalesce(actor, old.updated_by);
  return new;
end $$;

-- Napló-trigger: a megjelenítési mezők tényleges változásai (régi -> új), a módosító azonosítójával.
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

do $$
declare t text;
begin
  foreach t in array array['crm_pipeline_statuses','crm_task_types','crm_task_input_options'] loop
    execute format('create trigger %I before insert or update on %I for each row execute function crm_catalog_guard()', t || '_guard', t);
    execute format('create trigger %I after insert or update on %I for each row execute function crm_catalog_audit()', t || '_audit', t);
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy catalog_read on %I for select to jg_app using (app_user_ok())', t);
    execute format('create policy catalog_insert on %I for insert to jg_app with check (app_has_permission(%L))', t, 'crm.settings.manage');
    execute format('create policy catalog_update on %I for update to jg_app using (app_has_permission(%L)) with check (app_has_permission(%L))', t, 'crm.settings.manage', 'crm.settings.manage');
    execute format('grant select on %I to jg_app', t);
  end loop;
end $$;

grant insert (key, label, description, color, sort_order) on crm_pipeline_statuses to jg_app;
grant update (label, description, color, sort_order, is_active) on crm_pipeline_statuses to jg_app;
grant insert (key, label, sort_order) on crm_task_types to jg_app;
grant update (label, sort_order, is_active) on crm_task_types to jg_app;
grant insert (key, label, sort_order, allows_note) on crm_task_input_options to jg_app;
grant update (label, sort_order, is_active, allows_note) on crm_task_input_options to jg_app;
`;

export const migration0008: Migration = { id: "0008_crm_config_catalogs", description: "Pipeline-státusz, feladattípus és Input-opció katalógusok a v1.0 értékeivel, védett mezőkkel és naplózással", sql };
