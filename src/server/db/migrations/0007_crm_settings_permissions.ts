import type { Migration } from "../migrate";

/**
 * 0007 - adminisztrátori jogosultságok és beállítási változásnapló (v1.1, SET-002 / SET-003 / SET-008).
 *
 * - `user_permissions`: a megengedett jogok listája három új, adminisztratív joggal bővül (crm.settings.manage, crm.users.manage,
 *   crm.settings.audit.read). A korábbi CHECK egy tranzakcióban, ugyanazzal a jelentéssel (zárt lista) cserélődik egy bővebbre;
 *   meglévő sor nem változik. A migráció SEMMILYEN jogot nem oszt ki (a régi `role = 'admin'` sem ad jogot).
 *   Visszavonás törlés helyett `revoked_at` / `revoked_by` (két új, NULL-ozható oszlop): a kiosztás története megmarad, és az
 *   `app_has_permission()` (0005, itt kibővítve) csak a vissza nem vont jogot fogadja el.
 * - `settings_audit`: hozzáfűző változásnapló a konfiguráció- és jogosultság-módosításokról (siker és elutasítás). Az alkalmazás
 *   szerepköreinek nincs INSERT/UPDATE/DELETE joga: bejegyzést csak a SECURITY DEFINER triggerek és függvények írnak, a módosítást
 *   és törlést trigger tiltja (a tulajdonosi kapcsolaton is). Olvasni csak `crm.settings.audit.read` joggal lehet (RLS).
 *   Ügyféladatot, jegyzetet, tokent, jelszót nem tartalmaz: csak konfigurációs kulcsokat/értékeket és felhasználói azonosítót.
 * - Biztonsági függvények (mind fail-closed, a hívó `app.user_id`-jából és FRISS jogellenőrzésből dolgoznak):
 *   `app_admin_users()`              - a felhasználók listája jogokkal (csak crm.users.manage);
 *   `app_admin_set_permission(...)`  - egy jog kiosztása/visszavonása szigorú engedélyezőlistával, önjogosítás- és lockout-védelemmel
 *                                      (csak crm.users.manage); nem általános jogosultság-megkerülési csatorna;
 *   `app_admin_overview()`           - összesítő számok (csak adminisztratív joggal);
 *   `app_settings_audit_reject(...)` - elutasított kísérlet naplózása (bármely aktív felhasználó, csak a saját nevében).
 */
