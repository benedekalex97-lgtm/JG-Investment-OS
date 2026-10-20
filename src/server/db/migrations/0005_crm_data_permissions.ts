import type { Migration } from "../migrate";

/**
 * 0005 - műveletszintű adatmozgatási jogosultságok (v1.0, CRM-018) és üzemeltetői napló. Kizárólag additív: két új tábla és egy függvény.
 *
 * - `user_permissions`: kifejezetten kiosztott, műveletspecifikus jogok (import, export, importnapló olvasása). A migráció SEMMILYEN
 *   jogot nem ad: a meglévő (`role = 'admin'`) felhasználók sem kapnak automatikusan adatmozgatási jogot. Kiosztás és visszavonás
 *   kizárólag a tulajdonosi kapcsolattal futó üzemeltetői CLI-vel (`npm run db -- permission:grant|revoke`).
 * - Az alkalmazás (`jg_app`) és a futási szerepkör a táblához NEM fér hozzá közvetlenül; a jogot a `app_has_permission()` biztonsági
 *   függvény ellenőrzi a kérés tranzakciójában (az `app.user_id` aktív felhasználó ÉS van ilyen joga). Fail-closed: hiányzó sor = nincs jog.
 * - `ops_log`: üzemeltetői műveletek (jogosultság-kiosztás, mentés, visszaállítás) hozzáfűző naplója; személyes adatot nem tartalmaz.
 *   Az alkalmazás szerepköreinek nincs rá joga (csak a tulajdonosi CLI írja).
 */
const sql = `
create table user_permissions (
  user_id text not null references users(id),
  permission text not null check (permission in ('crm.customer.import','crm.customer.export','crm.import.history.read')),
  granted_at timestamptz not null default now(),
  granted_by text not null check (length(btrim(granted_by)) > 0),
  primary key (user_id, permission)
);
alter table user_permissions enable row level security;

create or replace function app_has_permission(p text) returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from users u join user_permissions up on up.user_id = u.id
    where u.id = nullif(current_setting('app.user_id', true), '') and u.active and up.permission = p
  )
$$;
revoke all on function app_has_permission(text) from public;
grant execute on function app_has_permission(text) to jg_app;

create table ops_log (
  id bigserial primary key,
  at timestamptz not null default now(),
  operation text not null check (length(btrim(operation)) > 0),
  environment text not null,
  operator text not null check (length(btrim(operator)) > 0),
  detail jsonb
);
alter table ops_log enable row level security;
`;

export const migration0005: Migration = { id: "0005_crm_data_permissions", description: "Műveletszintű adatmozgatási jogosultságok (import/export/importnapló) és üzemeltetői napló", sql };
