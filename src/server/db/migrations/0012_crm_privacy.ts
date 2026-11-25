import type { Migration } from "../migrate";

/**
 * 0012 - adatvédelem (v1.3, GDPR 12-21. és 30. cikk): érintetti kérelmek nyilvántartása, tiltakozás/korlátozás rögzítése,
 * tiltólista, végleges anonimizálás (törlés), és két új, kifejezetten kiosztandó jog. Kizárólag additív: új táblák, új oszlopok,
 * új függvények és triggerek; meglévő sor nem változik. A migráció SENKINEK nem ad jogot.
 *
 * Jogok:
 *  - `crm.privacy.manage`: érintetti kérelmek nyilvántartása, hozzáférési/hordozhatósági kivonat, tiltakozás és korlátozás rögzítése,
 *    megőrzési felülvizsgálat;
 *  - `crm.privacy.erase`: egy ügyfél és minden kapcsolódó szabad szöveges adatának VISSZAFORDÍTHATATLAN anonimizálása, kizárólag egy
 *    rögzített, azonosított érintettől érkezett, nyitott törlési kérelem alapján, NÉGY-SZEM ELVVEL (a kérelmet rögzítő nem törölhet).
 *
 * Táblák:
 *  - `privacy_requests`: a beérkezett érintetti kérelmek (hozzáférés, hordozhatóság, helyesbítés, törlés, korlátozás, tiltakozás) a
 *    GDPR 12. cikk (3) szerinti határidővel; olvasni/írni csak `crm.privacy.manage` joggal (FORCE RLS). Törlési jog nincs; a lezárt
 *    kérelem nem nyitható újra, az azonosító mezők nem módosíthatók (trigger).
 *  - `privacy_suppressions`: tiltólista - a törölt vagy tiltakozó érintettek e-mail-címének / telefonszámának egyirányú (SHA-256,
 *    tartományelválasztott) lenyomata, hogy egy későbbi import vagy kézi felvitel ne hozza vissza őket. Nyers elérhetőséget nem tárol.
 *    Az alkalmazás csak olvashatja (egyezésvizsgálat); írni csak a lenti biztonsági függvények írhatják.
 *  - `customers.erased_at` / `erased_by`: az anonimizálás ténye. Az anonimizált ügyfél az alkalmazás szerepköréből (jg_app) semmilyen
 *    módon nem módosítható, és nem állítható vissza (trigger); az anonimizálás csak a lenti függvényen át történhet.
 *
 * Biztonsági függvények (mind fail-closed, a hívó `app.user_id`-jából és FRISS jogellenőrzésből dolgoznak):
 *  - `app_privacy_record_restriction(...)`: tiltakozás / korlátozás első rögzítése (a meglévő nem írható felül), tiltakozásnál tiltólista;
 *  - `app_privacy_erase_customer(...)`: végleges anonimizálás egy tranzakcióban (ügyfél, kapcsolattartók, jegyzetek, előzmények,
 *    feladatok, Outputok, régi folyamatok, idempotencia-napló), tiltólista, a kérelem lezárása;
 *  - `app_privacy_import_origin(...)`: az ügyfél import-eredete (adatforrás, cél) a hozzáférési kivonathoz.
 */
const PERMS = `'crm.customer.import','crm.customer.export','crm.import.history.read','crm.settings.manage','crm.users.manage','crm.settings.audit.read',
  'crm.customer.delete','crm.privacy.manage','crm.privacy.erase'`;

