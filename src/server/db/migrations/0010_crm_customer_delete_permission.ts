import type { Migration } from "../migrate";

/**
 * 0010 - ügyféltörlés csak adminjoggal (v1.1.1). A CRM-006 logikai (visszaállítható) ügyfél-eltávolítása eddig egy szerveroldali
 * kapcsolóhoz (JG_TEST_CUSTOMER_DELETE_ENABLED) volt kötve, bármely munkatársnak. Mostantól egy kifejezetten kiosztott jog kell hozzá:
 * `crm.customer.delete`. A migráció SENKINEK nem ad jogot.
 *
 * - `user_permissions`: a megengedett jogok listája egy elemmel bővül (a CHECK egy tranzakcióban, ugyanazzal a zárt-lista jelentéssel cserélődik).
 * - `app_admin_set_permission()`: az engedélyezőlista bővül (minden más szabály változatlan: friss jogellenőrzés, önjogosítás tiltva,
 *   utolsó felhasználókezelő admin védve, naplózás triggerből).
 * - Adatbázis-szintű védelem: az ügyfél eltávolítás-jelölését (`deleted_at` / `deleted_by`) az alkalmazás szerepköre a felület és az API
 *   megkerülésével sem állíthatja be vagy törölheti a jog nélkül (trigger). A tulajdonosi (üzemeltetői) kapcsolat - pl. a CLI
 *   `customer:restore` - ettől független marad. A többi ügyféladat mentése (upsert) nem érinti ezeket a mezőket.
 */
const sql = `
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

-- Az eltávolítás-jelölés csak ügyféltörlési joggal változhat, ha a kérés egy alkalmazás-felhasználó nevében fut (app.user_id).
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
create trigger customers_removal_guard before insert or update of deleted_at, deleted_by on customers for each row execute function customers_removal_guard();
`;

export const migration0010: Migration = { id: "0010_crm_customer_delete_permission", description: "Ügyféltörlés (logikai, visszaállítható) csak kifejezetten kiosztott crm.customer.delete joggal", sql };
