import type { Migration } from "../migrate";

/**
 * 0014 - belépési napló (v1.5). Kizárólag additív: egy új, csak hozzáfűzhető naplótábla és egy biztonsági függvény; meglévő adat nem változik.
 *
 * - `auth_events`: sikeres és sikertelen belépés, kilépés - ki (felhasználó, e-mail), mikor, milyen módon (Google / jelszó), sikertelennél
 *   az ok, és a böngésző + operációs rendszer durva megnevezése („Chrome · Windows”). IP-címet, teljes user-agentet, tokent, Google-
 *   profiladatot NEM tárol. Sikertelen Google-belépésnél az e-mail a Google által igazolt cím (nem regisztrált felhasználónál is - ez
 *   a jogosulatlan próbálkozás felismeréséhez kell).
 * - Olvasni csak `crm.settings.audit.read` joggal lehet (FORCE RLS); az alkalmazás szerepköre (jg_app) nem írhatja, nem módosíthatja
 *   és nem törölheti közvetlenül. Írni kizárólag az `auth_record_event(...)` SECURITY DEFINER függvényen át lehet, amely a mezőket a
 *   CHECK-ek szerint ellenőrzi; a függvényt a jg_app és a futási (bejelentkezési) szerepkörök hívhatják.
 * - Megőrzés: 12 hónap (a technikai megőrzési feladat törli a régebbi sorokat).
 *
 * Visszagörgetés: scripts/sql/v1.5-schema-rollback.sql (csak külön jóváhagyással; az 1. szintű visszagörgetés az alkalmazáskód
 * visszaállítása - a v1.4 kód a megnövelt sémán is fut, mert a táblát és a függvényt nem használja).
 */
const sql = `
create table auth_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  event text not null check (event in ('login_success','login_failure','logout')),
  method text not null check (method in ('google','password')),
  user_id text references users(id),
  email text check (email is null or (length(email) between 3 and 254 and email = lower(email) and email !~ '[[:space:][:cntrl:]]')),
  reason text check (reason is null or reason in ('not_allowed','cancelled','failed','invalid_credentials','rate_limited')),
  device text check (device is null or (length(device) <= 120 and device !~ '[[:cntrl:]]')),
  constraint auth_events_reason_chk check ((event = 'login_failure') = (reason is not null)),
  constraint auth_events_user_chk check (event = 'login_failure' or user_id is not null)
);
create index auth_events_at_idx on auth_events (at desc, id desc);
create index auth_events_user_idx on auth_events (user_id, at desc);
alter table auth_events enable row level security;
alter table auth_events force row level security;
grant select on auth_events to jg_app;
create policy auth_events_read on auth_events for select to jg_app using (app_has_permission('crm.settings.audit.read'));

-- Az egyetlen írási út: ellenőrzött beszúrás (a tulajdonos jogával; frissítés és törlés nincs).
create or replace function auth_record_event(p_event text, p_method text, p_user text, p_email text, p_reason text, p_device text) returns void
language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if p_user is not null and not exists (select 1 from users where id = p_user) then p_user := null; end if;
  insert into auth_events (event, method, user_id, email, reason, device)
  values (p_event, p_method, p_user, nullif(lower(btrim(coalesce(p_email, ''))), ''), p_reason, nullif(left(btrim(coalesce(p_device, '')), 120), ''));
end $$;
revoke all on function auth_record_event(text, text, text, text, text, text) from public;
grant execute on function auth_record_event(text, text, text, text, text, text) to jg_app;
-- A futási (bejelentkezési) szerepkörök a belépést a jg_app-ra váltás nélkül, a saját jogukkal kezelik: ők is hívhatják.
do $$
declare r record;
begin
  for r in select m.rolname from pg_auth_members a join pg_roles m on m.oid = a.member where a.roleid = 'jg_app'::regrole and m.rolcanlogin loop
    execute format('grant execute on function auth_record_event(text, text, text, text, text, text) to %I', r.rolname);
  end loop;
end $$;
`;

export const migration0014: Migration = { id: "0014_auth_events", description: "Belépési napló: auth_events (csak hozzáfűzés, FORCE RLS, crm.settings.audit.read), auth_record_event()", sql };