const sql = `
alter table user_permissions drop constraint user_permissions_permission_chk;
alter table user_permissions add constraint user_permissions_permission_chk check (permission in (${PERMS}));

create or replace function app_admin_set_permission(p_user text, p_permission text, p_grant boolean) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare caller text := app_current_user_id(); target users; n int;
begin
  if caller is null or not app_has_permission('crm.users.manage') then
    raise exception 'jg:forbidden' using errcode = '42501';
  end if;
  if p_permission is null or p_permission not in (${PERMS}) then
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

-- ------------------------------------------------------------------ Érintetti kérelmek
create table privacy_requests (
  id text primary key check (id ~ '^pr-[0-9a-f]{16}$'),
  kind text not null check (kind in ('access','portability','rectification','erasure','restriction','objection')),
  customer_id text references customers(id),
  subject_label text check (subject_label is null or (length(btrim(subject_label)) between 1 and 200 and subject_label !~ '[[:cntrl:]]')),
  channel text not null check (channel in ('email','phone','letter','in_person','other')),
  received_at timestamptz not null,
  due_at timestamptz not null,
  extended boolean not null default false,
  identity_verified boolean not null default false,
  status text not null default 'open' check (status in ('open','in_progress','completed','rejected')),
  outcome_note text check (outcome_note is null or length(outcome_note) <= 1000),
  created_by text not null references users(id),
  created_at timestamptz not null default now(),
  updated_by text not null references users(id),
  updated_at timestamptz not null default now(),
  closed_at timestamptz,
  closed_by text references users(id),
  version integer not null default 1 check (version >= 1),
  constraint privacy_requests_subject_chk check (customer_id is not null or subject_label is not null),
  constraint privacy_requests_closed_chk check ((status in ('completed','rejected')) = (closed_at is not null and closed_by is not null)),
  constraint privacy_requests_due_chk check (due_at > received_at and due_at <= received_at + interval '3 months 1 day')
);
create index privacy_requests_status_idx on privacy_requests(status, due_at);
create index privacy_requests_customer_idx on privacy_requests(customer_id);

-- Védelem: az azonosító mezők nem változnak, a lezárt kérelem végleges, a verzió / módosító / időpont automatikus.
create or replace function privacy_requests_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
-- A hívó azonosítója (az RLS-szabály már megkövetelte, hogy aktív, crm.privacy.manage jogú felhasználó legyen).
declare actor text := nullif(current_setting('app.user_id', true), '');
begin
  if tg_op = 'INSERT' then
    new.version := 1;
    new.created_at := now();
    new.updated_at := now();
    if actor is not null then new.created_by := actor; new.updated_by := actor; end if;
    if new.status in ('completed','rejected') then raise exception 'jg:closed_on_create' using errcode = '23514'; end if;
    return new;
  end if;
  if new.id <> old.id or new.kind <> old.kind or new.created_by <> old.created_by or new.created_at <> old.created_at
     or new.received_at <> old.received_at or new.customer_id is distinct from old.customer_id and old.customer_id is not null then
    raise exception 'jg:protected_field' using errcode = '42501';
  end if;
  if old.status in ('completed','rejected') and (current_user = 'jg_app' or new.status <> old.status) then
    raise exception 'jg:request_closed' using errcode = '42501';
  end if;
  if new.due_at <> old.due_at and (old.extended or not new.extended) then
    raise exception 'jg:due_locked' using errcode = '42501';
  end if;
  if old.extended and not new.extended then raise exception 'jg:protected_field' using errcode = '42501'; end if;
  new.version := old.version + 1;
  new.updated_at := now();
  if actor is not null then new.updated_by := actor; end if;
  if new.status in ('completed','rejected') and old.status not in ('completed','rejected') then
    new.closed_at := now();
    new.closed_by := coalesce(actor, new.closed_by, new.updated_by);
  end if;
  return new;
end $$;
create trigger privacy_requests_guard before insert or update on privacy_requests for each row execute function privacy_requests_guard();

alter table privacy_requests enable row level security;
alter table privacy_requests force row level security;
create policy privacy_access on privacy_requests for all to jg_app using (app_has_permission('crm.privacy.manage')) with check (app_has_permission('crm.privacy.manage'));
grant select, insert, update on privacy_requests to jg_app;

-- ------------------------------------------------------------------ Tiltólista (egyirányú lenyomatok)
create table privacy_suppressions (
  hash text primary key check (hash ~ '^[0-9a-f]{64}$'),
  kind text not null check (kind in ('email','phone')),
  reason text not null check (reason in ('erasure','objection')),
  request_id text references privacy_requests(id),
  created_at timestamptz not null default now(),
  created_by text references users(id)
);
alter table privacy_suppressions enable row level security;
alter table privacy_suppressions force row level security;
create policy suppression_read on privacy_suppressions for select to jg_app using (app_user_ok());
grant select on privacy_suppressions to jg_app;

create or replace function privacy_add_suppressions(p_hashes jsonb, p_reason text, p_request text, p_actor text) returns integer
language plpgsql security definer set search_path = public, pg_temp as $$
declare h jsonb; n int := 0; k int;
begin
  if p_hashes is null or jsonb_typeof(p_hashes) <> 'array' then return 0; end if;
  for h in select * from jsonb_array_elements(p_hashes) loop
    if (h->>'kind') not in ('email','phone') or coalesce(h->>'hash', '') !~ '^[0-9a-f]{64}$' then
      raise exception 'jg:invalid_hash' using errcode = '22023';
    end if;
    insert into privacy_suppressions (hash, kind, reason, request_id, created_by) values (h->>'hash', h->>'kind', p_reason, p_request, p_actor)
      on conflict (hash) do nothing;
    get diagnostics k = row_count;
    n := n + k;
  end loop;
  return n;
end $$;
revoke all on function privacy_add_suppressions(jsonb, text, text, text) from public;

-- ------------------------------------------------------------------ Anonimizálás jelölése és védelme
alter table customers add column erased_at timestamptz;
alter table customers add column erased_by text references users(id);
alter table customers add constraint customers_erased_chk check ((erased_at is null) = (erased_by is null) and (erased_at is null or deleted_at is not null));

-- Az alkalmazás szerepköre (jg_app) az anonimizált ügyfelet nem módosíthatja és nem állíthatja vissza, és az anonimizálás jelölését
-- sem állíthatja be közvetlenül: az csak az app_privacy_erase_customer() függvényen át (a tulajdonos jogával) történhet.
create or replace function customers_erasure_guard() returns trigger
language plpgsql set search_path = public, pg_temp as $$
begin
  if current_user <> 'jg_app' then return new; end if;
  if tg_op = 'INSERT' then
    if new.erased_at is not null or new.erased_by is not null then raise exception 'jg:forbidden_erase' using errcode = '42501'; end if;
    return new;
  end if;
  if old.erased_at is not null then raise exception 'jg:erased' using errcode = '42501'; end if;
  if new.erased_at is not null or new.erased_by is not null then raise exception 'jg:forbidden_erase' using errcode = '42501'; end if;
  return new;
end $$;
create trigger customers_erasure_guard before insert or update on customers for each row execute function customers_erasure_guard();

-- A 0010 eltávolítás-őr: az anonimizálás (amely a tulajdonosi függvényben, kizárólag crm.privacy.erase joggal fut) az ügyfelet az
-- aktív CRM-ből is eltávolítja - ehhez nem kell külön ügyféltörlési jog. Minden más eset változatlan.
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
  if current_user <> 'jg_app' and new.erased_at is not null and old.erased_at is null then return new; end if;
  if (new.deleted_at is distinct from old.deleted_at or new.deleted_by is distinct from old.deleted_by)
     and not app_has_permission('crm.customer.delete') then
    raise exception 'jg:forbidden_customer_delete' using errcode = '42501';
  end if;
  return new;
end $$;

-- ------------------------------------------------------------------ Tiltakozás / korlátozás rögzítése
-- Eredmény: 'recorded'. Hibák: jg:forbidden, jg:not_found, jg:restriction_exists, jg:invalid, jg:request_mismatch.
create or replace function app_privacy_record_restriction(p_customer text, p_kind text, p_note text, p_request text, p_activity_id text, p_hashes jsonb) returns text
language plpgsql security definer set search_path = public, pg_temp as $$
declare caller text := app_current_user_id(); c customers; r privacy_requests;
begin
  if caller is null or not app_has_permission('crm.privacy.manage') then raise exception 'jg:forbidden' using errcode = '42501'; end if;
  if p_kind not in ('objection','restriction') or p_note is null or length(btrim(p_note)) not between 1 and 500 or p_activity_id !~ '^act-[0-9a-f]{16}$' then
    raise exception 'jg:invalid' using errcode = '22023';
  end if;
  select * into c from customers where id = p_customer for update;
  if not found or c.deleted_at is not null then raise exception 'jg:not_found' using errcode = '22023'; end if;
  if exists (select 1 from customer_restrictions where customer_id = p_customer) then raise exception 'jg:restriction_exists' using errcode = '23505'; end if;
  if p_request is not null then
    select * into r from privacy_requests where id = p_request for update;
    if not found or r.customer_id is distinct from p_customer or r.kind <> p_kind or r.status not in ('open','in_progress') then
      raise exception 'jg:request_mismatch' using errcode = '22023';
    end if;
  end if;
  insert into customer_restrictions (customer_id, kind, note, recorded_at, recorded_by) values (p_customer, p_kind, btrim(p_note), now(), caller);
  insert into activities (id, customer_id, type, occurred_at, summary, recorded_by, meta)
    values (p_activity_id, p_customer, 'restriction_change', now(),
      case when p_kind = 'objection' then 'Tiltakozás rögzítve (adatvédelmi kérelem)' else 'Megkeresési korlátozás rögzítve (adatvédelmi kérelem)' end,
      caller, jsonb_build_object('restrictionKind', p_kind));
  if p_kind = 'objection' then perform privacy_add_suppressions(p_hashes, 'objection', p_request, caller); end if;
  return 'recorded';
end $$;
revoke all on function app_privacy_record_restriction(text, text, text, text, text, jsonb) from public;
grant execute on function app_privacy_record_restriction(text, text, text, text, text, jsonb) to jg_app;

-- ------------------------------------------------------------------ Végleges anonimizálás (GDPR 17. cikk)
-- Belső mag (nem hívható az alkalmazás szerepköréből): minden szabad szöveges és elérhetőségi adat helyére rögzített helyőrző kerül;
-- a rekordok szerkezete, az azonosítók, az időpontok és a személyes adatot nem tartalmazó naplók megmaradnak (elszámoltathatóság).
-- Az üzemeltetői CLI (privacy:reapply - visszaállított régebbi mentés után) és az alábbi alkalmazásfüggvény is ezt futtatja.
create or replace function privacy_anonymize_customer(p_customer text, p_actor text) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare c customers; ph constant text := '[Törölt tartalom]';
  n_contacts int; n_acts int; n_tasks int; n_results int; n_proc int; n_req int;
begin
  select * into c from customers where id = p_customer for update;
  if not found then raise exception 'jg:not_found' using errcode = '22023'; end if;
  if c.erased_at is not null then raise exception 'jg:already_erased' using errcode = '22023'; end if;
  if not exists (select 1 from users where id = p_actor) then raise exception 'jg:no_user' using errcode = '22023'; end if;
  update customers set
    first_name = case when type = 'individual' then 'Törölt' end,
    last_name = case when type = 'individual' then 'ügyfél' end,
    display_name = case when type = 'individual' then 'Törölt ügyfél' end,
    company_name = case when type = 'company' then 'Törölt ügyfél' end,
    notes = null, email = null, phone = null, source = '', acquisition_detail = null,
    deleted_at = coalesce(deleted_at, now()), deleted_by = coalesce(deleted_by, p_actor),
    erased_at = now(), erased_by = p_actor, updated_at = now()
  where id = p_customer;
  update company_contacts set first_name = 'Törölt', last_name = 'kapcsolattartó', position = null, email = null, phone = null, updated_at = now()
    where company_id = p_customer;
  get diagnostics n_contacts = row_count;
  update customer_restrictions set note = ph where customer_id = p_customer;
  update activities set summary = ph, meta = null, call_outcome = null where customer_id = p_customer;
  get diagnostics n_acts = row_count;
  update tasks set title = ph, description = null, input_note = null where customer_id = p_customer;
  get diagnostics n_tasks = row_count;
  update task_results set output_text = ph where task_id in (select id from tasks where customer_id = p_customer);
  get diagnostics n_results = row_count;
  update processes set title = ph, closure_reason_note = null, source = '' where customer_id = p_customer;
  get diagnostics n_proc = row_count;
  -- Az idempotencia-napló tárolt válaszai az ügyfél adatait tartalmazhatják: a válasz személyes adat nélküli jelölésre cserélődik.
  update request_log set response = '{"ok":false,"erased":true}'::jsonb where position(('"' || p_customer || '"') in response::text) > 0;
  get diagnostics n_req = row_count;
  -- Az érintetti nyilvántartásban csak az ügyfél-azonosító marad (a szabad szöveges érintett-megnevezés törlődik).
  update privacy_requests set subject_label = null where customer_id = p_customer and subject_label is not null;
  return jsonb_build_object('contacts', n_contacts, 'activities', n_acts, 'tasks', n_tasks, 'taskResults', n_results, 'processes', n_proc, 'requestLog', n_req);
end $$;
revoke all on function privacy_anonymize_customer(text, text) from public;

-- Alkalmazásfüggvény. Feltételek: crm.privacy.erase jog; a megadott kérelem nyitott, törlési típusú, ehhez az ügyfélhez tartozik, és az
-- érintett személyazonossága ellenőrzött; az ügyfél még nem anonimizált; NÉGY-SZEM ELV: a kérelmet rögzítő felhasználó nem hajthatja
-- végre a törlést (a rögzítőt a privacy_requests_guard a munkamenetből állítja be, a kliens nem adhatja meg). Tiltólistára veszi az
-- elérhetőségek lenyomatát és lezárja a kérelmet.
-- Hibák: jg:forbidden, jg:not_found, jg:already_erased, jg:request_mismatch, jg:identity_unverified, jg:four_eyes.
create or replace function app_privacy_erase_customer(p_customer text, p_request text, p_hashes jsonb) returns jsonb
language plpgsql security definer set search_path = public, pg_temp as $$
declare caller text := app_current_user_id(); r privacy_requests; res jsonb; n_supp int;
begin
  if caller is null or not app_has_permission('crm.privacy.erase') then raise exception 'jg:forbidden' using errcode = '42501'; end if;
  select * into r from privacy_requests where id = p_request for update;
  if not found or r.kind <> 'erasure' or r.customer_id is distinct from p_customer or r.status not in ('open','in_progress') then
    raise exception 'jg:request_mismatch' using errcode = '22023';
  end if;
  if not r.identity_verified then raise exception 'jg:identity_unverified' using errcode = '22023'; end if;
  if r.created_by = caller then raise exception 'jg:four_eyes' using errcode = '42501'; end if;
  res := privacy_anonymize_customer(p_customer, caller);
  n_supp := privacy_add_suppressions(p_hashes, 'erasure', p_request, caller);
  res := res || jsonb_build_object('suppressions', n_supp);
  update privacy_requests set status = 'completed', updated_by = caller where id = p_request;
  insert into audit_events (user_id, action, entity_type, entity_id, customer_id, detail)
    values (caller, 'privacy.erase', 'customer', p_customer, p_customer, res || jsonb_build_object('requestId', p_request));
  return res;
end $$;
revoke all on function app_privacy_erase_customer(text, text, jsonb) from public;
grant execute on function app_privacy_erase_customer(text, text, jsonb) to jg_app;

-- Az ügyfél import-eredete (adatforrás, cél, ellenőrzési státusz) a hozzáférési kivonathoz - csak crm.privacy.manage joggal.
create or replace function app_privacy_import_origin(p_customer text)
returns table (import_id text, source_name text, purpose text, source_verification text, committed_at timestamptz)
language plpgsql stable security definer set search_path = public, pg_temp as $$
begin
  if not app_has_permission('crm.privacy.manage') then raise exception 'jg:forbidden' using errcode = '42501'; end if;
  return query select j.id, j.source_name, j.purpose, j.source_verification, j.committed_at
    from import_results ir join import_jobs j on j.id = ir.job_id where ir.customer_id = p_customer order by j.committed_at;
end $$;
revoke all on function app_privacy_import_origin(text) from public;
grant execute on function app_privacy_import_origin(text) to jg_app;
`;

export const migration0012: Migration = { id: "0012_crm_privacy", description: "Adatvédelem: érintetti kérelmek, tiltakozás rögzítése, tiltólista, végleges anonimizálás, crm.privacy.* jogok", sql };
