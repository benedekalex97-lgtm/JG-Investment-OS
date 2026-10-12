import type { Migration } from "../migrate";

/**
 * 0001 - kezdeti séma (v0.6). Kizárólag új objektumokat hoz létre (additív), meglévő adatot nem érint.
 *
 * Adatmodell: ügyfél -> feladatok -> feladat-eredmények (Output), plusz audit, hitelesítés és a megőrzött régi adatok táblái
 * (folyamatok, megkereshetőség, tiltakozás/korlátozás, aktivitásnapló). Referenciális integritás idegen kulccsal, törlési
 * lehetőség NINCS az alkalmazás szerepkörének (jg_app): csak SELECT/INSERT/UPDATE, a naplózó táblákra csak SELECT/INSERT.
 * Az Input/Output opciók kulcsait az adatbázis nem köti CHECK-kel (a központi konfiguráció bővíthető migráció nélkül);
 * a hét kapcsolati státusz és a feladat-állapot jóváhagyott, zárt halmaz, ezért CHECK védi.
 *
 * Jogosultság: minden CRM-tábla RLS-sel védett (FORCE), a jg_app csak akkor lát/ír, ha a tranzakcióban az `app.user_id`
 * egy AKTÍV felhasználó azonosítója. A users/sessions/login_attempts/meta táblákhoz a jg_app-nak nincs hozzáférése.
 */