const sql = `
alter table user_permissions drop constraint user_permissions_permission_check;
alter table user_permissions add constraint user_permissions_permission_chk check (permission in (
  'crm.customer.import','crm.customer.export','crm.import.history.read','crm.settings.manage','crm.users.manage','crm.settings.audit.read'
));
-- Visszavonás törlés helyett: a sor megmarad (ki, mikor kapta / vonta vissza), a jog csak visszavonás nélkül érvényes.
alter table user_permissions add column revoked_at timestamptz;
alter table user_permissions add column revoked_by text check (revoked_by is null or length(btrim(revoked_by)) > 0);
alter table user_permissions add constraint user_permissions_revoke_chk check ((revoked_at is null) = (revoked_by is null));

create or replace function app_has_permission(p text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from users u join user_permissions up on up.user_id = u.id
    where u.id = nullif(current_setting('app.user_id', true), '') and u.active and up.permission = p and up.revoked_at is null
  )
$$;

create table settings_audit (
  id bigserial primary key,
  at timestamptz not null default now(),
  tx_id bigint not null default txid_current(),
  via text not null check (via in ('app','cli')),
  actor_user_id text references users(id),
  actor_label text check (actor_label is null or length(actor_label) <= 120),
  action text not null check (action ~ '^[a-z_.]{2,60}$'),
  entity_type text not null check (entity_type in ('pipeline_status','task_type','task_input','user_permission','settings')),
  entity_key text not null check (length(entity_key) between 1 and 200),
  outcome text not null default 'success' check (outcome in ('success','rejected')),
  changes jsonb,
  reason text check (reason is null or length(reason) <= 200),
  constraint settings_audit_actor_chk check (actor_user_id is not null or actor_label is not null)
);
create index settings_audit_at_idx on settings_audit(at desc, id desc);

create or replace function settings_audit_immutable() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  raise exception 'A beállítási változásnapló nem módosítható és nem törölhető.' using errcode = '42501';
end $$;
create trigger settings_audit_no_update before update or delete on settings_audit for each row execute function settings_audit_immutable();

alter table settings_audit enable row level security;
grant select on settings_audit to jg_app;
create policy audit_read on settings_audit for select to jg_app using (app_has_permission('crm.settings.audit.read'));

-- A hívó azonosítója (aktív felhasználó), különben NULL.
create or replace function app_current_user_id() returns text
language sql stable security definer set search_path = public, pg_temp as $$
  select u.id from users u where u.id = nullif(current_setting('app.user_id', true), '') and u.active
$$;
revoke all on function app_current_user_id() from public;

-- Jogosultság-változás naplózása triggerből (alkalmazás és üzemeltetői CLI egyaránt). Kiosztás: új sor vagy a visszavonás
-- megszüntetése; visszavonás: a revoked_at kitöltése. Más mezőváltozás nem jogosultság-változás.
create or replace function user_permissions_audit() returns trigger
language plpgsql security definer set search_path = public, pg_temp as $$
declare actor text := app_current_user_id(); act text;
begin
  if tg_op = 'INSERT' then
    if new.revoked_at is not null then return null; end if;
    act := 'permission.grant';
  elsif old.revoked_at is null and new.revoked_at is not null then act := 'permission.revoke';
  elsif old.revoked_at is not null and new.revoked_at is null then act := 'permission.grant';
  else return null;
  end if;
  insert into settings_audit (via, actor_user_id, actor_label, action, entity_type, entity_key, changes)
  values (
    case when actor is null then 'cli' else 'app' end,
    actor,
    case when actor is null then left(coalesce(nullif(current_setting('jg.operator', true), ''), case when act = 'permission.grant' then new.granted_by else new.revoked_by end, 'cli'), 120) end,
    act, 'user_permission', new.user_id || ':' || new.permission,
    jsonb_build_object('userId', new.user_id, 'permission', new.permission)
  );
  return null;
end $$;
revoke all on function user_permissions_audit() from public;
create trigger user_permissions_audit after insert or update on user_permissions for each row execute function user_permissions_audit();

create or replace function app_admin_users()
returns table (id text, name text, email text, active boolean, created_at timestamptz, last_login_at timestamptz, permissions text[])
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_has_permission('crm.users.manage') then
    raise exception 'jg:forbidden' using errcode = '42501';
  end if;
  return query
    select u.id, u.name, u.email, u.active, u.created_at, u.last_login_at,
      coalesce(array(select up.permission from user_permissions up where up.user_id = u.id and up.revoked_at is null order by up.permission), '{}'::text[])
    from users u order by u.active desc, u.name, u.id;
end $$;
revoke all on function app_admin_users() from public;
grant execute on function app_admin_users() to jg_app;

-- Egyetlen jog kiosztása vagy visszavonása. Hibakódok (üzenet): jg:forbidden, jg:self, jg:invalid_permission, jg:no_user,
-- jg:inactive_user, jg:last_admin. Eredmény: 'granted' | 'revoked' | 'unchanged'.
create or replace function app_admin_set_permission(p_user text, p_permission text, p_grant boolean) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare caller text := app_current_user_id(); target users; n int;
begin
  if caller is null or not app_has_permission('crm.users.manage') then
    raise exception 'jg:forbidden' using errcode = '42501';
  end if;
  if p_permission is null or p_permission not in ('crm.customer.import','crm.customer.export','crm.import.history.read','crm.settings.manage','crm.users.manage','crm.settings.audit.read') then
    raise exception 'jg:invalid_permission' using errcode = '22023';
  end if;
  if p_user is null or p_user = caller then
    raise exception 'jg:self' using errcode = '42501';
  end if;
  -- Sorba rendezés: a lockout-ellenőrzés és a módosítás nem futhat párhuzamosan két adminnál.
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

create or replace function app_admin_overview()
returns table (active_users bigint, inactive_users bigint, settings_admins bigint, user_admins bigint, audit_readers bigint, last_change_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not (app_has_permission('crm.settings.manage') or app_has_permission('crm.users.manage') or app_has_permission('crm.settings.audit.read')) then
    raise exception 'jg:forbidden' using errcode = '42501';
  end if;
  return query select
    (select count(*) from users where users.active),
    (select count(*) from users where not users.active),
    (select count(distinct up.user_id) from user_permissions up join users u on u.id = up.user_id where u.active and up.revoked_at is null and up.permission = 'crm.settings.manage'),
    (select count(distinct up.user_id) from user_permissions up join users u on u.id = up.user_id where u.active and up.revoked_at is null and up.permission = 'crm.users.manage'),
    (select count(distinct up.user_id) from user_permissions up join users u on u.id = up.user_id where u.active and up.revoked_at is null and up.permission = 'crm.settings.audit.read'),
    (select max(sa.at) from settings_audit sa where sa.outcome = 'success');
end $$;
revoke all on function app_admin_overview() from public;
grant execute on function app_admin_overview() to jg_app;

create or replace function app_settings_audit_reject(p_action text, p_entity_type text, p_entity_key text, p_reason text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
declare caller text := app_current_user_id();
begin
  if caller is null then raise exception 'jg:forbidden' using errcode = '42501'; end if;
  insert into settings_audit (via, actor_user_id, action, entity_type, entity_key, outcome, reason)
  values ('app', caller, left(p_action, 60), p_entity_type, left(coalesce(nullif(p_entity_key, ''), '-'), 200), 'rejected', left(p_reason, 200));
end $$;
revoke all on function app_settings_audit_reject(text, text, text, text) from public;
grant execute on function app_settings_audit_reject(text, text, text, text) to jg_app;
`;

export const migration0007: Migration = { id: "0007_crm_settings_permissions", description: "Adminisztrátori jogosultságok (beállítások, felhasználók, változásnapló) és hozzáfűző beállítási változásnapló", sql };
