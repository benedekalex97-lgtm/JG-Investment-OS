import type { Migration } from "../migrate";

/**
 * 0009 - dinamikus Pipeline-státuszok, feladattípusok és Input-opciók hivatkozási modellje (v1.1, SET-004 / SET-009).
 *
 * A `customers.crm_status` és a `tasks.crm_status` eddig a 0001 rögzített CHECK-listájához volt kötve. Itt EGY tranzakcióban, ellenőrzött
 * cserével idegen kulcsra váltunk a 0008 katalógusára - szabad szöveges státuszmező nem marad:
 *   1. előfeltétel-ellenőrzés: minden meglévő érték szerepel a katalógusban (különben a migráció megáll, semmi nem változik);
 *   2. az idegen kulcsok létrehozása (érvényesítéssel), majd a régi CHECK-ek eltávolítása;
 *   3. a `tasks.task_type` és a `tasks.input_key` (eddig ellenőrzés nélküli szöveg) szintén a katalógusra mutató idegen kulcsot kap.
 * Adat nem változik: nincs átsorolás, nincs státusz-módosítás, nincs törlés. A katalógus sorai idegen kulcs miatt nem törölhetők, amíg
 * bármely (akár logikailag eltávolított) rekord hivatkozik rájuk.
 *
 * Új hozzárendelés csak aktív elemre (trigger, a felület és az API megkerülésével sem): új ügyfél / státuszváltás csak aktív státuszba,
 * új feladat csak aktív típussal és Inputtal. A már archivált státuszban lévő ügyfél többi adata ettől függetlenül menthető, és a régi
 * feladatai lezárhatók (a trigger csak a ténylegesen megváltozó hivatkozást vizsgálja; az ON CONFLICT frissítési ágát a BEFORE UPDATE
 * ág kezeli).
 *
 * Visszafelé kompatibilis a v1.0 kóddal: az a hét eredeti kulcsot írja, ezek a katalógusban aktívak.
 * A 0001-0008 migrációk változatlanok. Visszagörgetés: docs/V1.1-ADMIN-SETTINGS.md (19. fejezet).
 */
const sql = `
do $$
declare bad bigint;
begin
  select count(*) into bad from customers where crm_status is not null and crm_status not in (select key from crm_pipeline_statuses);
  if bad > 0 then raise exception 'jg:migration_precheck customers.crm_status (%)', bad; end if;
  select count(*) into bad from tasks where crm_status is not null and crm_status not in (select key from crm_pipeline_statuses);
  if bad > 0 then raise exception 'jg:migration_precheck tasks.crm_status (%)', bad; end if;
  select count(*) into bad from tasks where task_type is not null and task_type not in (select key from crm_task_types);
  if bad > 0 then raise exception 'jg:migration_precheck tasks.task_type (%)', bad; end if;
  select count(*) into bad from tasks where input_key is not null and input_key not in (select key from crm_task_input_options);
  if bad > 0 then raise exception 'jg:migration_precheck tasks.input_key (%)', bad; end if;
end $$;

alter table customers add constraint customers_crm_status_fk foreign key (crm_status) references crm_pipeline_statuses(key);
alter table tasks add constraint tasks_crm_status_fk foreign key (crm_status) references crm_pipeline_statuses(key);
alter table tasks add constraint tasks_task_type_fk foreign key (task_type) references crm_task_types(key);
alter table tasks add constraint tasks_input_key_fk foreign key (input_key) references crm_task_input_options(key);
create index tasks_crm_status_idx on tasks(crm_status);
create index tasks_task_type_idx on tasks(task_type);
create index tasks_input_key_idx on tasks(input_key);

alter table customers drop constraint customers_crm_status_check;
alter table tasks drop constraint tasks_crm_status_check;

-- Új hozzárendelés csak aktív katalóguselemre (a hívó jogosultságával fut: a katalógust az RLS minden aktív felhasználónak megmutatja).
create or replace function crm_assign_active_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
declare is_new boolean := tg_op = 'INSERT';
begin
  if is_new and exists (select 1 from customers c where tg_table_name = 'customers' and c.id = new.id) then return new; end if;
  if is_new and exists (select 1 from tasks t where tg_table_name = 'tasks' and t.id = new.id) then return new; end if;
  if tg_table_name = 'customers' then
    if new.crm_status is not null and (is_new or new.crm_status is distinct from old.crm_status)
       and not exists (select 1 from crm_pipeline_statuses s where s.key = new.crm_status and s.is_active) then
      raise exception 'jg:inactive_status' using errcode = '23514';
    end if;
    return new;
  end if;
  if new.task_type is not null and (is_new or new.task_type is distinct from old.task_type)
     and not exists (select 1 from crm_task_types s where s.key = new.task_type and s.is_active) then
    raise exception 'jg:inactive_task_type' using errcode = '23514';
  end if;
  if new.input_key is not null and (is_new or new.input_key is distinct from old.input_key)
     and not exists (select 1 from crm_task_input_options s where s.key = new.input_key and s.is_active) then
    raise exception 'jg:inactive_task_input' using errcode = '23514';
  end if;
  if not is_new and new.crm_status is distinct from old.crm_status then
    raise exception 'jg:task_status_immutable' using errcode = '23514';
  end if;
  return new;
end $$;
create trigger customers_assign_active before insert or update of crm_status on customers for each row execute function crm_assign_active_guard();
create trigger tasks_assign_active before insert or update of task_type, input_key, crm_status on tasks for each row execute function crm_assign_active_guard();
`;

export const migration0009: Migration = { id: "0009_dynamic_crm_statuses", description: "Dinamikus státusz-, feladattípus- és Input-hivatkozás: CHECK helyett idegen kulcs a katalógusra, aktív-elem védelem", sql };