const sql = `
create table meta (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);

create table users (
  id text primary key,
  email text not null unique check (email = lower(email) and position('@' in email) > 1),
  name text not null check (length(trim(name)) > 0),
  password_hash text not null,
  role text not null default 'admin' check (role in ('admin')),
  active boolean not null default true,
  created_at timestamptz not null default now(),
  last_login_at timestamptz
);

create table sessions (
  token_hash text primary key,
  user_id text not null references users(id),
  created_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index sessions_user_idx on sessions(user_id);

create table login_attempts (
  id bigserial primary key,
  key text not null,
  at timestamptz not null default now(),
  success boolean not null
);
create index login_attempts_key_idx on login_attempts(key, at);

create table customers (
  id text primary key,
  type text not null check (type in ('individual','company')),
  first_name text,
  last_name text,
  display_name text,
  company_name text,
  notes text,
  contact_status text not null default 'prospect' check (contact_status in ('prospect','existing_verified','former_verified','archived')),
  crm_status text check (crm_status in ('waiting_for_contact','contact','relationship','meeting','account_opening','capital_placed','lost')),
  owner_id text not null references users(id),
  source text not null default '',
  verification_status text not null default 'demo' check (verification_status in ('unverified','demo')),
  email text,
  phone text,
  created_at timestamptz not null,
  updated_at timestamptz not null,
  constraint customers_name_chk check (
    (type = 'individual' and coalesce(trim(display_name), '') <> '') or (type = 'company' and coalesce(trim(company_name), '') <> '')
  )
);
create index customers_crm_status_idx on customers(crm_status);
create index customers_created_idx on customers(created_at desc);

-- Tiltakozás / megkeresési korlátozás: külön, az alkalmazás által csak olvasható tábla (az adat megmarad és nem törölhető/írható át a CRM felületről).
create table customer_restrictions (
  customer_id text primary key references customers(id),
  kind text not null check (kind in ('objection','restriction')),
  note text not null,
  recorded_at timestamptz not null,
  recorded_by text not null references users(id)
);

create table company_contacts (
  id text primary key,
  company_id text not null references customers(id),
  first_name text not null,
  last_name text not null,
  position text,
  email text,
  phone text,
  is_primary boolean not null default false,
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index company_contacts_company_idx on company_contacts(company_id);
create unique index company_contacts_one_primary_idx on company_contacts(company_id) where is_primary;

-- Régi (v0.2-v0.3) folyamatok: megőrzött adat, a felület nem kezeli.
create table processes (
  id text primary key,
  customer_id text not null references customers(id),
  company_contact_id text references company_contacts(id),
  type text not null,
  title text not null,
  status text not null,
  closure_state text not null,
  closure_reason text,
  closure_reason_note text,
  closed_at timestamptz,
  closed_by text,
  channel text not null,
  source text not null,
  owner_id text not null references users(id),
  created_at timestamptz not null,
  updated_at timestamptz not null
);
create index processes_customer_idx on processes(customer_id);

create table activities (
  id text primary key,
  customer_id text not null references customers(id),
  process_id text references processes(id),
  company_contact_id text references company_contacts(id),
  type text not null,
  occurred_at timestamptz not null,
  summary text not null,
  recorded_by text not null references users(id),
  call_outcome text,
  meta jsonb
);
create index activities_customer_idx on activities(customer_id, occurred_at desc);

create table tasks (
  id text primary key,
  customer_id text not null references customers(id),
  process_id text references processes(id),
  company_contact_id text references company_contacts(id),
  title text not null check (length(trim(title)) > 0),
  task_type text,
  description text,
  input_key text,
  input_note text,
  assignee_id text not null references users(id),
  due_at timestamptz,
  status text not null check (status in ('open','in_progress','done')),
  crm_status text check (crm_status in ('waiting_for_contact','contact','relationship','meeting','account_opening','capital_placed','lost')),
  created_at timestamptz not null,
  completed_at timestamptz
);
create index tasks_customer_idx on tasks(customer_id);
create index tasks_open_due_idx on tasks(due_at) where status <> 'done';

-- Feladat-lezárások (Output) időrendben; hozzáfűző: újranyitás után az előzmény megmarad.
create table task_results (
  task_id text not null references tasks(id),
  seq integer not null check (seq >= 0),
  output_key text,
  output_text text not null default '',
  closed_at timestamptz not null,
  closed_by text not null references users(id),
  primary key (task_id, seq)
);

create table contactability (
  id text primary key,
  customer_id text references customers(id),
  company_contact_id text references company_contacts(id),
  purpose text not null,
  channel text not null,
  status text not null,
  evidence_status text not null,
  verified_at timestamptz,
  constraint contactability_one_target_chk check ((customer_id is null) <> (company_contact_id is null))
);

-- Auditnapló: ki, mikor, mit módosított (hozzáfűző). A részletek nem tartalmaznak személyes adat értéket (csak mezőneveket/azonosítókat).
create table audit_events (
  id bigserial primary key,
  at timestamptz not null default now(),
  user_id text not null references users(id),
  action text not null,
  entity_type text not null,
  entity_id text,
  customer_id text references customers(id),
  detail jsonb
);
create index audit_events_customer_idx on audit_events(customer_id, at desc);

-- Idempotencia: ugyanaz a kérés-azonosító ugyanazt az eredményt adja, nem hoz létre duplikátumot.
create table request_log (
  request_id text primary key,
  user_id text not null references users(id),
  op text not null,
  response jsonb not null,
  created_at timestamptz not null default now()
);

-- Alkalmazás-szerepkör: nem tulajdonos, nem szuperfelhasználó, nincs BYPASSRLS.
do $$
begin
  if not exists (select 1 from pg_roles where rolname = 'jg_app') then
    create role jg_app nologin noinherit nosuperuser nocreatedb nocreaterole nobypassrls;
  end if;
end $$;
grant jg_app to current_user;
grant usage on schema public to jg_app;

create or replace function app_user_ok() returns boolean
language sql stable security definer set search_path = public, pg_temp as $$
  select exists (select 1 from users u where u.id = nullif(current_setting('app.user_id', true), '') and u.active)
$$;
revoke all on function app_user_ok() from public;
grant execute on function app_user_ok() to jg_app;

grant select, insert, update on customers, company_contacts, processes, tasks, contactability to jg_app;
grant select on customer_restrictions to jg_app;
grant select, insert on activities, task_results, audit_events, request_log to jg_app;
grant usage, select on sequence audit_events_id_seq to jg_app;

do $$
declare t text;
begin
  foreach t in array array['customers','customer_restrictions','company_contacts','processes','activities','tasks','task_results','contactability','audit_events','request_log']
  loop
    execute format('alter table %I enable row level security', t);
    execute format('alter table %I force row level security', t);
    execute format('create policy app_access on %I for all to jg_app using (app_user_ok()) with check (app_user_ok())', t);
  end loop;
end $$;

-- A hitelesítési és rendszer-táblák RLS-sel is védettek, és a jg_app-nak nincs rájuk jogosultsága.
alter table users enable row level security;
alter table sessions enable row level security;
alter table login_attempts enable row level security;
alter table meta enable row level security;
`;

export const migration0001: Migration = { id: "0001_init", description: "Kezdeti séma: ügyfél, feladat, eredmény, audit, hitelesítés, RLS", sql };
