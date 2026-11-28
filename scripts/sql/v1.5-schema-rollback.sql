-- JG Investment OS v1.5 (0014) -> v1.4 SÉMA-visszagörgetés (2. szint). KIZÁRÓLAG külön jóváhagyás és friss titkosított mentés után, a
-- séma tulajdonosi kapcsolatával futtatandó (psql -v ON_ERROR_STOP=1 -f scripts/sql/v1.5-schema-rollback.sql; a szkript maga egy tranzakció).
-- Az 1. szintű (ajánlott) visszagörgetés csak az alkalmazáskódot állítja vissza v1.4-re: a v1.5 séma visszafelé kompatibilis (a v1.4 kód
-- a belépési naplót nem használja), ezt a szkriptet ahhoz NEM kell futtatni.
--
-- Mit csinál: eltávolítja a 0014 objektumait (az `auth_events` táblát és az `auth_record_event` függvényt), és törli a 0014 bejegyzést a
-- schema_migrations-ből. A v1.4 szkript (v1.4-schema-rollback.sql) csak EZUTÁN futtatható.
--
-- ADATVESZTÉS-VÉDELEM: a belépési napló a táblával együtt megszűnne. Ha van bejegyzés, a szkript megáll, és semmi nem változik. Ha a
-- tulajdonos ezt tudatosan vállalja (a mentés tartalmazza az adatot), a kapcsolat beállításával engedélyezhető:
-- PGOPTIONS="-c jg.rollback_discard_auth_events=yes".
begin;

do $$
declare n bigint;
begin
  select count(*) into n from auth_events;
  if n > 0 and coalesce(current_setting('jg.rollback_discard_auth_events', true), '') <> 'yes' then
    raise exception 'v1.5 rollback: a belépési naplóban % bejegyzés van; a visszagörgetés elveszítené. Mentés után: PGOPTIONS="-c jg.rollback_discard_auth_events=yes"', n;
  end if;
end $$;

drop function auth_record_event(text, text, text, text, text, text);
drop table auth_events;

delete from schema_migrations where id = '0014_auth_events';
commit;
